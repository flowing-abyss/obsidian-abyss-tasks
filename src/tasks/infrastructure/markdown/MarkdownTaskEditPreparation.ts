import type { TaskPreparedNodeContinuation } from '../../application/TaskEditPreparationApi';
import type {
  TaskEditCommand,
  TaskPreparedRootEdit,
  TaskRepositoryResult,
} from '../../application/TaskRepository';
import { taskEditRootRef } from '../../application/TaskRepository';
import { sameTaskNodeRef, type TaskNodeRef, type TaskSnapshot } from '../../domain/types';
import { invalidTaskTarget } from '../../domain/validation';
import type { TaskNodeLineMapping } from './TaskBlockEditor';

interface CanonicalEdit {
  readonly nodeMap?: readonly TaskNodeLineMapping[];
  readonly content: string;
  readonly result: TaskRepositoryResult;
}
interface SealedCandidate {
  readonly content: string;
  readonly after: TaskSnapshot | null;
  readonly nodeMap: readonly TaskNodeLineMapping[] | undefined;
}
interface PreparationPorts {
  refresh?(
    current: TaskSnapshot,
    candidate: SealedCandidate,
  ): Promise<
    | {
        readonly ports: PreparationPorts;
        readonly content: string;
        readonly after: TaskSnapshot | null;
      }
    | undefined
  >;
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

function preparedNodes(root: TaskSnapshot | null): Map<number, TaskNodeRef> {
  const nodes = new Map<number, TaskNodeRef>();
  if (root === null) return nodes;
  nodes.set(0, { type: 'task', ref: root.ref });
  const visit = (children: TaskSnapshot['subtasks'], parentOffset: number): void => {
    for (const child of children) {
      const offset = parentOffset + child.ref.relativeLine;
      nodes.set(offset, { type: 'subtask', ref: child.ref });
      visit(child.subtasks, offset);
    }
  };
  visit(root.subtasks, 0);
  return nodes;
}

function continuations(
  before: TaskSnapshot,
  after: TaskSnapshot | null,
  map: readonly TaskNodeLineMapping[] | undefined,
): readonly TaskPreparedNodeContinuation[] {
  const previous = preparedNodes(before);
  const next = preparedNodes(after);
  return (map ?? []).flatMap((entry) => {
    const node = previous.get(entry.beforeOffset);
    if (node === undefined) return [];
    if (entry.afterOffset === undefined) return [{ before: node }];
    const successor = next.get(entry.afterOffset);
    return successor === undefined ? [] : [{ before: node, after: successor }];
  });
}

export function unchangedPreparedContinuations(
  root: TaskSnapshot,
): readonly TaskPreparedNodeContinuation[] {
  return [...preparedNodes(root).values()].map((node) => ({ before: node, after: node }));
}

/** Retains sealed candidates; public snapshots never become source or write authority. */
export class MarkdownTaskEditPreparation {
  constructor(
    private readonly ports: PreparationPorts,
    private readonly family = { attempted: false },
  ) {}

  prepare(
    before: TaskSnapshot,
    content: string,
    nodeMap: readonly TaskNodeLineMapping[],
  ): TaskPreparedRootEdit {
    return this.stage(structuredClone(before), content, structuredClone(before), {
      nodeMap,
      correspondence: continuations(before, before, nodeMap),
    });
  }

  private stage(
    before: TaskSnapshot,
    content: string,
    after: TaskSnapshot | null,
    maps: {
      readonly nodeMap: readonly TaskNodeLineMapping[] | undefined;
      readonly correspondence: readonly TaskPreparedNodeContinuation[];
    },
  ): TaskPreparedRootEdit {
    const { nodeMap, correspondence } = maps;
    let attempt: Promise<TaskRepositoryResult> | undefined;
    return {
      type: 'ready',
      get continuations() {
        return structuredClone(correspondence);
      },
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
          {
            nodeMap: edit.result.changed ? composeNodeMaps(nodeMap, edit.nodeMap) : nodeMap,
            correspondence: continuations(
              after,
              outcome.type === 'task' ? outcome.task : null,
              edit.result.changed
                ? edit.nodeMap
                : [...preparedNodes(after).keys()].map((offset) => ({
                    beforeOffset: offset,
                    afterOffset: offset,
                  })),
            ),
          },
        );
      },
      refresh: (current) => this.refresh(before, { content, after, nodeMap }, current),
      commit: async () => {
        this.family.attempted = true;
        attempt ??= Promise.resolve().then(() => this.ports.commit(content, after, nodeMap));
        return structuredClone(await attempt);
      },
    };
  }
  private async refresh(
    before: TaskSnapshot,
    candidate: SealedCandidate,
    current: TaskSnapshot,
  ): Promise<TaskPreparedRootEdit> {
    const allowed = (): boolean => !this.family.attempted;
    if (!allowed()) return { type: 'invalid', result: invalidTaskTarget('target') };
    const refreshed = await this.ports.refresh?.(structuredClone(current), candidate);
    if (refreshed === undefined || !allowed())
      return { type: 'invalid', result: invalidTaskTarget('target') };
    return new MarkdownTaskEditPreparation(refreshed.ports, this.family).stage(
      before,
      refreshed.content,
      refreshed.after,
      {
        nodeMap: candidate.nodeMap,
        correspondence:
          candidate.after === null
            ? []
            : continuations(
                candidate.after,
                refreshed.after,
                [...preparedNodes(candidate.after).keys()].map((offset) => ({
                  beforeOffset: offset,
                  afterOffset: offset,
                })),
              ),
      },
    );
  }
}
