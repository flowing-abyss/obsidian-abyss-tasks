import type { StatusCatalog } from '../tasks/domain/StatusCatalog';
import { parseCommentTimestampPrefix } from '../tasks/domain/commentTimestamp';
import { extractMetadata, type ExtractedMetadata } from './extractMetadata';
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

function subtaskMetadataFields(meta: ExtractedMetadata): Partial<SubTask> {
  return {
    ...(meta.due !== undefined && { due: meta.due }),
    ...(meta.scheduled !== undefined && { scheduled: meta.scheduled }),
    ...(meta.start !== undefined && { start: meta.start }),
    ...(meta.completion !== undefined && { completion: meta.completion }),
    ...(meta.cancelledDate !== undefined && { cancelledDate: meta.cancelledDate }),
    ...(meta.created !== undefined && { created: meta.created }),
    ...(meta.time !== undefined && { time: meta.time }),
    ...(meta.recurrence !== undefined && { recurrence: meta.recurrence }),
  };
}

function subtaskChildFields(childResult: SubItemResult): Partial<SubTask> {
  return {
    ...(childResult.subtasks.length > 0 && { subtasks: childResult.subtasks }),
    ...(childResult.comments.length > 0 && { comments: childResult.comments }),
    ...(childResult.description.length > 0 && { description: childResult.description }),
    ...(childResult.subtaskRange !== undefined && { subtaskRange: childResult.subtaskRange }),
  };
}

interface ParseSubtaskContext {
  readonly lines: string[];
  readonly index: number;
  readonly filePath: string;
  readonly match: RegExpExecArray;
  readonly statusCatalog: StatusCatalog;
}

interface SubItemAccumulator {
  readonly subtasks: SubTask[];
  readonly comments: TaskComment[];
  readonly descriptionLines: string[];
}

interface ConsumeNestedLineContext {
  readonly lines: string[];
  readonly index: number;
  readonly filePath: string;
  readonly statusCatalog: StatusCatalog;
  readonly accumulator: SubItemAccumulator;
}

function parseSubtask(context: ParseSubtaskContext): {
  subtask: SubTask;
  nextIdx: number;
  rangeTo: number;
} {
  const { lines, index, filePath, match, statusCatalog } = context;
  const rawText = lines[index] ?? '';
  const statusChar = match[2] ?? ' ';
  const rawContent = (match[3] ?? '').trim();
  const meta = extractMetadata(rawContent);
  const childResult = parseSubItems(lines, index, filePath, statusCatalog);
  const subtask: SubTask = {
    filePath,
    line: index,
    rawText,
    text: collapseLinks(meta.cleanText),
    markdownText: meta.cleanText,
    status: statusCatalog.statusForSymbol(statusChar),
    statusSymbol: statusChar,
    priority: meta.priority,
    ...subtaskMetadataFields(meta),
    ...subtaskChildFields(childResult),
    onCompletion: meta.onCompletion,
    onCompletionExplicit: meta.onCompletionExplicit,
  };
  const rangeTo = childResult.subtaskRange?.to ?? index;
  const nextIdx = rangeTo + 1;
  return { subtask, nextIdx, rangeTo };
}

function consumeNestedLine(context: ConsumeNestedLineContext): {
  readonly nextIndex: number;
  readonly rangeTo: number;
} {
  const { lines, index, filePath, statusCatalog, accumulator } = context;
  const line = lines[index] ?? '';
  const subtaskMatch = SUBTASK_RE.exec(line);
  if (subtaskMatch != null) {
    const parsed = parseSubtask({ lines, index, filePath, match: subtaskMatch, statusCatalog });
    accumulator.subtasks.push(parsed.subtask);
    return { nextIndex: parsed.nextIdx, rangeTo: parsed.rangeTo };
  }

  const descriptionMatch = DESCRIPTION_RE.exec(line);
  if (descriptionMatch != null) {
    accumulator.descriptionLines.push((descriptionMatch[2] ?? '').trim());
    return { nextIndex: index + 1, rangeTo: index };
  }

  const comment = parseCommentTimestampPrefix(line);
  if (comment != null) {
    accumulator.comments.push({
      line: index,
      ...(comment.timestamp != null && { timestamp: comment.timestamp }),
      text: comment.text.trim(),
    });
  }
  return { nextIndex: index + 1, rangeTo: index };
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

  const accumulator: SubItemAccumulator = {
    subtasks: [],
    comments: [],
    descriptionLines: [],
  };
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

    rangeFrom ??= i;
    const consumed = consumeNestedLine({ lines, index: i, filePath, statusCatalog, accumulator });
    rangeTo = consumed.rangeTo;
    i = consumed.nextIndex;
  }

  return {
    subtasks: accumulator.subtasks,
    comments: accumulator.comments,
    description: accumulator.descriptionLines.join('\n'),
    subtaskRange:
      rangeFrom !== undefined && rangeTo !== undefined
        ? { from: rangeFrom, to: rangeTo }
        : undefined,
  };
}
