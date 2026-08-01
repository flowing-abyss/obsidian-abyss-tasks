import type { TaskPriority } from '../tasks/domain/types';
import type {
  ParsedTaskLine,
  SourceSpan,
  TaskSpanKind,
} from '../tasks/infrastructure/markdown/TaskMarkdownCodec';
import {
  isLegacyTaskRecurrenceSpanConsumed,
  legacyTaskRecurrenceFromParsed,
} from './extractMetadata';
import { collapseLinks } from './links';
import type { ParseContext, Task } from './types';

const PRIORITY_MARKER: Readonly<Record<TaskPriority, string>> = {
  A: '🔺',
  B: '⏫',
  C: '🔼',
  D: '',
  E: '🔽',
  F: '⏬',
};
const FIRST_ONLY_KINDS = new Set<TaskSpanKind>([
  'due',
  'scheduled',
  'start',
  'completion',
  'cancelled',
  'time',
  'duration',
  'created',
  'on-completion',
]);

function compatibilityMarkdownTitle(parsed: ParsedTaskLine): string {
  const firstByKind = new Map<TaskSpanKind, SourceSpan>();
  for (const span of parsed.spans) {
    if (!firstByKind.has(span.kind)) firstByKind.set(span.kind, span);
  }

  return parsed.spans
    .map((span) => {
      if (span.kind === 'prefix') return '';
      if (span.kind === 'tag') return '';
      if (isLegacyTaskRecurrenceSpanConsumed(parsed, span)) return '';
      if (FIRST_ONLY_KINDS.has(span.kind)) {
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

/** Internal compatibility projection shared by legacy consumers of a codec parse. */
export function legacyTaskFromParsed(
  parsed: ParsedTaskLine,
  ctx: ParseContext,
  statusForSymbol: (symbol: string) => Task['status'],
): Task {
  const markdownText = compatibilityMarkdownTitle(parsed);
  let status = statusForSymbol(parsed.statusSymbol);
  if (parsed.planning.cancelled !== undefined) status = 'cancelled';

  return {
    filePath: ctx.filePath,
    line: ctx.line,
    rawText: parsed.original,
    text: collapseLinks(markdownText),
    markdownText,
    status,
    statusSymbol: parsed.statusSymbol,
    due: parsed.planning.due,
    scheduled: parsed.planning.scheduled,
    start: parsed.planning.start,
    completion: parsed.planning.completion,
    cancelledDate: parsed.planning.cancelled,
    created: parsed.planning.created,
    time: parsed.planning.time,
    duration: parsed.planning.duration,
    recurrence: legacyTaskRecurrenceFromParsed(parsed),
    onCompletion: parsed.onCompletion,
    onCompletionExplicit: parsed.onCompletionExplicit,
    priority: parsed.priority,
    dailyNoteDate: ctx.dailyNoteDate,
  };
}
