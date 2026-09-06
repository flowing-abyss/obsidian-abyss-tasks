import type { DependencyDirection } from '../../domain/taskDependencies';
import { isTaskDependencyId } from '../../domain/taskLineSourceModel';
import type { LocalDate } from '../../domain/types';
import type { TaskIssue } from '../../domain/validation';
import type { ParsedTaskLine, TaskMarkdownCodec } from './TaskMarkdownCodec';

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

export function createdDateIssues(parsed: ParsedTaskLine): readonly TaskIssue[] {
  if ((parsed.occurrences.get('created')?.length ?? 0) > 1)
    return [{ code: 'duplicate-field', field: 'created' }];
  if (
    ((parsed.occurrences.get('created')?.length ?? 0) === 1 &&
      (parsed.planning.created === undefined || !isCalendarDate(parsed.planning.created))) ||
    parsed.spans.some((span) => span.kind === 'malformed-known' && span.malformedKind === 'created')
  )
    return [{ code: 'invalid-date', field: 'created' }];
  return [];
}

export function stampCreatedDate(parsed: ParsedTaskLine, today: LocalDate): string {
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

/** The single-line creation path shares validation and lifecycle stamping with root capture. */
function createTaskLine(
  codec: TaskMarkdownCodec,
  text: string,
  createdDate?: LocalDate,
): string | undefined {
  if (text.trim().length === 0 || /[\r\n]/u.test(text)) return undefined;
  const source = `- [ ] ${text}`;
  const parsed = codec.parseLine(source, { filePath: '', line: 0 });
  if (
    parsed == null ||
    parsed.markdownTitle.trim().length === 0 ||
    codec.validateLine(source).length > 0 ||
    createdDateIssues(parsed).length > 0
  )
    return undefined;
  return createdDate === undefined ? source : stampCreatedDate(parsed, createdDate);
}

interface LinkedTaskInput {
  readonly text: string;
  readonly direction: DependencyDirection;
  readonly currentId?: string;
  readonly childId?: string;
  readonly createdDate?: LocalDate;
}

function blockerId(parsed: ParsedTaskLine, input: LinkedTaskInput): string | undefined {
  const id =
    input.direction === 'blocked-by' ? input.childId : (parsed.dependencyId ?? input.currentId);
  if (
    id === undefined ||
    !isTaskDependencyId(id) ||
    (input.direction === 'blocks' &&
      parsed.dependencyId !== undefined &&
      input.currentId !== undefined &&
      parsed.dependencyId !== input.currentId)
  )
    return undefined;
  return id;
}

export function createLinkedTaskLines(
  codec: TaskMarkdownCodec,
  current: string,
  input: LinkedTaskInput,
): { readonly current: string; readonly child: string } | undefined {
  if (/[🆔⛔]/u.test(input.text)) return undefined;
  const child = createTaskLine(codec, input.text, input.createdDate);
  const parsed = codec.parseLine(current, { filePath: '', line: 0 });
  if (child === undefined || parsed === null) return undefined;
  const id = blockerId(parsed, input);
  if (id === undefined) return undefined;
  const currentEdit = codec.applyLineEdit(
    current,
    input.direction === 'blocked-by'
      ? { type: 'set-depends-on', values: [...parsed.dependsOn, id] }
      : { type: 'set-dependency-id', value: id },
  );
  const childEdit = codec.applyLineEdit(
    child,
    input.direction === 'blocked-by'
      ? { type: 'set-dependency-id', value: id }
      : { type: 'set-depends-on', values: [id] },
  );
  return currentEdit.type === 'invalid' || childEdit.type === 'invalid'
    ? undefined
    : { current: currentEdit.content, child: childEdit.content };
}
