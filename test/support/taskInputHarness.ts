import { inspectTaskInput } from '../../src/tasks/domain/taskInputInspection';
import { projectTaskInput } from '../../src/tasks/domain/taskInputProjection';
import type { TaskInputState } from '../../src/tasks/domain/taskInputState';
import type { TaskInputInitial, TaskInputReference } from '../../src/tasks/domain/taskInputTypes';
import { localDate, localTime } from '../../src/tasks/domain/validation';
import { ChronoTaskInputRecognizer } from '../../src/tasks/infrastructure/input/ChronoTaskInputRecognizer';
import { TaskMarkdownCodec } from '../../src/tasks/infrastructure/markdown/TaskMarkdownCodec';
import { canonicalStatusCatalog } from '../helpers';
export const reference: TaskInputReference = {
  epochMs: 1791867600000,
  localDate: localDate('2026-10-13'),
  localTime: localTime('12:00'),
  second: 0,
  offsetMinutes: 420,
};
export const recognizer = new ChronoTaskInputRecognizer();
export const codec = new TaskMarkdownCodec(canonicalStatusCatalog());
export function project(state: TaskInputState, contextInitial?: TaskInputInitial) {
  const inspection = inspectTaskInput(state.raw);
  return projectTaskInput({
    state,
    reference,
    inspection,
    sourcePlanning: {},
    candidates: recognizer.recognize({
      text: state.raw,
      reference,
      protectedRanges: inspection.protectedRanges,
    }),
    ...(contextInitial === undefined ? {} : { contextInitial }),
  });
}
