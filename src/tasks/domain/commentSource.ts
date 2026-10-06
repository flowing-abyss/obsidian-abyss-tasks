import { commentStructuralMarker } from './commentText';
import { parseCommentTimestampPrefix, type CommentTimestamp } from './commentTimestamp';
import { readTaskLinePrefix } from './taskLineSourceModel';
import { isTimeEntryShape } from './timeEntry';

export interface CommentSourceLine {
  readonly line: number;
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

function continuationText(line: string | undefined, prefix: string): string | undefined {
  const source = line?.replace(/\r$/u, '');
  if (source?.startsWith(prefix) !== true) return undefined;
  const tail = source.slice(prefix.length);
  return /^[\t ]*$/u.test(tail) || commentStructuralMarker(tail) !== undefined ? undefined : tail;
}

/** Reads one contiguous owned block from split-LF source, retaining terminal CR evidence. */
export function readCommentBlock(
  lines: readonly string[],
  from: number,
  toExclusive: number,
): CommentSource | undefined {
  if (from < 0 || from >= toExclusive) return undefined;
  const head = commentHead(lines[from]);
  if (head === undefined) return undefined;
  const continuationPrefix = `${head.prefix}  `;
  const result: CommentSourceLine[] = [
    { line: from, column: head.headPrefix.length, textFrom: 0, text: head.text },
  ];
  let text = head.text;
  let end = from + 1;
  while (end < toExclusive) {
    const tail = continuationText(lines[end], continuationPrefix);
    if (tail === undefined) break;
    result.push({
      line: end,
      column: continuationPrefix.length,
      textFrom: text.length + 1,
      text: tail,
    });
    text += `\n${tail}`;
    end++;
  }
  return {
    from,
    toExclusive: end,
    originalMarkdown: lines.slice(from, end).join('\n'),
    headPrefix: head.headPrefix,
    continuationPrefix,
    text,
    ...(head.timestamp !== undefined && { timestamp: head.timestamp }),
    lines: result,
  };
}
