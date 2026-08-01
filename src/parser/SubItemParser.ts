import type { StatusCatalog } from '../tasks/domain/StatusCatalog';
import { extractMetadata } from './extractMetadata';
import { collapseLinks } from './links';
import type { SubTask, TaskComment } from './types';

export interface SubItemResult {
  subtasks: SubTask[];
  comments: TaskComment[];
  description: string;
  subtaskRange: { from: number; to: number } | undefined;
}

// Leading group allows blockquote/callout markers (`>`) alongside whitespace so
// sub-items inside a blockquote (`> \t- [ ]`) nest correctly under their parent.
const SUBTASK_RE = /^([\s>]*)- \[(.)\]\s+(.*)/;
const DESCRIPTION_RE = /^([\s>]*)- > (.*)/;
const COMMENT_DATE_RE = /^([\s>]*)- (\d{4}-\d{2}-\d{2}):\s*(.*)/;
const COMMENT_RE = /^([\s>]*)- (.+)/;
const INDENT_RE = /^[\s>]*/;

function leadingPrefix(line: string): string {
  return INDENT_RE.exec(line)?.[0] ?? '';
}

function getIndent(line: string): number {
  // Normalize: each tab counts as 4 spaces so mixed indent still compares correctly.
  // Blockquote markers (`>`) count toward depth, so a quoted child indents past its
  // quoted parent just as a plain-list child does.
  return leadingPrefix(line).replace(/\t/g, '    ').length;
}

/** Number of blockquote/callout `>` markers in the line's leading prefix. */
function getQuoteDepth(line: string): number {
  const prefix = leadingPrefix(line);
  let depth = 0;
  for (const ch of prefix) if (ch === '>') depth++;
  return depth;
}

function parseSubtask(
  lines: string[],
  i: number,
  filePath: string,
  subtaskMatch: RegExpExecArray,
  statusCatalog: StatusCatalog,
): { subtask: SubTask; nextIdx: number; rangeTo: number } {
  const rawText = lines[i] ?? '';
  const statusChar = subtaskMatch[2] ?? ' ';
  const rawContent = (subtaskMatch[3] ?? '').trim();
  const meta = extractMetadata(rawContent);
  const childResult = parseSubItems(lines, i, filePath, statusCatalog);
  const subtask: SubTask = {
    filePath,
    line: i,
    rawText,
    text: collapseLinks(meta.cleanText),
    markdownText: meta.cleanText,
    status: statusCatalog.statusForSymbol(statusChar),
    statusSymbol: statusChar,
    priority: meta.priority,
    ...(meta.due !== undefined && { due: meta.due }),
    ...(meta.scheduled !== undefined && { scheduled: meta.scheduled }),
    ...(meta.start !== undefined && { start: meta.start }),
    ...(meta.completion !== undefined && { completion: meta.completion }),
    ...(meta.cancelledDate !== undefined && { cancelledDate: meta.cancelledDate }),
    ...(meta.created !== undefined && { created: meta.created }),
    ...(meta.time !== undefined && { time: meta.time }),
    ...(meta.recurrence !== undefined && { recurrence: meta.recurrence }),
    onCompletion: meta.onCompletion,
    onCompletionExplicit: meta.onCompletionExplicit,
  };
  if (childResult.subtasks.length) subtask.subtasks = childResult.subtasks;
  if (childResult.comments.length) subtask.comments = childResult.comments;
  if (childResult.description) subtask.description = childResult.description;
  let rangeTo = i;
  let nextIdx = i + 1;
  if (childResult.subtaskRange) {
    subtask.subtaskRange = childResult.subtaskRange;
    rangeTo = childResult.subtaskRange.to;
    nextIdx = childResult.subtaskRange.to + 1;
  }
  return { subtask, nextIdx, rangeTo };
}

export function parseSubItems(
  lines: string[],
  taskLineIdx: number,
  filePath: string,
  statusCatalog: StatusCatalog,
): SubItemResult {
  const taskLine = lines[taskLineIdx] ?? '';
  const taskIndent = getIndent(taskLine);
  const taskQuote = getQuoteDepth(taskLine);

  const subtasks: SubTask[] = [];
  const comments: TaskComment[] = [];
  const descLines: string[] = [];
  let rangeFrom: number | undefined;
  let rangeTo: number | undefined;

  let i = taskLineIdx + 1;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    // A blank line inside a blockquote still carries its `>` marker(s) ("> ", ">"),
    // so treat any whitespace-and-`>`-only line as blank — otherwise it would be read
    // as content and terminate the scan, dropping sub-items that follow it.
    if (/^[\s>]*$/u.test(line)) {
      i++;
      continue;
    }

    const lineIndent = getIndent(line);
    // A sub-item must sit at the same blockquote depth as its parent AND be more
    // indented. A differing quote depth marks a new container (e.g. a plain-list
    // task followed by a `>` blockquote task), which is a sibling block, not a child.
    if (getQuoteDepth(line) !== taskQuote || lineIndent <= taskIndent) break;

    if (rangeFrom === undefined) rangeFrom = i;
    rangeTo = i;

    const subtaskMatch = SUBTASK_RE.exec(line);
    if (subtaskMatch) {
      const parsed = parseSubtask(lines, i, filePath, subtaskMatch, statusCatalog);
      subtasks.push(parsed.subtask);
      rangeTo = parsed.rangeTo;
      i = parsed.nextIdx;
      continue;
    }

    const descMatch = DESCRIPTION_RE.exec(line);
    if (descMatch) {
      descLines.push((descMatch[2] ?? '').trim());
      i++;
      continue;
    }

    const commentDateMatch = COMMENT_DATE_RE.exec(line);
    if (commentDateMatch) {
      comments.push({
        line: i,
        date: commentDateMatch[2],
        text: (commentDateMatch[3] ?? '').trim(),
      });
      i++;
      continue;
    }

    const commentMatch = COMMENT_RE.exec(line);
    if (commentMatch) {
      comments.push({ line: i, date: undefined, text: (commentMatch[2] ?? '').trim() });
      i++;
      continue;
    }

    i++;
  }

  return {
    subtasks,
    comments,
    description: descLines.join('\n'),
    subtaskRange:
      rangeFrom !== undefined && rangeTo !== undefined
        ? { from: rangeFrom, to: rangeTo }
        : undefined,
  };
}
