import { countLinksIn } from '../../../markdown/links';
import type { CommentTimestamp } from '../../domain/commentTimestamp';
import { parseCommentTimestampPrefix } from '../../domain/commentTimestamp';
import type { StatusCatalog } from '../../domain/StatusCatalog';
import type {
  CommentRef,
  DurationMinutes,
  LocalDate,
  LocalTime,
  SubtaskPlanning,
  SubtaskSnapshot,
  TaskCommentSnapshot,
  TaskNodeRef,
  TaskPlanning,
  TaskRef,
  TaskSnapshot,
} from '../../domain/types';
import { durationMinutes, localDate, localTime } from '../../domain/validation';
import type { TaskMarkdownCodec } from './TaskMarkdownCodec';

const PREFIX_RE = /^([\s>]*)/u;
const SUBTASK_RE = /^([\s>]*)- \[(.)\]\s+(.*)/u;
const DESCRIPTION_RE = /^([\s>]*)- > (.*)/u;

interface ProjectionContext {
  readonly codec: TaskMarkdownCodec;
  readonly statusCatalog: StatusCatalog;
  readonly filePath: string;
  readonly lines: readonly string[];
}

interface ProjectedChildren {
  readonly subtasks: readonly SubtaskSnapshot[];
  readonly comments: readonly TaskCommentSnapshot[];
  readonly description?: string;
  readonly toLine: number;
}

export interface TaskSnapshotProjection {
  readonly codec: TaskMarkdownCodec;
  readonly statusCatalog: StatusCatalog;
  readonly filePath: string;
  readonly lines: readonly string[];
  readonly line: number;
  readonly exactBlock: string;
  readonly ref: TaskRef;
  readonly presentation: TaskSnapshot['presentation'];
}

function indentation(line: string): number {
  return (PREFIX_RE.exec(line)?.[1] ?? '').replace(/\t/gu, '    ').length;
}

function quoteDepth(line: string): number {
  return [...(PREFIX_RE.exec(line)?.[1] ?? '')].filter((character) => character === '>').length;
}

function asLocalDate(value: string | undefined): LocalDate | undefined {
  if (value === undefined) return undefined;
  try {
    return localDate(value);
  } catch {
    return undefined;
  }
}

function asLocalTime(value: string | undefined): LocalTime | undefined {
  if (value === undefined) return undefined;
  try {
    return localTime(value);
  } catch {
    return undefined;
  }
}

function asDuration(value: number | undefined): DurationMinutes | undefined {
  if (value === undefined) return undefined;
  try {
    return durationMinutes(value);
  } catch {
    return undefined;
  }
}

function planningFrom(planning: {
  readonly created?: string;
  readonly due?: string;
  readonly scheduled?: string;
  readonly start?: string;
  readonly completion?: string;
  readonly cancelled?: string;
  readonly time?: string;
  readonly duration?: number;
}): TaskPlanning {
  const created = asLocalDate(planning.created);
  const due = asLocalDate(planning.due);
  const scheduled = asLocalDate(planning.scheduled);
  const start = asLocalDate(planning.start);
  const completion = asLocalDate(planning.completion);
  const cancelled = asLocalDate(planning.cancelled);
  const time = asLocalTime(planning.time);
  const duration = asDuration(planning.duration);
  return {
    ...(created != null && { created }),
    ...(due != null && { due }),
    ...(scheduled != null && { scheduled }),
    ...(start != null && { start }),
    ...(completion != null && { completion }),
    ...(cancelled != null && { cancelled }),
    ...(time != null && { time }),
    ...(duration != null && { duration }),
  };
}

function subtaskPlanningFrom(planning: {
  readonly created?: string;
  readonly due?: string;
  readonly scheduled?: string;
  readonly start?: string;
  readonly completion?: string;
  readonly cancelled?: string;
  readonly time?: string;
}): SubtaskPlanning {
  const created = asLocalDate(planning.created);
  const due = asLocalDate(planning.due);
  const scheduled = asLocalDate(planning.scheduled);
  const start = asLocalDate(planning.start);
  const completion = asLocalDate(planning.completion);
  const cancelled = asLocalDate(planning.cancelled);
  const time = asLocalTime(planning.time);
  return {
    ...(created != null && { created }),
    ...(due != null && { due }),
    ...(scheduled != null && { scheduled }),
    ...(start != null && { start }),
    ...(completion != null && { completion }),
    ...(cancelled != null && { cancelled }),
    ...(time != null && { time }),
  };
}

