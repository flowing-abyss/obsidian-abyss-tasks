import type { TaskEditCommand } from '../../application/TaskRepository';
import type { FieldUpdate, TaskPatch } from '../../domain/commands';
import { shiftLocalDate } from '../../domain/localDateMath';
import { isSingleLineText, localDate, type TaskValidationField } from '../../domain/validation';
import {
  type LineEdit,
  type LineEditResult,
  type ParsedTaskLine,
  type TaskMarkdownCodec,
} from './TaskMarkdownCodec';

type SchedulingDateField = 'due' | 'scheduled' | 'start';

function fieldEdit(field: SchedulingDateField, update: FieldUpdate<string>): LineEdit {
  return {
    type: 'set-date',
    field,
    value: update.type === 'set' ? update.value : null,
  };
}

function recurrenceEdits(patch: TaskPatch): readonly LineEdit[] {
  const edits: LineEdit[] = [];
  if (patch.recurrence != null) {
    edits.push({
      type: 'set-recurrence',
      value: patch.recurrence.type === 'set' ? patch.recurrence.value : null,
    });
  }
  if (patch.onCompletion != null) {
    edits.push({
      type: 'set-on-completion',
      value: patch.onCompletion.type === 'set' ? patch.onCompletion.value : null,
    });
  }
  return edits;
}

function titleAndPriorityEdits(patch: TaskPatch): LineEdit[] {
  const edits: LineEdit[] = [];
  if (patch.markdownTitle != null) {
    edits.push({
      type: 'set-title',
      markdownTitle: patch.markdownTitle.type === 'set' ? patch.markdownTitle.value : '',
    });
  }
  if (patch.priority != null) {
    edits.push({
      type: 'set-priority',
      priority: patch.priority.type === 'set' ? patch.priority.value : 'D',
    });
  }
  return edits;
}

function scheduledPatchEdits(parsed: ParsedTaskLine, patch: TaskPatch): LineEdit[] {
  const edits = clearedAndScheduledEdits(patch);
  const start = patch.start?.type === 'set' ? patch.start : undefined;
  const due = patch.due?.type === 'set' ? patch.due : undefined;
  const currentDue = parsed.planning.due;
  const ordered = dueBeforeStart(start, due, currentDue);
  if (ordered != null) {
    edits.push(fieldEdit('due', ordered.due), fieldEdit('start', ordered.start));
    return edits;
  }
  if (start != null) edits.push(fieldEdit('start', start));
  if (due != null) edits.push(fieldEdit('due', due));
  return edits;
}

function dueBeforeStart(
  start: FieldUpdate<string> | undefined,
  due: FieldUpdate<string> | undefined,
  currentDue: string | undefined,
): { start: FieldUpdate<string>; due: FieldUpdate<string> } | undefined {
  const needsReorder =
    start?.type === 'set' && due?.type === 'set' && currentDue != null && start.value > currentDue;
  return needsReorder ? { start, due } : undefined;
}

function clearedAndScheduledEdits(patch: TaskPatch): LineEdit[] {
  const edits: LineEdit[] = [];
  if (patch.scheduled != null) edits.push(fieldEdit('scheduled', patch.scheduled));
  if (patch.start?.type === 'clear') edits.push(fieldEdit('start', patch.start));
  if (patch.due?.type === 'clear') edits.push(fieldEdit('due', patch.due));
  return edits;
}

function timeAndDurationEdits(patch: TaskPatch): LineEdit[] {
  const edits: LineEdit[] = [];
  if (patch.time != null) {
    edits.push({ type: 'set-time', value: patch.time.type === 'set' ? patch.time.value : null });
  }
  if (patch.duration != null) {
    edits.push({
      type: 'set-duration',
      value: patch.duration.type === 'set' ? patch.duration.value : null,
    });
  }
  return edits;
}

function tagEdits(patch: TaskPatch): LineEdit[] {
  return patch.tags == null
    ? []
    : [{ type: 'change-tags', add: patch.tags.add ?? [], remove: patch.tags.remove ?? [] }];
}

function orderedPatchEdits(parsed: ParsedTaskLine, patch: TaskPatch): readonly LineEdit[] {
  return [
    ...titleAndPriorityEdits(patch),
    ...scheduledPatchEdits(parsed, patch),
    ...timeAndDurationEdits(patch),
    ...recurrenceEdits(patch),
    ...tagEdits(patch),
  ];
}

function anchorDateField(parsed: ParsedTaskLine): 'scheduled' | 'due' {
  return parsed.planning.scheduled !== undefined && parsed.planning.scheduled.length > 0
    ? 'scheduled'
    : 'due';
}

function semanticSchedulingFields(
  parsed: ParsedTaskLine,
  anchor: 'scheduled' | 'due',
): readonly SchedulingDateField[] {
  return parsed.planning.start !== undefined && parsed.planning.due !== undefined
    ? [anchor, 'start', 'due']
    : [anchor];
}

