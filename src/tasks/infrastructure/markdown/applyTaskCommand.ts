import type { TaskEditCommand } from '../../application/TaskRepository';
import type { FieldUpdate, TaskPatch } from '../../domain/commands';
import { shiftLocalDate } from '../../domain/localDateMath';
import { localDate, type TaskValidationField } from '../../domain/validation';
import {
  TaskMarkdownCodec,
  type LineEdit,
  type LineEditResult,
  type ParsedTaskLine,
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
  if (patch.recurrence) {
    edits.push({
      type: 'set-recurrence',
      value: patch.recurrence.type === 'set' ? patch.recurrence.value : null,
    });
  }
  if (patch.onCompletion) {
    edits.push({
      type: 'set-on-completion',
      value: patch.onCompletion.type === 'set' ? patch.onCompletion.value : null,
    });
  }
  return edits;
}

function orderedPatchEdits(parsed: ParsedTaskLine, patch: TaskPatch): readonly LineEdit[] {
  const edits: LineEdit[] = [];
  if (patch.markdownTitle) {
    edits.push({
      type: 'set-title',
      markdownTitle: patch.markdownTitle.type === 'set' ? patch.markdownTitle.value : '',
    });
  }
  if (patch.priority) {
    edits.push({
      type: 'set-priority',
      priority: patch.priority.type === 'set' ? patch.priority.value : 'D',
    });
  }
  if (patch.scheduled) edits.push(fieldEdit('scheduled', patch.scheduled));

  if (patch.start?.type === 'clear') edits.push(fieldEdit('start', patch.start));
  if (patch.due?.type === 'clear') edits.push(fieldEdit('due', patch.due));

  const start = patch.start?.type === 'set' ? patch.start : undefined;
  const due = patch.due?.type === 'set' ? patch.due : undefined;
  if (start && due && parsed.planning.due !== undefined && start.value > parsed.planning.due) {
    edits.push(fieldEdit('due', due), fieldEdit('start', start));
  } else {
    if (start) edits.push(fieldEdit('start', start));
    if (due) edits.push(fieldEdit('due', due));
  }
  if (patch.time) {
    edits.push({
      type: 'set-time',
      value: patch.time.type === 'set' ? patch.time.value : null,
    });
  }
  if (patch.duration) {
    edits.push({
      type: 'set-duration',
      value: patch.duration.type === 'set' ? patch.duration.value : null,
    });
  }
  edits.push(...recurrenceEdits(patch));
  if (patch.tags) {
    edits.push({
      type: 'change-tags',
      add: patch.tags.add ?? [],
      remove: patch.tags.remove ?? [],
    });
  }
  return edits;
}

function anchorDateField(parsed: ParsedTaskLine): 'scheduled' | 'due' {
  return parsed.planning.scheduled ? 'scheduled' : 'due';
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

function parsedLocalDate(value: string) {
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
  if (parsed.planning.start && parsed.planning.due) {
    const startDate = parsedLocalDate(parsed.planning.start);
    const dueDate = parsedLocalDate(parsed.planning.due);
    if (!startDate || !dueDate) {
      return { type: 'invalid', issues: [{ code: 'invalid-date', field: 'schedule' }] };
    }
    const start = shiftLocalDate(startDate, days);
    const due = shiftLocalDate(dueDate, days);
    if (!start || !due) {
      return { type: 'invalid', issues: [{ code: 'invalid-date', field: 'schedule' }] };
    }
    return {
      requestedFields: ['start', 'due'],
      edits: [
        fieldEdit('start', { type: 'set', value: start }),
        fieldEdit('due', { type: 'set', value: due }),
      ],
    };
  }
  const field = parsed.planning.scheduled ? 'scheduled' : 'due';
  const value = parsed.planning[field];
  if (!value) {
    return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'schedule' }] };
  }
  const date = parsedLocalDate(value);
  if (!date) {
    return { type: 'invalid', issues: [{ code: 'invalid-date', field: 'schedule' }] };
  }
  const shifted = shiftLocalDate(date, days);
  if (!shifted) {
    return { type: 'invalid', issues: [{ code: 'invalid-date', field: 'schedule' }] };
  }
  return {
    requestedFields: [field],
    edits: [fieldEdit(field, { type: 'set', value: shifted })],
  };
}

