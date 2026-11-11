export interface TaskLinkExpectation {
  owner: readonly number[];
  notePath: string;
  field?: 'description' | 'markdownTitle' | 'comment';
  originalTitle?: string;
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
function nodeAt(trees: readonly unknown[], owner: readonly number[]): Record<string, unknown> {
  let nodes = trees,
    node: Record<string, unknown> = {};
  for (const index of owner) {
    node = record(nodes[index]);
    nodes = Array.isArray(node['children']) ? node['children'] : [];
  }
  return node;
}
function ownText(node: Record<string, unknown>, field?: TaskLinkExpectation['field']): string[] {
  const comments = Array.isArray(node['comments'])
    ? node['comments']
        .map((comment) => record(comment)['text'])
        .filter((text): text is string => typeof text === 'string')
    : [];
  if (field === 'comment') return comments;
  if (field !== undefined) return typeof node[field] === 'string' ? [node[field]] : [];
  return [node['description'], node['markdownTitle']]
    .filter((text): text is string => typeof text === 'string')
    .concat(comments);
}
function wikiLinks(text: string) {
  const links: Array<{ raw: string; path: string }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('[[', cursor);
    if (open < 0) break;
    const close = text.indexOf(']]', open + 2);
    if (close < 0) break;
    const inner = text.slice(open + 2, close),
      path = inner.split('|', 1)[0] ?? '';
    if (path !== '' && !['[', ']', '#'].some((char) => path.includes(char)))
      links.push({
        raw: text.slice(open, close + 2),
        path: path.endsWith('.md') ? path : `${path}.md`,
      });
    cursor = close + 2;
  }
  return links;
}
function allNodes(trees: readonly unknown[]): Array<Record<string, unknown>> {
  return trees.flatMap((raw) => {
    const node = record(raw);
    return [node, ...allNodes(Array.isArray(node['children']) ? node['children'] : [])];
  });
}
export function taskLinkFailures(
  expected: readonly TaskLinkExpectation[],
  trees: readonly unknown[],
): string[] {
  return expected.flatMap((want) => {
    const owner = nodeAt(trees, want.owner);
    const links = ownText(owner, want.field)
      .flatMap(wikiLinks)
      .filter((link) => link.path === want.notePath);
    const all = allNodes(trees)
      .flatMap((node) => ownText(node).flatMap(wikiLinks))
      .filter((link) => link.path === want.notePath);
    const failures =
      links.length === 1 && all.length === 1
        ? []
        : [`task-link:${want.owner.join('.')}:${want.notePath}`];
    if (want.originalTitle !== undefined) {
      const title = typeof owner['markdownTitle'] === 'string' ? owner['markdownTitle'] : '';
      const stripped = wikiLinks(title)
        .filter((link) => link.path === want.notePath)
        .reduce((text, link) => text.replace(link.raw, ''), title)
        .trim();
      if (stripped !== want.originalTitle) failures.push('task-link-owner-title');
    }
    return failures;
  });
}
/** Remove only the newly authorized link; remaining authored content must compare equal. */
export function normalizeLinkCarrier(value: unknown, notePath?: string): unknown {
  if (typeof value === 'string') {
    const stripped = wikiLinks(value)
      .filter((link) => link.path === notePath)
      .reduce((text, link) => text.replace(link.raw, ''), value)
      .trim();
    return stripped === '' ? undefined : stripped;
  }
  if (!Array.isArray(value)) return value;
  return value.flatMap((raw) => {
    const comment = record(raw),
      text = comment['text'];
    const normalized = normalizeLinkCarrier(text, notePath);
    const insertedOnly =
      typeof text === 'string' &&
      normalized === undefined &&
      wikiLinks(text).some((link) => link.path === notePath);
    return insertedOnly ? [] : [{ ...comment, text: normalized }];
  });
}
