import { collapseLinks } from '../markdown/links';
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

function legacyPlanningFields(parsed: ParsedTaskLine): Partial<Task> {
  return {
    ...(parsed.planning.due !== undefined && { due: parsed.planning.due }),
    ...(parsed.planning.scheduled !== undefined && { scheduled: parsed.planning.scheduled }),
    ...(parsed.planning.start !== undefined && { start: parsed.planning.start }),
    ...(parsed.planning.completion !== undefined && { completion: parsed.planning.completion }),
    ...(parsed.planning.cancelled !== undefined && {
      cancelledDate: parsed.planning.cancelled,
    }),
    ...(parsed.planning.created !== undefined && { created: parsed.planning.created }),
    ...(parsed.planning.time !== undefined && { time: parsed.planning.time }),
    ...(parsed.planning.duration !== undefined && { duration: parsed.planning.duration }),
  };
}

function legacyContextFields(ctx: ParseContext, recurrence: string | undefined): Partial<Task> {
  return {
    ...(recurrence !== undefined && { recurrence }),
    ...(ctx.dailyNoteDate !== undefined && { dailyNoteDate: ctx.dailyNoteDate }),
  };
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
  const recurrence = legacyTaskRecurrenceFromParsed(parsed);

  return {
    filePath: ctx.filePath,
    line: ctx.line,
    rawText: parsed.original,
    text: collapseLinks(markdownText),
    markdownText,
    status,
    statusSymbol: parsed.statusSymbol,
    ...legacyPlanningFields(parsed),
    ...legacyContextFields(ctx, recurrence),
    onCompletion: parsed.onCompletion,
    onCompletionExplicit: parsed.onCompletionExplicit,
    priority: parsed.priority,
  };
}
