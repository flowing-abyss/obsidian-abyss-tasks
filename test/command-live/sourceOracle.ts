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
  const clauses = normalized
    .split(
      /[.!?;,\n]+|\b(?:but|however|whereas|yet)\b|(?:^|[^\p{L}\p{N}])(?:но|однако|зато|а)(?![\p{L}\p{N}])/gu,
    )
    .map((clause) => [...clause.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => match[0]));
  return facts.every((aliases) => clauses.some((tokens) => capabilityIsAbsent(tokens, aliases)));
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
function capabilityIsAbsent(tokens: readonly string[], aliases: AbsenceFact): boolean {
  const matches = aliases.flatMap((alias) => {
    if (alias.length === 0) return [];
    const positions = alias.map((term) => tokens.findIndex((token) => token.startsWith(term)));
    if (positions.some((position) => position < 0)) return [];
    const start = Math.min(...positions),
      end = Math.max(...positions);
    return end - start <= 8 ? [{ start, end }] : [];
  });
  return matches.some(({ start, end }) => {
    const distance = (index: number) => {
      if (index < start) return start - index;
      if (index > end) return index - end;
      return 0;
    };
    const nearby = (index: number) => distance(index) <= 6;
    const negative = tokens.flatMap((_token, index) =>
      nearby(index) && isAbsenceCueAt(tokens, index, start, end) ? [index] : [],
    );
    const positive = tokens.flatMap((token, index) =>
      nearby(index) && isPresenceCue(token) && !negatedCue(tokens, index) ? [index] : [],
    );
    if (negative.length === 0) return false;
    const nearestNegative = Math.min(...negative.map(distance));
    const nearestPositive = positive.length > 0 ? Math.min(...positive.map(distance)) : Infinity;
    return nearestNegative < nearestPositive;
  });
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
