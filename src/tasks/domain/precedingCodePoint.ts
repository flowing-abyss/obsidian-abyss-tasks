/**
 * Leading negative lookbehinds without lookbehind syntax, which iOS before 16.4 cannot compile.
 * A pattern checks the code point before each match instead. A refused match resumes the search
 * at the next code point after its start, which is where the engine would have tried next.
 * `src/markdown/precedingCodePoint.ts` and `src/tasks/domain/precedingCodePoint.ts` hold the same
 * text through the end of `matchesUnlessPreceded`, because the task domain imports only itself;
 * `test/preceding-code-point.test.ts` runs both and compares their text.
 */

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The index after the code point that starts at `index`, as a `u`-flag search advances. */
function nextCodePointIndex(text: string, index: number): number {
  return isHighSurrogate(text.charCodeAt(index)) && isLowSurrogate(text.charCodeAt(index + 1))
    ? index + 2
    : index + 1;
}

/** The code point that ends at `index`, as a `u`-flag lookbehind reads it; empty at the start. */
function codePointBefore(text: string, index: number): string {
  if (
    index >= 2 &&
    isLowSurrogate(text.charCodeAt(index - 1)) &&
    isHighSurrogate(text.charCodeAt(index - 2))
  ) {
    return text.slice(index - 2, index);
  }
  return index > 0 ? text.charAt(index - 1) : '';
}

/** Only a global `u` regex that is not sticky searches on past a refused match by code point. */
function assertSearchable(regex: RegExp): void {
  if (!regex.global || !regex.unicode || regex.sticky) {
    throw new TypeError(`${String(regex)} must be global, unicode, and not sticky.`);
  }
}

/** The next match from `lastIndex` on whose previous code point `refuses` does not reject. */
function execUnlessPreceded(
  regex: RegExp,
  text: string,
  refuses: (previous: string) => boolean,
): RegExpExecArray | null {
  let match = regex.exec(text);
  while (match !== null && refuses(codePointBefore(text, match.index))) {
    regex.lastIndex = nextCodePointIndex(text, match.index);
    match = regex.exec(text);
  }
  return match;
}

/**
 * The matches of `regex` in `text` that do not start right after a code point that `refuses`
 * rejects, in order, as `text.matchAll` returns them for the lookbehind form.
 */
export function matchesUnlessPreceded(
  regex: RegExp,
  text: string,
  refuses: (previous: string) => boolean,
): RegExpExecArray[] {
  assertSearchable(regex);
  regex.lastIndex = 0;
  const matches: RegExpExecArray[] = [];
  let match = execUnlessPreceded(regex, text, refuses);
  while (match !== null) {
    matches.push(match);
    if (match[0].length === 0) regex.lastIndex = nextCodePointIndex(text, regex.lastIndex);
    match = execUnlessPreceded(regex, text, refuses);
  }
  return matches;
}
