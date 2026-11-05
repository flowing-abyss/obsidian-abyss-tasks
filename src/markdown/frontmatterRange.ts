export interface FrontmatterRange {
  readonly yamlFrom: number;
  readonly yamlTo: number;
  readonly bodyFrom: number;
  readonly bodyLine: number;
}

const OPENING = /^(?:\uFEFF)?---[ \t]*\r?\n/u;
const CLOSING = /^(?:---|\.\.\.)[ \t]*$/u;
const LEGACY_OPENING = /^[^\S\n]*---[^\S\n]*\n/u;
const DELIMITERS = {
  markdown: { open: OPENING, close: CLOSING },
  source: { open: LEGACY_OPENING, close: CLOSING },
  legacy: { open: LEGACY_OPENING, close: /^\s*---\s*$/u },
};

export function frontmatterRange(
  source: string,
  mode: keyof typeof DELIMITERS = 'markdown',
): FrontmatterRange | null {
  const { open, close } = DELIMITERS[mode];
  const opening = open.exec(source);
  if (opening == null) return null;

  let lineStart = opening[0].length;
  let bodyLine = 2;
  while (lineStart <= source.length) {
    const newline = source.indexOf('\n', lineStart);
    const lineEnd = newline < 0 ? source.length : newline + 1;
    const coreEnd = newline < 0 ? lineEnd : newline;
    const core = source.slice(lineStart, coreEnd).replace(/\r$/u, '');
    if (close.test(core)) {
      return { yamlFrom: opening[0].length, yamlTo: lineStart, bodyFrom: lineEnd, bodyLine };
    }
    if (newline < 0) break;
    lineStart = lineEnd;
    bodyLine++;
  }
  return null;
}
