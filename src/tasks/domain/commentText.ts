import { inlineCodeRanges, type SourceRange } from './taskLineAtomicRanges';

export type CommentTextResult =
  | { readonly type: 'ready'; readonly text: string }
  | { readonly type: 'empty' }
  | { readonly type: 'invalid'; readonly reason: 'unsafe-raw-continuation' };

export interface CommentStructuralMarker {
  readonly from: number;
  readonly to: number;
  readonly kind: 'list' | 'quote' | 'heading' | 'fence';
}

/** Finite block openers that cannot belong to a comment continuation unescaped. */
export function commentStructuralMarker(line: string): CommentStructuralMarker | undefined {
  const from = /^[\t ]*/u.exec(line)?.[0].length ?? 0;
  const body = line.slice(from);
  const fence = /^(?:`{3,}|~{3,})/u.exec(body);
  if (fence !== null) return { from, to: from + fence[0].length, kind: 'fence' };
  if (/^>/u.test(body)) return { from, to: from + 1, kind: 'quote' };
  if (/^#{1,6}(?:[\t ]|$)/u.test(body)) return { from, to: from + 1, kind: 'heading' };
  if (/^[-+*](?:[\t ]|$)/u.test(body)) return { from, to: from + 1, kind: 'list' };
  const ordered = /^\d{1,9}([.)])(?:[\t ]|$)/u.exec(body);
  if (ordered !== null) {
    const delimiter = from + (/^\d+/u.exec(ordered[0])?.[0].length ?? 0);
    return { from: delimiter, to: delimiter + 1, kind: 'list' };
  }
  return undefined;
}

function escapedAt(text: string, at: number): boolean {
  let slashes = 0;
  for (let cursor = at - 1; cursor >= 0 && text[cursor] === '\\'; cursor--) slashes++;
  return slashes % 2 === 1;
}

function delimiterEnd(text: string, from: number, delimiter: string): number | undefined {
  for (
    let at = text.indexOf(delimiter, from);
    at >= 0;
    at = text.indexOf(delimiter, at + delimiter.length)
  ) {
    if (!escapedAt(text, at)) return at + delimiter.length;
  }
  return undefined;
}

const HTML_BLOCK_TAGS = new Set(
  'address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul'.split(
    ' ',
  ),
);
const ATTRIBUTE_NAME = '[A-Za-z_:][A-Za-z\\d_.:-]*';
const ATTRIBUTE_VALUE = `(?:"[^"]*"|'[^']*'|[^\\s"'=<>\u0060]+)`;
const HTML_TAG = new RegExp(
  `<\\/?[A-Za-z][A-Za-z\\d-]*(?:\\s+${ATTRIBUTE_NAME}(?:\\s*=\\s*${ATTRIBUTE_VALUE})?)*\\s*\\/?>`,
  'uy',
);

function htmlDelimiter(tail: string): string | undefined {
  if (tail.startsWith('<!--')) return '-->';
  if (tail.startsWith('<?')) return '?>';
  if (tail.startsWith('<![CDATA[')) return ']]>';
  return /^<![A-Z]/u.test(tail) ? '>' : undefined;
}

function terminatedHtml(
  text: string,
  from: number,
  delimiter: string,
  block: boolean,
): number | undefined {
  const end = text.indexOf(delimiter, from + 2);
  if (end >= 0) return end + delimiter.length;
  return block ? text.length : undefined;
}

function rawTagEnd(tail: string, tag: string): number {
  const close = new RegExp(`</${tag}\\s*>`, 'iu').exec(tail);
  return close === null ? tail.length : close.index + close[0].length;
}

function standaloneHtmlTag(
  tail: string,
  tag: string | undefined,
  startsParagraph: boolean,
): boolean {
  return startsParagraph && tag !== undefined && /^[\t ]*(?:\n|$)/u.test(tail.slice(tag.length));
}

function htmlBlockEnd(
  tail: string,
  tag: string | undefined,
  startsParagraph: boolean,
): number | undefined {
  const rawTag = /^<(script|pre|style|textarea)(?:[\t \n>]|$)/iu.exec(tail)?.[1];
  if (rawTag !== undefined) {
    return rawTagEnd(tail, rawTag);
  }
  const name = /^<\/?([A-Za-z][A-Za-z\d-]*)(?:[\t \n/>]|$)/u.exec(tail)?.[1];
  if (name === undefined) return undefined;
  const standalone = standaloneHtmlTag(tail, tag, startsParagraph);
  if (!HTML_BLOCK_TAGS.has(name.toLowerCase()) && !standalone) return undefined;
  return /\n[\t ]*\n/u.exec(tail)?.index ?? tail.length;
}

/** Recognized HTML literals only; an ordinary less-than sign grants no raw authority. */
function htmlRawEnd(text: string, from: number): number | undefined {
  const tail = text.slice(from);
  const block = /^ {0,3}$/u.test(text.slice(text.lastIndexOf('\n', from - 1) + 1, from));
  const delimiter = htmlDelimiter(tail);
  if (delimiter !== undefined) return terminatedHtml(text, from, delimiter, block);
  HTML_TAG.lastIndex = from;
  const tag = HTML_TAG.exec(text)?.[0];
  const blockEnd = block
    ? htmlBlockEnd(tail, tag, text.slice(0, from).trim().length === 0)
    : undefined;
  if (blockEnd !== undefined) return from + blockEnd;
  return tag === undefined ? undefined : from + tag.length;
}

function literalEnd(text: string, from: number): number | undefined {
  if (text.startsWith('%%', from)) return delimiterEnd(text, from + 2, '%%') ?? text.length;
  if (text[from] === '<') return htmlRawEnd(text, from);
  if (text[from] !== '$') return undefined;
  const delimiter = text.startsWith('$$', from) ? '$$' : '$';
  const end = delimiterEnd(text, from + delimiter.length, delimiter);
  return end ?? (delimiter === '$$' ? text.length : undefined);
}

function firstFenceRange(text: string): SourceRange | undefined {
  const newline = text.indexOf('\n');
  if (newline < 0) return undefined;
  const opener = /^ {0,3}(`{3,}|~{3,})/u.exec(text.slice(0, newline));
  const delimiter = opener?.[1];
  if (opener === null || delimiter === undefined) return undefined;
  if (delimiter.startsWith('`') && text.slice(opener[0].length, newline).includes('`'))
    return undefined;
  const closing = new RegExp(`^ {0,3}${delimiter[0]}{${delimiter.length},}[\\t ]*(?:$|\\n)`, 'mu');
  const tail = text.slice(newline + 1);
  const close = closing.exec(tail);
  return {
    from: 0,
    to: close === null ? text.length : newline + 1 + close.index + close[0].length,
  };
}

function nextOrderedRange(
  ranges: readonly SourceRange[],
  at: number,
  cursor: { index: number },
): SourceRange | undefined {
  while ((ranges[cursor.index]?.to ?? Number.POSITIVE_INFINITY) <= at) cursor.index++;
  return ranges[cursor.index];
}

/** Finite literal guard, consulted only when protecting a structural continuation. */
function rawRanges(text: string): readonly SourceRange[] {
  const code = inlineCodeRanges(text);
  const fence = firstFenceRange(text);
  const ranges: SourceRange[] = fence === undefined ? [...code] : [...code, fence];
  let cursor = 0;
  const codeCursor = { index: 0 };
  while (cursor < text.length) {
    const span = nextOrderedRange(code, cursor, codeCursor);
    if (span !== undefined && cursor >= span.from) {
      cursor = span.to;
      continue;
    }
    const end = escapedAt(text, cursor) ? undefined : literalEnd(text, cursor);
    if (end === undefined) cursor++;
    else {
      ranges.push({ from: cursor, to: end });
      cursor = end;
    }
  }
  return ranges.sort((left, right) => left.from - right.from);
}

export function normalizeCommentText(input: string): CommentTextResult {
  const lines = input
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .filter((line) => !/^[\t ]*$/u.test(line));
  if (lines.length === 0) return { type: 'empty' };
  const text = lines.join('\n');
  let raw: readonly SourceRange[] | undefined;
  let offset = 0;
  const rawCursor = { index: 0 };
  const protectedLines: string[] = [];
  for (const [index, line] of lines.entries()) {
    const marker = index === 0 ? undefined : commentStructuralMarker(line);
    if (marker !== undefined) {
      raw ??= rawRanges(text);
      const range = nextOrderedRange(raw, offset + marker.from, rawCursor);
      if (offset + marker.to > (range?.from ?? Number.POSITIVE_INFINITY))
        return { type: 'invalid', reason: 'unsafe-raw-continuation' };
      protectedLines.push(
        line.slice(0, marker.from) +
          [...line.slice(marker.from, marker.to)].map((character) => `\\${character}`).join('') +
          line.slice(marker.to),
      );
    } else protectedLines.push(line);
    offset += line.length + 1;
  }
  return { type: 'ready', text: protectedLines.join('\n') };
}