type SchedulingEditPlan = {
  readonly edits: readonly LineEdit[];
  readonly requestedFields: readonly TaskValidationField[];
};

function parsedLocalDate(value: string): ReturnType<typeof localDate> | undefined {
  try {
    return localDate(value);
  } catch {
    return undefined;
  }
}

function shiftScheduleEditPlan(
  parsed: ParsedTaskLine,
  days: number,
  allowZero = false,
): SchedulingEditPlan | LineEditResult {
  if (!Number.isSafeInteger(days) || (!allowZero && days === 0)) {
    return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'days' }] };
  }
  const { start, due } = parsed.planning;
  if (start != null && start.length > 0 && due != null && due.length > 0)
    return shiftedSpanPlan(start, due, days);
  return shiftedAnchorPlan(parsed, days);
}

function invalidScheduleDate(): LineEditResult {
  return { type: 'invalid', issues: [{ code: 'invalid-date', field: 'schedule' }] };
}

function shiftedSpanPlan(
  startValue: string,
  dueValue: string,
  days: number,
): SchedulingEditPlan | LineEditResult {
  const startDate = parsedLocalDate(startValue);
  const dueDate = parsedLocalDate(dueValue);
  if (startDate == null || dueDate == null) return invalidScheduleDate();
  const start = shiftLocalDate(startDate, days);
  const due = shiftLocalDate(dueDate, days);
  if (start == null || due == null) return invalidScheduleDate();
  return {
    requestedFields: ['start', 'due'],
    edits: [
      fieldEdit('start', { type: 'set', value: start }),
      fieldEdit('due', { type: 'set', value: due }),
    ],
  };
}

function shiftedAnchorPlan(
  parsed: ParsedTaskLine,
  days: number,
): SchedulingEditPlan | LineEditResult {
  const field =
    parsed.planning.scheduled !== undefined && parsed.planning.scheduled.length > 0
      ? 'scheduled'
      : 'due';
  const value = parsed.planning[field];
  if (value === undefined || value.length === 0) {
    return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'schedule' }] };
  }
  const date = parsedLocalDate(value);
  if (date == null) return invalidScheduleDate();
  const shifted = shiftLocalDate(date, days);
  if (shifted == null) return invalidScheduleDate();
  return {
    requestedFields: [field],
    edits: [fieldEdit(field, { type: 'set', value: shifted })],
  };
}

type CommandPlan = SchedulingEditPlan | LineEditResult;

function patchPlan(parsed: ParsedTaskLine, command: TaskEditCommand): CommandPlan | undefined {
  if (command.type !== 'patch') return undefined;
  if (patchHasInvertedSpan(command.patch))
    return { type: 'invalid', issues: [{ code: 'inverted-span', field: 'start,due' }] };
  if (subtaskPatchHasDuration(command))
    return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'duration' }] };
  return { edits: orderedPatchEdits(parsed, command.patch), requestedFields: [] };
}

function patchHasInvertedSpan(patch: TaskPatch): boolean {
  const start = patch.start?.type === 'set' ? patch.start.value : undefined;
  const due = patch.due?.type === 'set' ? patch.due.value : undefined;
  return start != null && due != null && start > due;
}

function subtaskPatchHasDuration(
  command: Extract<TaskEditCommand, { readonly type: 'patch' }>,
): boolean {
  return command.target.type === 'subtask' && 'duration' in command.patch;
}

function basicPlan(command: TaskEditCommand): CommandPlan | undefined {
  if (command.type === 'append-title')
    return { edits: [{ type: 'append-title', markdown: command.markdown }], requestedFields: [] };
  if (command.type === 'edit-link') {
    if (command.target.type !== 'title')
      return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'link' }] };
    return {
      edits: [
        { type: 'edit-link', occurrence: command.occurrence, replacement: command.replacement },
      ],
      requestedFields: [],
    };
  }
  if (command.type !== 'set-status') return undefined;
  return {
    edits: [
      {
        type: 'set-status',
        symbol: command.symbol,
        ...(command.stamp !== undefined && { today: command.stamp }),
        ...(command.addCompletionDate !== undefined && {
          addCompletionDate: command.addCompletionDate,
        }),
      },
    ],
    requestedFields: [],
  };
}

function dependencyPlan(command: TaskEditCommand): CommandPlan | undefined {
  if (command.type === 'set-dependency-id') {
    return {
      edits: [{ type: 'set-dependency-id', value: command.id.length === 0 ? null : command.id }],
      requestedFields: [],
    };
  }
  if (command.type === 'set-depends-on') {
    return {
      edits: [{ type: 'set-depends-on', values: command.ids }],
      requestedFields: [],
    };
  }
  return undefined;
}

