import { inlineCodeRanges } from '../../src/markdown/inlineCode';
import { parseLinks, parseSourceReferences } from '../../src/markdown/links';
/** Compare destinations, excluding Markdown labels, embeds and inline code from bare URLs. */
export function hasSourceDestination(text: string, source: string): boolean {
  const links = parseSourceReferences(text);
  if (
    parseLinks(text).some(
      (link) => link.type === 'md' && markdownDestination(link.target) === source,
    )
  )
    return true;
  const excluded = [
    ...inlineCodeRanges(text),
    ...links.map((link) => ({ from: link.index, to: link.index + link.raw.length })),
  ];
  const bare = text
    .split('')
    .map((char, index) =>
      excluded.some((range) => index >= range.from && index < range.to) ? ' ' : char,
    )
    .join('');
  for (const match of bare.matchAll(/https?:\/\/[^\s<>"'`]+/gu)) {
    if (match.index > 0 && !/[\s(:<]/u.test(bare.charAt(match.index - 1))) continue;
    let destination = match[0];
    while (
      /[.,;:!?]/u.test(destination.slice(-1)) ||
      (destination.endsWith(')') &&
        [...destination].filter((char) => char === ')').length >
          [...destination].filter((char) => char === '(').length)
    )
      destination = destination.slice(0, -1);
    if (destination === source) return true;
  }
  return false;
}
function markdownDestination(text: string): string | undefined {
  const match = /^(?:<([^>]+)>|(\S+))(?:\s+["'][^]*["'])?$/u.exec(text.trim());
  return match?.[1] ?? match?.[2];
}

/** Literal, fixture-authored facts only; this does not judge arbitrary prose entailment. */
export function hasSourceFacts(
  text: string,
  facts: ReadonlyArray<readonly string[]>,
  excludes: readonly string[],
): boolean {
  const normalized = normalizeFactPhrase(text.replace(/https?:\/\/[^\s<>]+/gu, ''));
  const contains = (term: string) => {
    const needle = normalizeFactPhrase(term);
    if (!/^\d+$/u.test(needle)) return normalized.includes(needle);
    let index = normalized.indexOf(needle);
    while (index >= 0) {
      if (
        !/\d/u.test(normalized.charAt(index - 1)) &&
        !/\d/u.test(normalized.charAt(index + needle.length))
      )
        return true;
      index = normalized.indexOf(needle, index + 1);
    }
    return false;
  };
  return facts.every((alternatives) => alternatives.some(contains)) && !excludes.some(contains);
}

function normalizeFactPhrase(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(\p{L})[-‐‑‒–—―](\p{L})/gu, '$1 $2');
}

type AbsenceFact = ReadonlyArray<readonly string[]>;

/** Require each fixture-authored capability to occur under a nearby RU/EN absence cue. */
export function hasSourceAbsenceFacts(text: string, facts: readonly AbsenceFact[]): boolean {
  const normalized = text
    .replace(/https?:\/\/[^\s<>]+/gu, '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/doesn['’]t/gu, 'does not')
    .replace(/isn['’]t/gu, 'is not');
  const pieces = normalized.split(
    /(,|[.!?;\n]+|\b(?:but|however|whereas|yet)\b|(?<![\p{L}\p{N}])(?:но|однако|зато|а)(?![\p{L}\p{N}]))/gu,
  );
  const clauses: Array<{ tokens: string[]; commaLinked: boolean }> = [];
  for (let index = 0; index < pieces.length; index += 2) {
    const clause = pieces[index] ?? '';
    const boundary = pieces[index - 1];
    clauses.push({
      tokens: [...clause.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => match[0]),
      commaLinked: boundary === ',',
    });
  }
  return facts.every((aliases, factIndex) => {
    const verdicts = clauses.map(({ tokens }) => capabilityVerdict(tokens, aliases));
    const inherited = clauses.some(({ tokens, commaLinked }, index) => {
      if (
        !commaLinked ||
        clauses[index + 1]?.commaLinked === true ||
        !['тоже', 'также'].includes(tokens[tokens.length - 1] ?? '') ||
        !aliases.some((alias) => {
          const ellipticalTokens = tokens.slice(0, -1);
          return (
            ellipticalTokens.length === alias.length &&
            capabilityMentions(ellipticalTokens, alias).some(
              ({ start, end }) => start === 0 && end === ellipticalTokens.length - 1,
            )
          );
        }) ||
        verdicts[index]?.present === true
      )
        return false;
      const precedingClause = clauses[index - 1];
      if (precedingClause === undefined) return false;
      return facts.some((_otherAliases, otherIndex) => {
        if (otherIndex === factIndex) return false;
        const precedingVerdict = capabilityVerdict(precedingClause.tokens, facts[otherIndex] ?? []);
        return precedingVerdict.absent && !precedingVerdict.present;
      });
    });
    return (
      (verdicts.some((verdict) => verdict.absent) || inherited) &&
      !verdicts.some((verdict) => verdict.present)
    );
  });
}

const absenceCues = new Set([
  'no',
  'without',
  'unavailable',
  'unsupported',
  'absent',
  'нет',
  'без',
]);
const absenceStems = ['отсутств', 'недоступ', 'неподдерж'];
const presenceCues = new Set([
  'available',
  'supported',
  'support',
  'supports',
  'provided',
  'provides',
  'included',
  'includes',
  'enabled',
  'has',
  'have',
  'exists',
  'present',
  'yes',
  'есть',
]);
const presenceStems = ['доступ', 'поддерж', 'имеет', 'налич'];
function capabilityVerdict(
  tokens: readonly string[],
  aliases: AbsenceFact,
): { absent: boolean; present: boolean } {
  const matches = aliases.flatMap((alias) => capabilityMentions(tokens, alias));
  let absent = false;
  let present = false;
  for (const { start, end } of matches) {
    const distance = (index: number) => {
      if (index < start) return start - index;
      if (index > end) return index - end;
      return 0;
    };
    const nearby = (index: number) => distance(index) <= 6;
    const negative = tokens.flatMap((_token, index) =>
      nearby(index) && isAbsenceCueAt(tokens, index, start, end) ? [index] : [],
    );
    const positive = tokens.flatMap((token, index) => {
      if (!nearby(index)) return [];
      const negated = negatedCue(tokens, index);
      return (isPresenceCue(token) && !negated) || (isAbsenceCue(token) && negated) ? [index] : [];
    });
    if (hasCoordinatedOppositeCues(tokens, negative, positive)) {
      absent = true;
      present = true;
      continue;
    }
    if (negative.length === 0) {
      if (positive.length > 0) present = true;
      continue;
    }
    const nearestNegative = Math.min(...negative.map(distance));
    const nearestPositive = positive.length > 0 ? Math.min(...positive.map(distance)) : Infinity;
    if (nearestNegative < nearestPositive) absent = true;
    else if (nearestPositive < nearestNegative) present = true;
  }
  return { absent, present };
}
function hasCoordinatedOppositeCues(
  tokens: readonly string[],
  negative: readonly number[],
  positive: readonly number[],
): boolean {
  const conjunctions = new Set(['and', 'и']);
  const links = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'being']);
  return negative.some((negativeIndex) =>
    positive.some((positiveIndex) => {
      const start = Math.min(negativeIndex, positiveIndex);
      const end = Math.max(negativeIndex, positiveIndex);
      const between = tokens.slice(start + 1, end);
      return (
        between.some((token) => conjunctions.has(token)) &&
        between.every(
          (token) =>
            conjunctions.has(token) ||
            links.has(token) ||
            token === 'not' ||
            token === 'не' ||
            isAbsenceCue(token) ||
            isPresenceCue(token),
        )
      );
    }),
  );
}
function capabilityMentions(
  tokens: readonly string[],
  alias: readonly string[],
): Array<{ start: number; end: number }> {
  if (alias.length === 0) return [];
  const positions = alias.map((term) =>
    tokens.flatMap((token, index) => (token.startsWith(term) ? [index] : [])),
  );
  if (positions.some((matches) => matches.length === 0)) return [];
  const spans = new Map<string, { start: number; end: number }>();
  const select = (termIndex: number, selected: number[]) => {
    if (termIndex === positions.length) {
      const start = Math.min(...selected);
      const end = Math.max(...selected);
      if (end - start <= 8) spans.set(`${start}:${end}`, { start, end });
      return;
    }
    for (const index of positions[termIndex] ?? []) {
      if (selected.includes(index)) continue;
      const next = [...selected, index];
      if (Math.max(...next) - Math.min(...next) <= 8) select(termIndex + 1, next);
    }
  };
  select(0, []);
  const candidates = [...spans.values()];
  return candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) =>
          candidate.start <= other.start &&
          candidate.end >= other.end &&
          (candidate.start < other.start || candidate.end > other.end),
      ),
  );
}
function isAbsenceCue(token: string): boolean {
  return (
    absenceCues.has(token) ||
    token.startsWith('unavailable') ||
    token.startsWith('unsupported') ||
    token.startsWith('absent') ||
    absenceStems.some((stem) => token.startsWith(stem))
  );
}
function isPresenceCue(token: string): boolean {
  return (
    presenceCues.has(token) ||
    token.startsWith('provide') ||
    token.startsWith('include') ||
    presenceStems.some((stem) => token.startsWith(stem))
  );
}
function isAbsenceCueAt(
  tokens: readonly string[],
  index: number,
  capabilityStart: number,
  capabilityEnd: number,
): boolean {
  const token = tokens[index] ?? '';
  if (isAbsenceCue(token)) {
    const doubleNegated = tokens
      .slice(Math.max(0, index - 2), index)
      .some((item) => item === 'not' || item === 'не');
    const requirementContext = [
      'require',
      'requires',
      'required',
      'requirement',
      'need',
      'needs',
      'needed',
      'necessary',
      'necessity',
      'треб',
      'нужн',
      'необходим',
    ].some((stem) =>
      tokens.some(
        (item, position) =>
          item.startsWith(stem) &&
          (position < capabilityStart
            ? capabilityStart - position <= 3
            : position > capabilityEnd && position - capabilityEnd <= 3),
      ),
    );
    const negatesNeed = ['no', 'without', 'нет', 'без'].includes(token) && requirementContext;
    return !doubleNegated && !negatesNeed;
  }
  if (token === 'not')
    return ['support', 'provide', 'include', 'have'].some((stem) =>
      tokens.slice(index + 1, index + 3).some((next) => next.startsWith(stem)),
    );
  if (token === 'не')
    return ['поддерж', 'предусмотр', 'доступ'].some((stem) =>
      tokens.slice(index + 1, index + 3).some((next) => next.startsWith(stem)),
    );
  return false;
}
function negatedCue(tokens: readonly string[], index: number): boolean {
  return tokens
    .slice(Math.max(0, index - 2), index)
    .some((token) => token === 'not' || token === 'не');
}
