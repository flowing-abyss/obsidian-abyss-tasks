import { StatusCatalog } from '../tasks/domain/StatusCatalog';
import type { TaskPriority } from '../tasks/domain/types';
import {
  TaskMarkdownCodec,
  type ParsedTaskLine,
  type SourceSpan,
  type TaskSpanKind,
} from '../tasks/infrastructure/markdown/TaskMarkdownCodec';

export interface ExtractedMetadata {
  due?: string;
  scheduled?: string;
  start?: string;
  completion?: string;
  cancelledDate?: string;
  created?: string;
  time?: string;
  recurrence?: string;
  onCompletion: 'keep' | 'delete';
  onCompletionExplicit: boolean;
  priority: TaskPriority;
  cleanText: string;
}

const CODEC = new TaskMarkdownCodec(new StatusCatalog([]));
const SYNTHETIC_PREFIX = '- [ ] ';
const PRIORITY_MARKER: Readonly<Record<TaskPriority, string>> = {
  A: '🔺',
  B: '⏫',
  C: '🔼',
  D: '',
  E: '🔽',
  F: '⏬',
};
const EXTRACTOR_REMOVED_BEFORE_RECURRENCE = new Set<TaskSpanKind>([
  'due',
  'scheduled',
  'start',
  'completion',
  'cancelled',
  'time',
]);
const TASK_PARSER_REMOVED_BEFORE_RECURRENCE = new Set<TaskSpanKind>([
  ...EXTRACTOR_REMOVED_BEFORE_RECURRENCE,
  'duration',
]);
const LEGACY_VISIBLE_CARRIER_KINDS = new Set<TaskSpanKind>(['task-id', 'depends-on', 'block-id']);

interface LegacyRecurrencePolicy {
  readonly removedBeforeRecurrence: ReadonlySet<TaskSpanKind>;
}

const EXTRACTOR_RECURRENCE_POLICY: LegacyRecurrencePolicy = {
  removedBeforeRecurrence: EXTRACTOR_REMOVED_BEFORE_RECURRENCE,
};
const TASK_PARSER_RECURRENCE_POLICY: LegacyRecurrencePolicy = {
  removedBeforeRecurrence: TASK_PARSER_REMOVED_BEFORE_RECURRENCE,
};

/** Reproduce the old extractor's recurrence value from the codec's lossless spans. */
function legacyRecurrenceProjection(
  parsed: ParsedTaskLine,
  policy: LegacyRecurrencePolicy,
): { value: string | undefined; consumedTo: number } | undefined {
  const recurrence = parsed.occurrences.get('recurrence')?.[0];
  if (!recurrence) return undefined;

  const firstByKind = new Map<TaskSpanKind, SourceSpan>();
  for (const span of parsed.spans) {
    if (!firstByKind.has(span.kind)) firstByKind.set(span.kind, span);
  }

  let value = parsed.original.slice(recurrence.from + '🔁'.length, recurrence.to);
  let consumedTo = recurrence.to;
  for (const span of parsed.spans) {
    if (span.from < recurrence.to) continue;
    if (span.kind === 'priority' || span.kind === 'on-completion') break;
    if (policy.removedBeforeRecurrence.has(span.kind)) {
      if (firstByKind.get(span.kind) === span) {
        consumedTo = span.to;
        continue;
      }
      break;
    }
    value += parsed.original.slice(span.from, span.to);
    consumedTo = span.to;
  }
  return { value: value.trim() || undefined, consumedTo };
}

/** Reproduce the old extractor's recurrence value from the codec's lossless spans. */
function legacyRecurrenceFromParsed(parsed: ParsedTaskLine): string | undefined {
  return legacyRecurrenceProjection(parsed, EXTRACTOR_RECURRENCE_POLICY)?.value;
}

/** Reproduce the old parent-task parser's recurrence value after duration extraction. */
export function legacyTaskRecurrenceFromParsed(parsed: ParsedTaskLine): string | undefined {
  return legacyRecurrenceProjection(parsed, TASK_PARSER_RECURRENCE_POLICY)?.value;
}

function isLegacyRecurrenceSpanConsumedBy(
  parsed: ParsedTaskLine,
  span: SourceSpan,
  policy: LegacyRecurrencePolicy,
): boolean {
  const first = parsed.occurrences.get('recurrence')?.[0];
  const projection = legacyRecurrenceProjection(parsed, policy);
  return (
    first !== undefined &&
    projection !== undefined &&
    span.from >= first.from &&
    span.from < projection.consumedTo &&
    span.kind !== 'separator' &&
    !LEGACY_VISIBLE_CARRIER_KINDS.has(span.kind)
  );
}

/** Whether the old extractor's greedy recurrence match hid this span from visible text. */
function isLegacyRecurrenceSpanConsumed(parsed: ParsedTaskLine, span: SourceSpan): boolean {
  return isLegacyRecurrenceSpanConsumedBy(parsed, span, EXTRACTOR_RECURRENCE_POLICY);
}

/** Whether the old parent parser's greedy recurrence match hid this span from visible text. */
export function isLegacyTaskRecurrenceSpanConsumed(
  parsed: ParsedTaskLine,
  span: SourceSpan,
): boolean {
  return isLegacyRecurrenceSpanConsumedBy(parsed, span, TASK_PARSER_RECURRENCE_POLICY);
}

function legacyCleanText(parsed: ParsedTaskLine): string {
  const firstByKind = new Map<TaskSpanKind, SourceSpan>();
  for (const span of parsed.spans) {
    if (!firstByKind.has(span.kind)) firstByKind.set(span.kind, span);
  }

  return parsed.spans
    .map((span) => {
      if (span.kind === 'prefix' || span.kind === 'tag') return '';
      if (span.kind === 'created' || span.kind === 'on-completion') return '';
      if (isLegacyRecurrenceSpanConsumed(parsed, span)) return '';
      if (EXTRACTOR_REMOVED_BEFORE_RECURRENCE.has(span.kind)) {
        return firstByKind.get(span.kind) === span ? '' : parsed.original.slice(span.from, span.to);
      }
      if (span.kind === 'priority') {
        const marker = parsed.original.slice(span.from, span.to);
        return marker === PRIORITY_MARKER[parsed.priority] ? '' : marker;
      }
      return parsed.original.slice(span.from, span.to);
    })
    .join('')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

/** Compatibility projection for legacy callers that parse a task title body. */
export function extractMetadata(text: string): ExtractedMetadata {
  const parsed = CODEC.parseLine(SYNTHETIC_PREFIX + text, { filePath: '', line: 0 });
  if (!parsed) {
    return {
      priority: 'D',
      onCompletion: 'keep',
      onCompletionExplicit: false,
      cleanText: text,
    };
  }

  return {
    due: parsed.planning.due,
    scheduled: parsed.planning.scheduled,
    start: parsed.planning.start,
    completion: parsed.planning.completion,
    cancelledDate: parsed.planning.cancelled,
    created: parsed.planning.created,
    time: parsed.planning.time,
    recurrence: legacyRecurrenceFromParsed(parsed),
    onCompletion: parsed.onCompletion,
    onCompletionExplicit: parsed.onCompletionExplicit,
    priority: parsed.priority,
    cleanText: legacyCleanText(parsed),
  };
}
