// @vitest-environment node
import { expectTypeOf, it } from 'vitest';
import type {
  CreateDependencySubtaskCommand,
  CreateTaskCommandInitial,
  TaskApplicationApi,
  TaskCommand,
  TaskCommandResult,
  TaskCreateSession,
  TaskNodeRef,
} from '../../src/tasks';
import type { TaskInputInitial } from '../../src/tasks/domain/taskInputTypes';

it('exposes atomic linked creation through the public command union while keeping storage edits private', () => {
  expectTypeOf<
    Extract<TaskCommand, { type: 'create-dependency-subtask' }>
  >().toEqualTypeOf<CreateDependencySubtaskCommand>();
  expectTypeOf<CreateDependencySubtaskCommand['current']>().toEqualTypeOf<TaskNodeRef>();
  expectTypeOf<Parameters<TaskApplicationApi['execute']>[0]>().toEqualTypeOf<TaskCommand>();
  expectTypeOf<ReturnType<TaskApplicationApi['execute']>>().toEqualTypeOf<
    Promise<TaskCommandResult>
  >();
  expectTypeOf<
    Extract<TaskCommand, { type: 'set-dependency-id' | 'set-depends-on' }>
  >().toBeNever();
});

it('exposes synchronous preview on both retained session outcomes with shared create requests', () => {
  expectTypeOf<Parameters<TaskCreateSession['preview']>>().toEqualTypeOf<
    Parameters<TaskCreateSession['execute']>
  >();
  expectTypeOf<
    ReturnType<Extract<TaskCreateSession, { type: 'ready' }>['preview']>
  >().toEqualTypeOf<ReturnType<Extract<TaskCreateSession, { type: 'unavailable' }>['preview']>>();
  expectTypeOf<
    Extract<ReturnType<TaskCreateSession['preview']>, { type: 'valid' }>['metadata']['tags']
  >().toEqualTypeOf<readonly string[]>();
  expectTypeOf<CreateTaskCommandInitial>().toEqualTypeOf<TaskInputInitial>();
});
