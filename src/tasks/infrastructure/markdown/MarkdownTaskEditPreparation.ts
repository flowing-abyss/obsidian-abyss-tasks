import type {
  TaskEditCommand,
  TaskPreparedRootEdit,
  TaskRepositoryResult,
} from '../../application/TaskRepository';
import { taskEditRootRef } from '../../application/TaskRepository';
import { sameTaskNodeRef, type TaskSnapshot } from '../../domain/types';
import { invalidTaskTarget } from '../../domain/validation';
import type { TaskNodeLineMapping } from './TaskBlockEditor';

interface CanonicalEdit {
  readonly nodeMap?: readonly TaskNodeLineMapping[];
  readonly content: string;
  readonly result: TaskRepositoryResult;
}
interface PreparationPorts {
  /** The same canonical edit path used by ordinary repository commands, without publication. */
  apply(content: string, root: TaskSnapshot, command: TaskEditCommand): CanonicalEdit;
  commit(
    content: string,
    after: TaskSnapshot | null,
    nodeMap: readonly TaskNodeLineMapping[] | undefined,
  ): Promise<TaskRepositoryResult>;
}

/** Compose physical editor witnesses only; missing proof never means a node was removed. */
function composeNodeMaps(
  before: readonly TaskNodeLineMapping[] | undefined,
  next: readonly TaskNodeLineMapping[] | undefined,
): readonly TaskNodeLineMapping[] | undefined {
  if (before === undefined || next === undefined) return undefined;
  const successors = new Map(next.map((node) => [node.beforeOffset, node]));
  return before.flatMap((node) => {
    if (node.afterOffset === undefined) return [node];
    const successor = successors.get(node.afterOffset);
    if (successor === undefined) return [];
    return [
      {
        beforeOffset: node.beforeOffset,
        ...(successor.afterOffset === undefined ? {} : { afterOffset: successor.afterOffset }),
      },
    ];
  });
}

/** Retains sealed candidates; public snapshots never become source or write authority. */
export class MarkdownTaskEditPreparation {
  constructor(private readonly ports: PreparationPorts) {}

  prepare(
    before: TaskSnapshot,
    content: string,
    nodeMap: readonly TaskNodeLineMapping[],
  ): TaskPreparedRootEdit {
    return this.stage(structuredClone(before), content, structuredClone(before), nodeMap);
  }

  private stage(
    before: TaskSnapshot,
    content: string,
    after: TaskSnapshot | null,
    nodeMap: readonly TaskNodeLineMapping[] | undefined,
  ): TaskPreparedRootEdit {
    let attempt: Promise<TaskRepositoryResult> | undefined;
    return {
      type: 'ready',
      get before() {
        return structuredClone(before);
      },
      get after() {
        return structuredClone(after);
      },
      append: (command) => {
        if (
          after === null ||
          !sameTaskNodeRef(
            { type: 'task', ref: taskEditRootRef(command) },
            { type: 'task', ref: after.ref },
          )
        )
          return { type: 'invalid', result: invalidTaskTarget('target') };
        const edit = this.ports.apply(content, after, structuredClone(command));
        if (edit.result.type !== 'committed') return { type: 'invalid', result: edit.result };
        const outcome = edit.result.outcome;
        if (outcome.type !== 'task' && outcome.type !== 'deleted')
          return { type: 'invalid', result: invalidTaskTarget('target') };
        return this.stage(
          before,
          edit.content,
          outcome.type === 'task' ? structuredClone(outcome.task) : null,
          edit.result.changed ? composeNodeMaps(nodeMap, edit.nodeMap) : nodeMap,
        );
      },
      commit: async () => {
        attempt ??= Promise.resolve().then(() => this.ports.commit(content, after, nodeMap));
        return structuredClone(await attempt);
      },
    };
  }
}