/** Applies one planning command to a task line without exposing transient intermediate states. */
export function applyTaskCommand(
  codec: TaskMarkdownCodec,
  sourceLine: string,
  command: TaskEditCommand,
): LineEditResult {
  const parsed = codec.parseLine(sourceLine, { filePath: '', line: 0 });
  if (!parsed) return { type: 'invalid', issues: [{ code: 'invalid-task-syntax' }] };

  let edits: readonly LineEdit[];
  let requestedFields: readonly TaskValidationField[] = [];
  switch (command.type) {
    case 'patch': {
      const start = command.patch.start?.type === 'set' ? command.patch.start.value : undefined;
      const due = command.patch.due?.type === 'set' ? command.patch.due.value : undefined;
      if (start !== undefined && due !== undefined && start > due) {
        return { type: 'invalid', issues: [{ code: 'inverted-span', field: 'start,due' }] };
      }
      if (command.target.type === 'subtask' && 'duration' in command.patch) {
        return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'duration' }] };
      }
      edits = orderedPatchEdits(parsed, command.patch);
      break;
    }
    case 'append-title':
      edits = [{ type: 'append-title', markdown: command.markdown }];
      break;
    case 'edit-link':
      if (command.target.type !== 'title') {
        return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'link' }] };
      }
      edits = [
        {
          type: 'edit-link',
          occurrence: command.occurrence,
          replacement: command.replacement,
        },
      ];
      break;
    case 'set-status':
      edits = [
        {
          type: 'set-status',
          symbol: command.symbol,
          ...(command.stamp !== undefined && { today: command.stamp }),
          ...(command.addCompletionDate !== undefined && {
            addCompletionDate: command.addCompletionDate,
          }),
        },
      ];
      break;
    case 'reschedule': {
      const field = anchorDateField(parsed);
      requestedFields = semanticSchedulingFields(parsed, field);
      edits = [{ type: 'set-date', field, value: command.date }];
      break;
    }
    case 'shift-schedule': {
      const plan = shiftScheduleEditPlan(parsed, command.days);
      if ('type' in plan) return plan;
      requestedFields = plan.requestedFields;
      edits = plan.edits;
      break;
    }
    case 'move-time-slot': {
      const plan = shiftScheduleEditPlan(parsed, command.days, true);
      if ('type' in plan) return plan;
      requestedFields = [...plan.requestedFields, 'time'];
      edits = [...plan.edits, { type: 'set-time', value: command.time }];
      break;
    }
    case 'move-to-all-day': {
      const plan = shiftScheduleEditPlan(parsed, command.days, true);
      if ('type' in plan) return plan;
      requestedFields = [...plan.requestedFields, 'time', 'duration'];
      edits = [
        ...plan.edits,
        { type: 'set-time', value: null },
        { type: 'set-duration', value: null },
      ];
      break;
    }
    case 'set-time-slot': {
      const field = anchorDateField(parsed);
      requestedFields = semanticSchedulingFields(parsed, field);
      edits = [
        { type: 'set-date', field, value: command.date },
        { type: 'set-time', value: command.time },
        ...(command.duration === undefined
          ? []
          : ([{ type: 'set-duration', value: command.duration }] as const)),
      ];
      break;
    }
    case 'convert-to-all-day': {
      const field = anchorDateField(parsed);
      requestedFields = semanticSchedulingFields(parsed, field);
      edits = [
        { type: 'set-date', field, value: command.date },
        { type: 'set-time', value: null },
        { type: 'set-duration', value: null },
      ];
      break;
    }
    case 'set-task-id':
      edits = [{ type: 'set-task-id', id: command.id }];
      break;
    case 'set-task-dependency':
      edits = [
        {
          type: 'set-task-dependency',
          dependencyId: command.dependencyId,
          enabled: command.enabled,
        },
      ];
      break;
    case 'set-span-boundary':
      requestedFields = [command.boundary];
      edits = [{ type: 'set-date', field: command.boundary, value: command.date }];
      break;
    case 'extend-span': {
      const anchor = parsed.planning.start ?? parsed.planning.scheduled ?? parsed.planning.due;
      if (!anchor) {
        return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'span-anchor' }] };
      }
      requestedFields = ['start', 'due'];
      edits = [
        ...(parsed.planning.start
          ? []
          : ([{ type: 'set-date', field: 'start', value: anchor }] as const)),
        { type: 'set-date', field: 'due', value: command.due },
      ];
      break;
    }
    case 'set-description':
    case 'add-subtask':
    case 'delete-subtask':
    case 'reorder-subtask':
    case 'add-comment':
    case 'update-comment':
    case 'delete-comment':
    case 'delete':
      return { type: 'invalid', issues: [{ code: 'invalid-target', field: 'block' }] };
  }
  return codec.applyLineEdits(sourceLine, edits, requestedFields);
}
