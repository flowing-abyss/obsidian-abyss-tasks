import { TaskSearchError } from './taskSearchTypes';

export interface SearchWord {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}
export type SearchWordSegmenter = (text: string) => readonly SearchWord[];
export interface SearchToken {
  readonly term: string;
  readonly edits: 0 | 1 | 2;
  readonly prefix: boolean;
  readonly swaps: readonly string[];
}
export interface PreparedSearchQuery {
  readonly original: string;
  readonly tokens: readonly SearchToken[];
}
export interface SearchTextMatch {
  readonly start: number;
  readonly end: number;
  readonly queryToken: number;
  readonly exact: boolean;
}
export function normalizeSearchWord(text: string): string {
  return text.normalize('NFC').toLowerCase();
}

/** No dictionary is assumed without a supplied segmenter: CJK syllables/ideographs stand alone. */
function fallbackRun(text: string, offset: number): SearchWord[] {
  const words: SearchWord[] = [];
  let start = 0;
  for (const cluster of text.matchAll(/[\p{L}\p{N}]\p{M}*/gu)) {
    if (
      !/^[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff\u{20000}-\u{323af}]/u.test(
        cluster[0],
      )
    )
      continue;
    const cursor = cluster.index;
    if (cursor > start)
      words.push({ text: text.slice(start, cursor), start: offset + start, end: offset + cursor });
    start = cursor + cluster[0].length;
    words.push({ text: cluster[0], start: offset + cursor, end: offset + start });
  }
  if (text.length > start)
    words.push({ text: text.slice(start), start: offset + start, end: offset + text.length });
  return words;
}
export function fallbackSearchWords(text: string): readonly SearchWord[] {
  return [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)].flatMap((match) =>
    fallbackRun(match[0], match.index),
  );
}
function validateQuery(text: string): void {
  if (text.length > 4096) throw new TaskSearchError('invalid-query', 'Search query too long');
  let length = 0;
  for (let at = 0; at < text.length; at += (text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1) {
    if (++length > 2048) throw new TaskSearchError('invalid-query', 'Search query too long');
  }
}
function shortSwaps(points: readonly string[]): readonly string[] {
  if (points.length < 3 || points.length > 4) return [];
  const swaps = new Set<string>();
  for (let i = 0; i < points.length - 1; i++) {
    if (points[i] === points[i + 1]) continue;
    const copy = [...points];
    const a = copy[i],
      b = copy[i + 1];
    if (a === undefined || b === undefined) continue;
    copy[i] = b;
    copy[i + 1] = a;
    swaps.add(copy.join(''));
  }
  return [...swaps];
}
function editBudget(length: number): 0 | 1 | 2 {
  if (length > 64 || length < 3) return 0;
  return length < 5 ? 1 : 2;
}
export function prepareSearchQuery(
  text: string,
  segment: SearchWordSegmenter,
): PreparedSearchQuery {
  validateQuery(text);
  const words = segment(text)
    .map((word) => normalizeSearchWord(word.text))
    .filter(Boolean);
  const terms = [...new Set(words)];
  if (terms.length > 32) throw new TaskSearchError('invalid-query', 'Too many search terms');
  return {
    original: text,
    tokens: terms.map((term) => {
      const points = [...term];
      const length = points.length;
      return {
        term,
        edits: editBudget(length),
        prefix: term === words[words.length - 1] && length >= 2 && length <= 64,
        swaps: shortSwaps(points),
      };
    }),
  };
}
/** Bounded code-point Levenshtein, shared by candidate matching and retrieval evidence. */
function withinDistance(left: string, right: string, limit: number): boolean {
  // Every accepted candidate has at most 66 points; don't allocate an arbitrary document word.
  if (right.length > (left.length + limit) * 2) return false;
  const a = [...left],
    b = [...right];
  if (Math.abs(a.length - b.length) > limit) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = new Array<number>(b.length + 1).fill(limit + 1);
    row[0] = i;
    let minimum = i;
    for (let j = Math.max(1, i - limit); j <= Math.min(b.length, i + limit); j++) {
      row[j] = Math.min(
        (previous[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (previous[j - 1] as number) + Number(a[i - 1] !== b[j - 1]),
      );
      minimum = Math.min(minimum, row[j] as number);
    }
    if (minimum > limit) return false;
    previous = row;
  }
  return (previous[b.length] as number) <= limit;
}
export function matchesSearchTerm(word: string, token: SearchToken): boolean {
  return (
    word === token.term ||
    (token.prefix && word.startsWith(token.term)) ||
    token.swaps.includes(word) ||
    (token.edits > 0 && withinDistance(token.term, word, token.edits))
  );
}
export function matchSearchText(
  text: string,
  query: PreparedSearchQuery,
  segment: SearchWordSegmenter,
): readonly SearchTextMatch[] {
  const matches: SearchTextMatch[] = [];
  for (const word of segment(text)) {
    const normalized = normalizeSearchWord(word.text);
    for (const [queryToken, token] of query.tokens.entries()) {
      if (matchesSearchTerm(normalized, token))
        matches.push({
          start: word.start,
          end: word.end,
          queryToken,
          exact: normalized === token.term,
        });
    }
  }
  return matches;
}
export function matchesSearchText(
  text: string,
  query: PreparedSearchQuery,
  segment: SearchWordSegmenter,
): boolean {
  if (query.tokens.length === 0) return query.original.trim() === '';
  return (
    new Set(matchSearchText(text, query, segment).map((match) => match.queryToken)).size ===
    query.tokens.length
  );
}