function blockFor(lines: readonly string[], from: number, to: number): string {
  return lines.slice(from, to + 1).join('\n');
}

interface CommentSnapshotInput {
  readonly parent: TaskNodeRef;
  readonly parentLine: number;
  readonly line: number;
  readonly originalMarkdown: string;
  readonly text: string;
  readonly timestamp?: CommentTimestamp;
}

function commentSnapshot(input: CommentSnapshotInput): TaskCommentSnapshot {
  const { parent, parentLine, line, originalMarkdown, text, timestamp } = input;
  const ref: CommentRef = {
    parent,
    relativeLine: line - parentLine,
    originalMarkdown,
  };
  return { ref, ...(timestamp != null && { timestamp }), text };
}

function projectedSubtask(
  context: ProjectionContext,
  parent: TaskNodeRef,
  line: number,
  source: string,
): { readonly snapshot: SubtaskSnapshot; readonly toLine: number } | undefined {
  if (SUBTASK_RE.exec(source) == null) return undefined;
  const parsed = context.codec.parseLine(source, { filePath: context.filePath, line });
  return parsed == null ? undefined : projectSubtask(context, line, parent, parsed);
}

interface ProjectedContentTarget {
  readonly parent: TaskNodeRef;
  readonly parentLine: number;
  readonly line: number;
  readonly source: string;
  readonly descriptions: string[];
  readonly comments: TaskCommentSnapshot[];
}

function appendProjectedContent(target: ProjectedContentTarget): void {
  const description = DESCRIPTION_RE.exec(target.source);
  if (description != null) {
    target.descriptions.push((description[2] ?? '').trim());
    return;
  }
  const comment = parseCommentTimestampPrefix(target.source);
  if (comment == null) return;
  target.comments.push(
    commentSnapshot({
      parent: target.parent,
      parentLine: target.parentLine,
      line: target.line,
      originalMarkdown: target.source,
      text: comment.text.trim(),
      ...(comment.timestamp !== undefined && { timestamp: comment.timestamp }),
    }),
  );
}

function projectChildren(
  context: ProjectionContext,
  parentLine: number,
  parent: TaskNodeRef,
): ProjectedChildren {
  const parentSource = context.lines[parentLine] ?? '';
  const parentIndent = indentation(parentSource);
  const parentQuoteDepth = quoteDepth(parentSource);
  const subtasks: SubtaskSnapshot[] = [];
  const comments: TaskCommentSnapshot[] = [];
  const descriptions: string[] = [];
  let toLine = parentLine;
  let line = parentLine + 1;

  while (line < context.lines.length) {
    const source = context.lines[line];
    if (source === undefined) break;
    if (/^[\s>]*$/u.test(source)) {
      line++;
      continue;
    }
    if (quoteDepth(source) !== parentQuoteDepth || indentation(source) <= parentIndent) break;
    toLine = line;

    const child = projectedSubtask(context, parent, line, source);
    if (child != null) {
      subtasks.push(child.snapshot);
      toLine = child.toLine;
      line = child.toLine + 1;
      continue;
    }
    appendProjectedContent({ parent, parentLine, line, source, descriptions, comments });
    line++;
  }

  const description = descriptions.join('\n');
  return {
    subtasks,
    comments,
    ...(Boolean(description) && { description }),
    toLine,
  };
}

