import type { TaskDraft } from '../../application/TaskRepository';
import type { LocalDate, TaskRef } from '../../domain/types';
import type { TaskIssue } from '../../domain/validation';
import { applyTaskCommand } from './applyTaskCommand';
import { TaskBlockEditor } from './TaskBlockEditor';
import { TaskMarkdownCodec, type ParsedTaskLine } from './TaskMarkdownCodec';

const DRAFT_REF: TaskRef = { filePath: '', line: 0, revision: '' };
const editor = new TaskBlockEditor();

function invalid(issues: readonly TaskIssue[]) {
  return { type: 'invalid' as const, issues };
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
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
  if (!firstLater) return `${parsed.original} ➕ ${today}`;
  const before = parsed.original.slice(0, firstLater.from).trimEnd();
  const after = parsed.original.slice(firstLater.from).trimStart();
  return `${before} ➕ ${today} ${after}`;
}

/** Builds, validates, and stamps exactly one root task block without inserting it into a note. */
export function createTaskBlock(
  codec: TaskMarkdownCodec,
  draft: TaskDraft & { readonly today: LocalDate; readonly addCreatedDate: boolean },
):
  | { readonly type: 'created'; readonly content: string }
  | { readonly type: 'invalid'; readonly issues: readonly TaskIssue[] } {
  if (draft.markdownBody.replace(/\r\n/gu, '').includes('\r')) {
    return invalid([{ code: 'invalid-title', field: 'title' }]);
  }
  const body = draft.markdownBody.replace(/\r\n/gu, '\n');
  const [owner, ...nested] = body.split('\n');
  if (owner === undefined || owner.trim().length === 0) {
    return invalid([{ code: 'invalid-title', field: 'title' }]);
  }
  let content = [`- [ ] ${owner}`, ...nested].join('\n');
  const blocks = editor.rootBlocks(content);
  if (
    blocks.length !== 1 ||
    blocks[0]?.line !== 0 ||
    blocks[0].toLine !== content.split('\n').length - 1 ||
    blocks[0].source !== content
  ) {
    return invalid([{ code: 'invalid-task-syntax' }]);
  }

  const sourceLines = content.split('\n');
  for (const sourceLine of sourceLines) {
    const parsed = codec.parseLine(sourceLine, { filePath: '', line: 0 });
    if (!parsed) continue;
    if (parsed.markdownTitle.trim().length === 0) {
      return invalid([{ code: 'invalid-title', field: 'title' }]);
    }
    const issues = [...codec.validateLine(sourceLine), ...createdDateIssues(parsed)];
    if (issues.length > 0) return invalid(issues);
  }

  if (draft.initial !== undefined && Object.keys(draft.initial).length > 0) {
    const initial = applyTaskCommand(codec, sourceLines[0]!, {
      type: 'patch',
      target: { type: 'task', ref: DRAFT_REF },
      patch: draft.initial,
    });
    if (initial.type === 'invalid') return initial;
    sourceLines[0] = initial.content;
    content = sourceLines.join('\n');
  }

  if (draft.initialStatus !== undefined) {
    const status = applyTaskCommand(codec, sourceLines[0]!, {
      type: 'set-status',
      target: { type: 'task', ref: DRAFT_REF },
      symbol: draft.initialStatus.symbol,
      ...(draft.initialStatus.stamp !== undefined && { stamp: draft.initialStatus.stamp }),
      ...(draft.initialStatus.addCompletionDate !== undefined && {
        addCompletionDate: draft.initialStatus.addCompletionDate,
      }),
    });
    if (status.type === 'invalid') return status;
    sourceLines[0] = status.content;
    content = sourceLines.join('\n');
  }

  if (!draft.addCreatedDate) return { type: 'created', content };
  const stamped = content.split('\n').map((sourceLine) => {
    const parsed = codec.parseLine(sourceLine, { filePath: '', line: 0 });
    return parsed ? stampCreatedDate(parsed, draft.today) : sourceLine;
  });
  return { type: 'created', content: stamped.join('\n') };
}
