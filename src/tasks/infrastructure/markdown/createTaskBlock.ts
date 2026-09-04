import type { TaskDraft } from '../../application/TaskRepository';
import type { LocalDate, TaskRef } from '../../domain/types';
import type { TaskIssue } from '../../domain/validation';
import { applyTaskCommand } from './applyTaskCommand';
import { TaskBlockEditor } from './TaskBlockEditor';
import { type ParsedTaskLine, type TaskMarkdownCodec } from './TaskMarkdownCodec';

const DRAFT_REF: TaskRef = { filePath: '', line: 0, revision: '' };
const editor = new TaskBlockEditor();

function invalid(issues: readonly TaskIssue[]): {
  readonly type: 'invalid';
  readonly issues: readonly TaskIssue[];
} {
  return { type: 'invalid' as const, issues };
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match == null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function createdDateIssues(parsed: ParsedTaskLine): readonly TaskIssue[] {
  if ((parsed.occurrences.get('created')?.length ?? 0) > 1) {
    return [{ code: 'duplicate-field', field: 'created' }];
  }
  if (
    (parsed.occurrences.get('created')?.length ?? 0) === 1 &&
    (parsed.planning.created === undefined || !isCalendarDate(parsed.planning.created))
  ) {
    return [{ code: 'invalid-date', field: 'created' }];
  }
  if (
    parsed.spans.some((span) => span.kind === 'malformed-known' && span.malformedKind === 'created')
  ) {
    return [{ code: 'invalid-date', field: 'created' }];
  }
  return [];
}

function stampCreatedDate(parsed: ParsedTaskLine, today: LocalDate): string {
  if (parsed.planning.created !== undefined) return parsed.original;
  const firstLater = parsed.spans.find(
    (span) =>
      span.kind === 'start' ||
      span.kind === 'scheduled' ||
      span.kind === 'due' ||
      span.kind === 'cancelled' ||
      span.kind === 'completion' ||
      span.kind === 'task-id' ||
      span.kind === 'depends-on' ||
      span.kind === 'block-id',
  );
  if (firstLater == null) return `${parsed.original} ➕ ${today}`;
  const before = parsed.original.slice(0, firstLater.from).trimEnd();
  const after = parsed.original.slice(firstLater.from).trimStart();
  return `${before} ➕ ${today} ${after}`;
}

type CreateTaskBlockResult =
  | { readonly type: 'created'; readonly content: string }
  | { readonly type: 'invalid'; readonly issues: readonly TaskIssue[] };

type DraftContentResult =
  | { readonly type: 'content'; readonly content: string }
  | { readonly type: 'invalid'; readonly issues: readonly TaskIssue[] };

function draftContent(markdownBody: string): DraftContentResult {
  if (markdownBody.replace(/\r\n/gu, '').includes('\r')) {
    return invalid([{ code: 'invalid-title', field: 'title' }]);
  }
  const [owner, ...nested] = markdownBody.replace(/\r\n/gu, '\n').split('\n');
  if (owner === undefined || owner.trim().length === 0) {
    return invalid([{ code: 'invalid-title', field: 'title' }]);
  }
  return { type: 'content', content: [`- [ ] ${owner}`, ...nested].join('\n') };
}

function validRootBlock(content: string): boolean {
  const blocks = editor.rootBlocks(content);
  const block = blocks[0];
  return (
    blocks.length === 1 &&
    block?.line === 0 &&
    block.toLine === content.split('\n').length - 1 &&
    block.source === content
  );
}

function validateSourceLines(
  codec: TaskMarkdownCodec,
  sourceLines: readonly string[],
): CreateTaskBlockResult | undefined {
  for (const sourceLine of sourceLines) {
    const parsed = codec.parseLine(sourceLine, { filePath: '', line: 0 });
    if (parsed == null) continue;
    if (parsed.markdownTitle.trim().length === 0) {
      return invalid([{ code: 'invalid-title', field: 'title' }]);
    }
    const issues = [...codec.validateLine(sourceLine), ...createdDateIssues(parsed)];
    if (issues.length > 0) return invalid(issues);
  }
  return undefined;
}

function applyInitialPatch(
  codec: TaskMarkdownCodec,
  sourceLines: string[],
  initial: TaskDraft['initial'],
): CreateTaskBlockResult | undefined {
  if (initial === undefined || Object.keys(initial).length === 0) return undefined;
  const ownerLine = sourceLines[0];
  if (ownerLine === undefined) return invalid([{ code: 'invalid-task-syntax' }]);
  const result = applyTaskCommand(codec, ownerLine, {
    type: 'patch',
    target: { type: 'task', ref: DRAFT_REF },
    patch: initial,
  });
  if (result.type === 'invalid') return result;
  sourceLines[0] = result.content;
  return undefined;
}

function stampSourceLines(
  codec: TaskMarkdownCodec,
  sourceLines: readonly string[],
  today: LocalDate,
): string {
  return sourceLines
    .map((sourceLine) => {
      const parsed = codec.parseLine(sourceLine, { filePath: '', line: 0 });
      return parsed != null ? stampCreatedDate(parsed, today) : sourceLine;
    })
    .join('\n');
}

/** Builds, validates, and stamps exactly one root task block without inserting it into a note. */
export function createTaskBlock(
  codec: TaskMarkdownCodec,
  draft: TaskDraft & { readonly today: LocalDate; readonly addCreatedDate: boolean },
): CreateTaskBlockResult {
  const content = draftContent(draft.markdownBody);
  if (content.type === 'invalid') return content;
  if (!validRootBlock(content.content)) return invalid([{ code: 'invalid-task-syntax' }]);
  const sourceLines = content.content.split('\n');
  const validation = validateSourceLines(codec, sourceLines);
  if (validation !== undefined) return validation;
  const patch = applyInitialPatch(codec, sourceLines, draft.initial);
  if (patch !== undefined) return patch;
  const updated = sourceLines.join('\n');
  return {
    type: 'created',
    content: draft.addCreatedDate ? stampSourceLines(codec, sourceLines, draft.today) : updated,
  };
}