function projectSubtask(
  context: ProjectionContext,
  line: number,
  parent: TaskNodeRef,
  parsed: NonNullable<ReturnType<TaskMarkdownCodec['parseLine']>>,
): { readonly snapshot: SubtaskSnapshot; readonly toLine: number } {
  const temporaryRef = {
    parent,
    relativeLine: line - absoluteNodeLine(parent),
    originalBlock: context.lines[line] ?? '',
  };
  const temporaryNode: TaskNodeRef = { type: 'subtask', ref: temporaryRef };
  const children = projectChildren(context, line, temporaryNode);
  const ref = {
    ...temporaryRef,
    originalBlock: blockFor(context.lines, line, children.toLine),
  };
  const node: TaskNodeRef = { type: 'subtask', ref };
  const relocatedChildren = relocateChildren(children, node);
  const status =
    parsed.planning.cancelled !== undefined && parsed.planning.cancelled.length > 0
      ? 'cancelled'
      : context.statusCatalog.statusForSymbol(parsed.statusSymbol);
  return {
    snapshot: {
      ref,
      title: parsed.title,
      markdownTitle: parsed.markdownTitle,
      status,
      statusSymbol: parsed.statusSymbol,
      priority: parsed.priority,
      planning: subtaskPlanningFrom(parsed.planning),
      tags: [...parsed.tags],
      ...(parsed.dependencyId !== undefined && { dependencyId: parsed.dependencyId }),
      dependsOn: [...parsed.dependsOn],
      ...(parsed.recurrence !== undefined && { recurrence: parsed.recurrence }),
      onCompletion: parsed.onCompletion,
      onCompletionExplicit: parsed.onCompletionExplicit,
      subtasks: relocatedChildren.subtasks,
      comments: relocatedChildren.comments,
      ...(relocatedChildren.description !== undefined && {
        description: relocatedChildren.description,
      }),
    },
    toLine: children.toLine,
  };
}

function absoluteNodeLine(node: TaskNodeRef): number {
  if (node.type === 'task') return node.ref.line;
  return absoluteNodeLine(node.ref.parent) + node.ref.relativeLine;
}

function relocateSubtask(task: SubtaskSnapshot, parent: TaskNodeRef): SubtaskSnapshot {
  const ref = { ...task.ref, parent };
  const node: TaskNodeRef = { type: 'subtask', ref };
  return {
    ...task,
    ref,
    subtasks: task.subtasks.map((child) => relocateSubtask(child, node)),
    comments: task.comments.map((comment) => ({
      ...comment,
      ref: { ...comment.ref, parent: node },
    })),
  };
}

function relocateChildren(children: ProjectedChildren, parent: TaskNodeRef): ProjectedChildren {
  return {
    ...children,
    subtasks: children.subtasks.map((child) => relocateSubtask(child, parent)),
    comments: children.comments.map((comment) => ({
      ...comment,
      ref: { ...comment.ref, parent },
    })),
  };
}

export function projectTaskSnapshot(projection: TaskSnapshotProjection): TaskSnapshot | undefined {
  const originalMarkdown = projection.lines[projection.line] ?? '';
  const parsed = projection.codec.parseLine(originalMarkdown, {
    filePath: projection.filePath,
    line: projection.line,
  });
  if (parsed == null) return undefined;
  const rootNode: TaskNodeRef = { type: 'task', ref: projection.ref };
  const context: ProjectionContext = projection;
  const children = projectChildren(context, projection.line, rootNode);
  const status =
    parsed.planning.cancelled !== undefined && parsed.planning.cancelled.length > 0
      ? 'cancelled'
      : projection.statusCatalog.statusForSymbol(parsed.statusSymbol);
  return {
    ref: projection.ref,
    title: parsed.title,
    markdownTitle: parsed.markdownTitle,
    status,
    statusSymbol: parsed.statusSymbol,
    priority: parsed.priority,
    planning: planningFrom(parsed.planning),
    tags: [...parsed.tags],
    ...(parsed.dependencyId !== undefined && { dependencyId: parsed.dependencyId }),
    dependsOn: [...parsed.dependsOn],
    ...(parsed.recurrence !== undefined && { recurrence: parsed.recurrence }),
    onCompletion: parsed.onCompletion,
    onCompletionExplicit: parsed.onCompletionExplicit,
    subtasks: children.subtasks,
    comments: children.comments,
    ...(children.description !== undefined && { description: children.description }),
    source: {
      filePath: projection.filePath,
      line: projection.line,
      originalMarkdown,
      originalBlock: projection.exactBlock,
    },
    presentation: {
      ...projection.presentation,
      linkCount: countLinksIn([
        parsed.markdownTitle,
        children.description,
        ...children.comments.map((comment) => comment.text),
      ]),
    },
  };
}
