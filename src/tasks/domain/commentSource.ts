import { commentStructuralMarker } from './commentText';
import { parseCommentTimestampPrefix, type CommentTimestamp } from './commentTimestamp';
import { readTaskLinePrefix } from './taskLineSourceModel';
import { isTimeEntryShape } from './timeEntry';

export interface CommentSourceLine {
  readonly line: number;
  readonly prefix: string;
  readonly column: number;
  readonly textFrom: number;
  readonly text: string;
}

export interface CommentSource {
  readonly from: number;
  readonly toExclusive: number;
  readonly originalMarkdown: string;
  readonly headPrefix: string;
  readonly continuationPrefix: string;
  readonly text: string;
  readonly timestamp?: CommentTimestamp;
  readonly lines: readonly CommentSourceLine[];
}

function commentTextColumn(
  head: string,
  listEnd: number,
  timestamp: CommentTimestamp | undefined,
): number {
  if (timestamp === undefined) return listEnd;
  const column = listEnd + timestamp.raw.length + 1;
  return column + (/[\t ]/u.test(head[column] ?? '') ? 1 : 0);
}

function commentHead(
  line: string | undefined,
): { prefix: string; headPrefix: string; text: string; timestamp?: CommentTimestamp } | undefined {
  if (line === undefined) return undefined;
  const head = line.replace(/\r$/u, '');
  if (readTaskLinePrefix(head) !== null || isTimeEntryShape(head)) return undefined;
  const prefix = /^([\t >]*)- /u.exec(head)?.[1];
  const parsed = parseCommentTimestampPrefix(head);
  if (prefix === undefined || parsed === undefined || head.slice(prefix.length).startsWith('- > '))
    return undefined;
  const column = commentTextColumn(head, prefix.length + 2, parsed.timestamp);
  return {
    prefix,
    headPrefix: head.slice(0, column),
    text: head.slice(column),
    ...(parsed.timestamp !== undefined && { timestamp: parsed.timestamp }),
  };
}

function advanceColumn(column: number, character: string): number {
  return character === '\t' ? column + 4 - (column % 4) : column + 1;
}

function commentContainer(prefix: string): {
  quoteDepth: number;
  indentation: number;
  legacyPrefix: string | undefined;
} {
  let column = 0;
  let containerColumn = 0;
  let quoteDepth = 0;
  for (let at = 0; at < prefix.length; at++) {
    const character = prefix[at] ?? '';
    column = advanceColumn(column, character);
    if (character !== '>') continue;
    quoteDepth++;
    // One column belongs to optional quote spacing. A delimiter tab's remaining
    // columns still contribute indentation, although its raw byte is consumed whole.
    containerColumn = column + (/[\t ]/u.test(prefix[at + 1] ?? '') ? 1 : 0);
  }
  return {
    quoteDepth,
    indentation: column - containerColumn,
    legacyPrefix: prefix.endsWith('>') ? `${prefix}  ` : undefined,
  };
}

function quoteContainerPosition(
  source: string,
  quoteDepth: number,
): { at: number; column: number; containerColumn: number } | undefined {
  let at = 0;
  let column = 0;
  let containerColumn = 0;
  for (let depth = 0; depth < quoteDepth; depth++) {
    while (/[\t ]/u.test(source.charAt(at))) {
      column = advanceColumn(column, source.charAt(at));
      at++;
    }
    if (source[at] !== '>') return undefined;
    at++;
    column++;
    containerColumn = column;
    if (/[\t ]/u.test(source.charAt(at))) {
      containerColumn++;
      column = advanceColumn(column, source.charAt(at));
      at++;
    }
  }
  return { at, column, containerColumn };
}

function continuationColumn(
  source: string,
  container: ReturnType<typeof commentContainer>,
): number | undefined {
  const position = quoteContainerPosition(source, container.quoteDepth);
  if (position === undefined) return undefined;
  // Earlier comments without a final quote-delimiter blank used exactly two
  // spaces after that marker. Keep their raw spelling and payload coordinates.
  if (container.legacyPrefix !== undefined && source.startsWith(container.legacyPrefix))
    return container.legacyPrefix.length;
  let { at, column } = position;
  const { containerColumn } = position;
  const threshold = containerColumn + container.indentation + 2;
  while (column < threshold && /[\t ]/u.test(source.charAt(at))) {
    column = advanceColumn(column, source.charAt(at));
    at++;
  }
  return column < threshold ? undefined : at;
}

function continuationText(
  line: string | undefined,
  container: ReturnType<typeof commentContainer>,
): { prefix: string; text: string } | undefined {
  const source = line?.replace(/\r$/u, '');
  if (source === undefined) return undefined;
  const at = continuationColumn(source, container);
  if (at === undefined) return undefined;
  const text = source.slice(at);
  return /^[\t ]*$/u.test(text) || commentStructuralMarker(text) !== undefined
    ? undefined
    : { prefix: source.slice(0, at), text };
}

/** Reads one contiguous owned block from split-LF source, retaining terminal CR evidence. */
export function readCommentBlock(
  lines: readonly string[],
  from: number,
  toExclusive = lines.length,
): CommentSource | undefined {
  if (from < 0 || from >= toExclusive) return undefined;
  const head = commentHead(lines[from]);
  if (head === undefined) return undefined;
  const container = commentContainer(head.prefix);
  const result: CommentSourceLine[] = [
    {
      line: from,
      prefix: head.headPrefix,
      column: head.headPrefix.length,
      textFrom: 0,
      text: head.text,
    },
  ];
  let text = head.text;
  let end = from + 1;
  while (end < toExclusive) {
    const tail = continuationText(lines[end], container);
    if (tail === undefined) break;
    result.push({
      line: end,
      prefix: tail.prefix,
      column: tail.prefix.length,
      textFrom: text.length + 1,
      text: tail.text,
    });
    text += `\n${tail.text}`;
    end++;
  }
  return {
    from,
    toExclusive: end,
    originalMarkdown: lines.slice(from, end).join('\n'),
    headPrefix: head.headPrefix,
    continuationPrefix: result[1]?.prefix ?? `${head.prefix}  `,
    text,
    ...(head.timestamp !== undefined && { timestamp: head.timestamp }),
    lines: result,
  };
}

/** Advances a structural scan over exactly one accepted comment, or one ordinary line. */
export function commentBlockEnd(
  lines: readonly string[],
  from: number,
  toExclusive = lines.length,
): number {
  return readCommentBlock(lines, from, toExclusive)?.toExclusive ?? from + 1;
}

/** Retains each authored physical prefix; added continuations use one stable fallback. */
export function replacementCommentSourceLines(
  original: CommentSource,
  text: string,
): readonly string[] {
  return text
    .split('\n')
    .map(
      (line, index) =>
        `${index === 0 ? original.headPrefix : (original.lines[index]?.prefix ?? original.continuationPrefix)}${line}`,
    );
}
