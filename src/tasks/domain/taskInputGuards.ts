import type { TaskInputBinding } from './taskInputState';
import type { TaskInputRange } from './taskInputTypes';

export function inputRangesOverlap(a: TaskInputRange, b: TaskInputRange): boolean {
  return a.from < b.to && b.from < a.to;
}
export function validInputRange(text: string, range: TaskInputRange): boolean {
  const boundary = (index: number): boolean => {
    const before = text.charCodeAt(index - 1),
      after = text.charCodeAt(index);
    return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
  };
  return (
    Number.isInteger(range.from) &&
    Number.isInteger(range.to) &&
    range.from >= 0 &&
    range.to > range.from &&
    range.to <= text.length &&
    boundary(range.from) &&
    boundary(range.to)
  );
}
export function currentInputBinding(
  raw: string,
  revision: number,
  binding: Pick<TaskInputBinding, 'revision' | 'ranges' | 'slices'>,
): boolean {
  return (
    binding.revision === revision &&
    binding.ranges.length === binding.slices.length &&
    binding.ranges.every(
      (range, index) =>
        validInputRange(raw, range) && raw.slice(range.from, range.to) === binding.slices[index],
    )
  );
}
export function maskInputRanges(text: string, ranges: readonly TaskInputRange[]): string {
  const units = text.split('');
  for (const range of ranges)
    if (validInputRange(text, range)) for (let i = range.from; i < range.to; i++) units[i] = ' ';
  return units.join('');
}
const QUOTE_ENDS: Readonly<Record<string, string>> = {
  '"': '"',
  '«': '»',
  '“': '”',
  "'": "'",
  '`': '`',
};
function commentBarriers(text: string): TaskInputRange[] {
  const result: TaskInputRange[] = [];
  let from = text.indexOf('<!--');
  while (from >= 0) {
    const closing = text.indexOf('-->', from + 4),
      to = closing < 0 ? text.length : closing + 3;
    result.push({ from, to });
    from = text.indexOf('<!--', to);
  }
  return result;
}
function quoteEnd(text: string, from: number, end: string): number {
  let closing = text.indexOf(end, from + 1);
  if (end === "'")
    while (closing >= 0 && /[\p{L}\p{N}]/u.test(text[closing + 1] ?? ''))
      closing = text.indexOf(end, closing + 1);
  return closing < 0 ? text.length : closing + end.length;
}
function quoteAt(text: string, from: number): TaskInputRange | undefined {
  const character = text[from] ?? '',
    end = QUOTE_ENDS[character];
  if (end === undefined || (character === "'" && /[\p{L}\p{N}]/u.test(text[from - 1] ?? '')))
    return undefined;
  return { from, to: quoteEnd(text, from, end) };
}
/** Additional conservative barriers beyond canonical task Markdown atoms. */
export function inputTextBarriers(
  text: string,
  protectedRanges: readonly TaskInputRange[],
): TaskInputRange[] {
  const result = [...protectedRanges, ...commentBarriers(text)];
  let cursor = 0;
  while (cursor < text.length) {
    const protectedRange = result.find((range) => range.from <= cursor && cursor < range.to);
    const quote = protectedRange ?? quoteAt(text, cursor);
    if (quote === undefined) {
      cursor++;
      continue;
    }
    if (protectedRange === undefined) result.push(quote);
    cursor = quote.to;
  }
  for (const match of text.matchAll(/\bhttps?:\/\/[^\s<>]+/giu))
    result.push({ from: match.index, to: match.index + match[0].length });
  return result;
}

const VOID_HTML = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
/** Only already-protected tag atoms can establish an opaque HTML element. */
export function htmlElementBarriers(
  text: string,
  atoms: readonly TaskInputRange[],
): TaskInputRange[] {
  const result: TaskInputRange[] = [];
  const stack: Array<{ name: string; from: number }> = [];
  for (const atom of atoms) {
    const source = text.slice(atom.from, atom.to);
    const tag = /^<(\/?)([a-z][\w:-]*)(?=[\s/>])/iu.exec(source);
    if (tag === null || !source.endsWith('>')) continue;
    const name = (tag[2] ?? '').toLowerCase();
    if (VOID_HTML.has(name) || source.endsWith('/>')) continue;
    if (tag[1] !== '/') {
      stack.push({ name, from: atom.from });
      continue;
    }
    const matching = stack.map((opening) => opening.name).lastIndexOf(name);
    const opening = stack[matching];
    if (opening === undefined) continue;
    result.push({ from: opening.from, to: atom.to });
    stack.splice(matching);
  }
  for (const opening of stack) result.push({ from: opening.from, to: text.length });
  return result;
}
