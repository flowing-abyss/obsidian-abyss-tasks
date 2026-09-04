export interface SourceRange {
  readonly from: number;
  readonly to: number;
}

function isEscaped(source: string, at: number): boolean {
  let slashes = 0;
  for (let index = at - 1; index >= 0 && source[index] === '\\'; index--) slashes++;
  return slashes % 2 === 1;
}

function closingDelimiterAt(source: string, delimiter: string, from: number): number {
  let close = source.indexOf(delimiter, from);
  while (close >= 0 && (source[close - 1] === '`' || source[close + delimiter.length] === '`')) {
    close = source.indexOf(delimiter, close + 1);
  }
  return close;
}

/** Finds closed CommonMark-style code spans using exact-length backtick delimiters. */
export function inlineCodeRanges(source: string): readonly SourceRange[] {
  const ranges: SourceRange[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf('`', cursor);
    if (open < 0) break;
    if (isEscaped(source, open)) {
      cursor = open + 1;
      continue;
    }
    let runLength = 1;
    while (source[open + runLength] === '`') runLength++;
    const delimiter = '`'.repeat(runLength);
    const close = closingDelimiterAt(source, delimiter, open + runLength);
    if (close < 0) {
      cursor = open + runLength;
      continue;
    }
    ranges.push({ from: open, to: close + runLength });
    cursor = close + runLength;
  }
  return ranges;
}
