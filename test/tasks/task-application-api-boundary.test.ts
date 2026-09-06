import { expectTypeOf, it } from 'vitest';
import type {
  CreateDependencySubtaskCommand,
  TaskApplicationApi,
  TaskCommand,
  TaskCommandResult,
  TaskNodeRef,
} from '../../src/tasks';

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
