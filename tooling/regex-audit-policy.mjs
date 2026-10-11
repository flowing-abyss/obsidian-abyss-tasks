/** @typedef {{file: string, line: number, column: number, endLine: number, endColumn: number, ruleId: string, messageId: string, message: string, raw: string, unproven: boolean}} Finding */
/** @typedef {{regexp: string, redos: string, options: object}} Analyzer */
/** @typedef {{finding: Finding, sourceHash: string, guards: Record<string,string>, analyzer: Analyzer, disposition: string, reason: string, tests: {accepting: string[], rejecting: string[], performance: string[]}}} Review */
/** @typedef {{sourceHashes: Record<string,string>, guardHashes: Record<string,string>, analyzer: Analyzer}} Context */

/** Object key order must not affect identity. @param {unknown} value @returns {string} */
function identity(value) {
  if (Array.isArray(value)) return `[${value.map(identity).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return (
      '{' + entries.map(([key, item]) => `${JSON.stringify(key)}:${identity(item)}`).join(',') + '}'
    );
  }
  return JSON.stringify(value) ?? 'undefined';
}

/** @param {Review} review @param {Context} context @returns {string[]} */
function reviewErrors(review, context) {
  const label = `${review.finding.file}:${review.finding.line}:${review.finding.column}`;
  const errors = [];
  if (!review.sourceHash || context.sourceHashes[review.finding.file] !== review.sourceHash)
    errors.push(`${label}: source hash drift`);
  for (const [file, hash] of Object.entries(review.guards)) {
    if (!hash || context.guardHashes[file] !== hash)
      errors.push(`${label}: guard hash drift: ${file}`);
  }
  if (identity(review.analyzer) !== identity(context.analyzer))
    errors.push(`${label}: analyzer version/options drift`);
  if (!review.reason.trim()) errors.push(`${label}: review requires a reason`);
  for (const kind of ['accepting', 'rejecting', 'performance']) {
    const names = review.tests[/** @type {keyof Review['tests']} */ (kind)];
    if (!names.length || names.some((name) => !name.trim()))
      errors.push(`${label}: review requires named ${kind} public tests`);
  }
  const disposition = review.finding.unproven ? 'unproven' : 'context-protected';
  if (review.disposition !== disposition)
    errors.push(`${label}: finding must remain ${disposition}`);
  return errors;
}

/**
 * Each diagnostic needs exactly one current review; an inconclusive diagnostic is never safe.
 * @param {readonly Finding[]} findings @param {readonly Review[]} reviews @param {Context} context
 * @returns {{reviewed: number, unproven: number, errors: readonly string[]}}
 */
export function validateReviews(findings, reviews, context) {
  const errors = [];
  const findingKeys = findings.map(identity);
  const reviewKeys = reviews.map((review) => identity(review.finding));
  if (new Set(findingKeys).size !== findingKeys.length) errors.push('duplicate finding occurrence');
  if (new Set(reviewKeys).size !== reviewKeys.length) errors.push('duplicate review occurrence');
  let reviewed = 0;
  let unproven = 0;
  for (const finding of findings) {
    const matches = reviews.filter((review) => identity(review.finding) === identity(finding));
    if (matches.length !== 1) {
      errors.push(
        `${finding.file}:${finding.line}:${finding.column}: requires exactly one review (${matches.length} found): ${finding.message}`,
      );
      continue;
    }
    const review = matches[0];
    if (!review) continue;
    const problems = reviewErrors(review, context);
    errors.push(...problems);
    if (problems.length) continue;
    if (finding.unproven) unproven++;
    else reviewed++;
  }
  for (const [index, key] of reviewKeys.entries()) {
    if (!findingKeys.includes(key)) errors.push(`stale review: ${reviews[index]?.finding.file}`);
  }
  return { reviewed, unproven, errors };
}
