import type { SourceRange } from './taskLineAtomicRanges';

// Each sticky match consumes one attribute or the terminator, never a whole repeated suffix.
const TOKEN = /(\s*\/?>)|\s+[A-Za-z_:][\w:.-]*(?:\s*(=)\s*)?/uy;
const VALUE = /"[^"]*"|'[^']*'|[^\s"'=<>`]+/uy;

function htmlTagEnd(source: string, from: number, closing: boolean): number {
  TOKEN.lastIndex = from;
  let token: RegExpExecArray | null;
  while ((token = TOKEN.exec(source)) !== null) {
    if (token[1] !== undefined || closing) return token[1] !== undefined ? TOKEN.lastIndex : -1;
    if (token[2] === undefined) continue;
    VALUE.lastIndex = TOKEN.lastIndex;
    if (!VALUE.test(source)) return -1;
    TOKEN.lastIndex = VALUE.lastIndex;
  }
  return -1;
}

/** Complete HTML tags are title syntax; their attributes cannot contain task fields. */
export function htmlTagRanges(
  source: string,
  protectedRanges: readonly SourceRange[],
): readonly SourceRange[] {
  const ranges: SourceRange[] = [];
  const open = /<(\/?)[A-Za-z][A-Za-z0-9-]*|(\\[\\<])/gu;
  let protectedIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = open.exec(source)) !== null) {
    if (match[2] !== undefined) continue;
    while ((protectedRanges[protectedIndex]?.to ?? Number.POSITIVE_INFINITY) <= match.index)
      protectedIndex++;
    const protectedRange = protectedRanges[protectedIndex];
    if (protectedRange !== undefined && protectedRange.from <= match.index) continue;
    const to = htmlTagEnd(source, open.lastIndex, match[1] === '/');
    if (to < 0) continue;
    ranges.push({ from: match.index, to });
    open.lastIndex = to;
  }
  return ranges;
}