function restoreDependencySource(
  codec: TaskMarkdownCodec,
  current: ParsedTaskLine,
  source: string,
  ids: readonly string[],
): LineEditResult {
  const before = isSingleLineText(source)
    ? codec.parseLine(source, { filePath: '', line: 0 })
    : null;
  if (
    before?.dependsOn.length !== ids.length ||
    !before.dependsOn.every((id, index) => id === ids[index])
  )
    return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'depends-on' }] };
  const removed = codec.applyLineEdit(source, {
    type: 'set-depends-on',
    values: current.dependsOn,
  });
  // Replaying the original metadata edit must account for every restored byte.
  if (removed.type === 'invalid' || removed.content !== current.original)
    return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'depends-on' }] };
  return { type: source === current.original ? 'unchanged' : 'changed', content: source };
}

function schedulingPlan(parsed: ParsedTaskLine, command: TaskEditCommand): CommandPlan | undefined {
  if (command.type === 'reschedule') {
    const field = anchorDateField(parsed);
    return {
      requestedFields: semanticSchedulingFields(parsed, field),
      edits: [{ type: 'set-date', field, value: command.date }],
    };
  }
  if (command.type === 'shift-schedule') return shiftScheduleEditPlan(parsed, command.days);
  if (command.type === 'move-time-slot') {
    const plan = shiftScheduleEditPlan(parsed, command.days, true);
    return 'type' in plan
      ? plan
      : {
          requestedFields: [...plan.requestedFields, 'time'],
          edits: [...plan.edits, { type: 'set-time', value: command.time }],
        };
  }
  if (command.type === 'move-to-all-day') return moveToAllDayPlan(parsed, command.days);
  if (command.type === 'set-time-slot') return setTimeSlotPlan(parsed, command);
  if (command.type === 'convert-to-all-day') return convertToAllDayPlan(parsed, command.date);
  return undefined;
}

function moveToAllDayPlan(parsed: ParsedTaskLine, days: number): CommandPlan {
  const plan = shiftScheduleEditPlan(parsed, days, true);
  return 'type' in plan
    ? plan
    : {
        requestedFields: [...plan.requestedFields, 'time', 'duration'],
        edits: [
          ...plan.edits,
          { type: 'set-time', value: null },
          { type: 'set-duration', value: null },
        ],
      };
}

function setTimeSlotPlan(
  parsed: ParsedTaskLine,
  command: Extract<TaskEditCommand, { readonly type: 'set-time-slot' }>,
): SchedulingEditPlan {
  const field = anchorDateField(parsed);
  return {
    requestedFields: semanticSchedulingFields(parsed, field),
    edits: [
      { type: 'set-date', field, value: command.date },
      { type: 'set-time', value: command.time },
      ...(command.duration === undefined
        ? []
        : ([{ type: 'set-duration', value: command.duration }] as const)),
    ],
  };
}

function convertToAllDayPlan(parsed: ParsedTaskLine, date: string): SchedulingEditPlan {
  const field = anchorDateField(parsed);
  return {
    requestedFields: semanticSchedulingFields(parsed, field),
    edits: [
      { type: 'set-date', field, value: date },
      { type: 'set-time', value: null },
      { type: 'set-duration', value: null },
    ],
  };
}

function spanPlan(parsed: ParsedTaskLine, command: TaskEditCommand): CommandPlan | undefined {
  if (command.type === 'set-span-boundary')
    return {
      requestedFields: [command.boundary],
      edits: [{ type: 'set-date', field: command.boundary, value: command.date }],
    };
  if (command.type !== 'extend-span') return undefined;
  const anchor = parsed.planning.start ?? parsed.planning.scheduled ?? parsed.planning.due;
  if (anchor == null || anchor.length === 0)
    return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'span-anchor' }] };
  return {
    requestedFields: ['start', 'due'],
    edits: [
      ...(parsed.planning.start != null && parsed.planning.start.length > 0
        ? []
        : ([{ type: 'set-date', field: 'start', value: anchor }] as const)),
      { type: 'set-date', field: 'due', value: command.due },
    ],
  };
}

function commandPlan(parsed: ParsedTaskLine, command: TaskEditCommand): CommandPlan {
  return (
    patchPlan(parsed, command) ??
    dependencyPlan(command) ??
    basicPlan(command) ??
    schedulingPlan(parsed, command) ??
    spanPlan(parsed, command) ?? {
      type: 'invalid',
      issues: [{ code: 'invalid-target', field: 'block' }],
    }
  );
}

/** Applies one planning command to a task line without exposing transient intermediate states. */
export function applyTaskCommand(
  codec: TaskMarkdownCodec,
  sourceLine: string,
  command: TaskEditCommand,
): LineEditResult {
  const parsed = codec.parseLine(sourceLine, { filePath: '', line: 0 });
  if (parsed == null) return { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };
  if (command.type === 'set-depends-on' && command.restoreSource !== undefined)
    return restoreDependencySource(codec, parsed, command.restoreSource, command.ids);
  const plan = commandPlan(parsed, command);
  return 'type' in plan ? plan : codec.applyLineEdits(sourceLine, plan.edits, plan.requestedFields);
}
