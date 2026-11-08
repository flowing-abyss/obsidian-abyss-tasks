import type {
  TaskEditRefreshUnavailable,
  TaskPreparedNodeContinuation,
} from '../../application/TaskEditPreparationApi';
import type {
  TaskEditCommand,
  TaskPreparedRootEdit,
  TaskRepositoryResult,
} from '../../application/TaskRepository';
import { taskEditRootRef } from '../../application/TaskRepository';
import type {
  TaskMergePreservation,
  TaskSourceCopy,
  TaskSourceCopyEvidence,
} from '../../application/TaskSourceCopyApi';
import { sameTaskNodeRef, type TaskNodeRef, type TaskSnapshot } from '../../domain/types';
import { invalidTaskTarget } from '../../domain/validation';
import {
  advanceSourceCopies,
  continuePreparedComment,
  copyHasParent,
  sourceCopyEvidence,
  type CapturedSourceCopy,
} from './preparedSourceCopies';
import type { TaskNodeLineMapping } from './TaskBlockEditor';

interface CanonicalEdit {
  readonly lineMap?: readonly TaskNodeLineMapping[];
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
  assessMerge?(
    root: TaskSnapshot,
    source: TaskNodeRef,
    copies: readonly TaskSourceCopyEvidence[],
  ): Promise<TaskMergePreservation | undefined>;
  copy?(
    content: string,
    root: TaskSnapshot,
    input: TaskSourceCopy,
  ): Promise<(CanonicalEdit & { readonly copy: CapturedSourceCopy }) | undefined>;
  refresh?(
    current: TaskSnapshot,
    candidate: SealedCandidate,
  ): Promise<
    | {
        readonly ports: PreparationPorts;
        readonly content: string;
        readonly after: TaskSnapshot | null;
      }
    | TaskEditRefreshUnavailable
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

/** Only the canonical single-node insertion plus complete injective survivor proof certifies birth. */
function advanceAuthored(
  roots: { before: TaskSnapshot; after: TaskSnapshot | null },
  authored: ReadonlySet<number>,
  map: readonly TaskNodeLineMapping[] | undefined,
  insertion: boolean,
): ReadonlySet<number> {
  const previous = preparedNodes(roots.before),
    next = preparedNodes(roots.after);
  const entries = map ?? [];
  const retained = entries.filter((e) => e.afterOffset !== undefined);
  const result = new Set(
    retained.flatMap((e) =>
      e.afterOffset !== undefined && authored.has(e.beforeOffset) && next.has(e.afterOffset)
        ? [e.afterOffset]
        : [],
    ),
  );
  if (
    !insertion ||
    entries.length !== previous.size ||
    retained.length !== previous.size ||
    new Set(entries.map((e) => e.beforeOffset)).size !== previous.size ||
    new Set(retained.map((e) => e.afterOffset)).size !== previous.size ||
    entries.some(
      (e) =>
        !previous.has(e.beforeOffset) || e.afterOffset === undefined || !next.has(e.afterOffset),
    )
  )
    return result;
  const inserted = [...next.keys()].filter(
    (offset) => !retained.some((e) => e.afterOffset === offset),
  );
  if (inserted.length === 1 && inserted[0] !== undefined) result.add(inserted[0]);
  return result;
}

interface PreparationMaps {
  readonly sourceMap: readonly TaskNodeLineMapping[] | undefined;
  readonly nodeMap: readonly TaskNodeLineMapping[] | undefined;
  readonly correspondence: readonly TaskPreparedNodeContinuation[];
  readonly authored: ReadonlySet<number>;
  readonly copies: readonly CapturedSourceCopy[];
}
function identityMap(root: TaskSnapshot): readonly TaskNodeLineMapping[] {
  return [...preparedNodes(root).keys()].map((offset) => ({
    beforeOffset: offset,
    afterOffset: offset,
  }));
}
function allowsStatus(
  command: TaskEditCommand,
  after: TaskSnapshot,
  authored: ReadonlySet<number>,
): boolean {
  return (
    command.type !== 'set-status' ||
    [...preparedNodes(after)].some(
      ([offset, node]) => authored.has(offset) && sameTaskNodeRef(node, command.target),
    )
  );
}
function allowsPreparedCommand(
  command: TaskEditCommand,
  after: TaskSnapshot,
  authored: ReadonlySet<number>,
): boolean {
  return (
    sameTaskNodeRef(
      { type: 'task', ref: taskEditRootRef(command) },
      { type: 'task', ref: after.ref },
    ) && allowsStatus(command, after, authored)
  );
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
    newlyAuthored = false,
  ): TaskPreparedRootEdit {
    return this.stage(structuredClone(before), content, structuredClone(before), {
      nodeMap,
      sourceMap: before.source.originalBlock
        .split('\n')
        .map((_, offset) => ({ beforeOffset: offset, afterOffset: offset })),
      correspondence: continuations(before, before, nodeMap),
      copies: [],
      authored: newlyAuthored ? new Set(preparedNodes(before).keys()) : new Set(),
    });
  }

  private stage(
    before: TaskSnapshot,
    content: string,
    after: TaskSnapshot | null,
    maps: PreparationMaps,
  ): TaskPreparedRootEdit {
    const { nodeMap, correspondence, copies } = maps;
    let attempt: Promise<TaskRepositoryResult> | undefined;
    return {
      type: 'ready',
      continueSourceComment: (source) =>
        continuePreparedComment({ before, after }, maps.sourceMap, source),
      sourceCopiesAvailable: () => copies.every((copy) => copy.permitted()),
      assessMerge: async (source) =>
        after === null || !copies.every((copy) => copy.permitted())
          ? undefined
          : await this.ports.assessMerge?.(
              after,
              source,
              copies.map((copy) => sourceCopyEvidence(copy, after)),
            ),
      get copies() {
        return structuredClone(copies.map((copy) => sourceCopyEvidence(copy, after)));
      },
      copySource: (input) => this.copy(before, { content, after, nodeMap }, maps, input),
      get continuations() {
        return structuredClone(correspondence);
      },
      get before() {
        return structuredClone(before);
      },
      get after() {
        return structuredClone(after);
      },
      append: (command) => this.append(before, { content, after, nodeMap }, maps, command),
      refresh: (current) => this.refresh(before, { content, after, nodeMap }, current, maps),
      commit: async () => {
        this.family.attempted = true;
        attempt ??= Promise.resolve().then(() =>
          copies.every((copy) => copy.permitted())
            ? this.ports.commit(content, after, nodeMap)
            : invalidTaskTarget('source'),
        );
        return structuredClone(await attempt);
      },
    };
  }
  private async copy(
    before: TaskSnapshot,
    candidate: SealedCandidate,
    maps: PreparationMaps,
    input: TaskSourceCopy,
  ): Promise<TaskPreparedRootEdit> {
    const { after, content, nodeMap } = candidate,
      { authored, copies } = maps;
    const allowed = (): boolean =>
      !this.family.attempted && copies.every((copy) => copy.permitted());
    if (after === null || !allowed())
      return { type: 'invalid', result: invalidTaskTarget('source') };
    const edit = await this.ports.copy?.(content, after, structuredClone(input));
    if (!allowed()) return { type: 'invalid', result: invalidTaskTarget('source') };
    if (edit?.result.type !== 'committed' || edit.result.outcome.type !== 'task')
      return { type: 'invalid', result: invalidTaskTarget('source') };
    const next = edit.result.outcome.task;
    const parent = continuations(after, next, edit.nodeMap).find((pair) =>
      sameTaskNodeRef(pair.before, input.parent),
    )?.after;
    if (!copyHasParent(edit.copy, next, parent))
      return { type: 'invalid', result: invalidTaskTarget('source') };
    return this.stage(before, edit.content, next, {
      sourceMap: composeNodeMaps(maps.sourceMap, edit.lineMap),
      nodeMap: composeNodeMaps(nodeMap, edit.nodeMap),
      correspondence: continuations(after, next, edit.nodeMap),
      authored: advanceAuthored({ before: after, after: next }, authored, edit.nodeMap, false),
      copies: [...advanceSourceCopies(copies, next, edit.lineMap), edit.copy],
    });
  }
  private append(
    before: TaskSnapshot,
    candidate: SealedCandidate,
    maps: PreparationMaps,
    command: TaskEditCommand,
  ): TaskPreparedRootEdit {
    const { after, content, nodeMap } = candidate,
      { authored, copies } = maps;
    if (after === null || !allowsPreparedCommand(command, after, authored))
      return { type: 'invalid', result: invalidTaskTarget('target') };
    const edit = this.ports.apply(content, after, structuredClone(command));
    if (edit.result.type !== 'committed') return { type: 'invalid', result: edit.result };
    const outcome = edit.result.outcome;
    if (outcome.type !== 'task' && outcome.type !== 'deleted')
      return { type: 'invalid', result: invalidTaskTarget('target') };
    const next = outcome.type === 'task' ? structuredClone(outcome.task) : null;
    const mapping = edit.result.changed ? edit.nodeMap : identityMap(after);
    return this.stage(before, edit.content, next, {
      sourceMap: edit.result.changed
        ? composeNodeMaps(maps.sourceMap, edit.lineMap)
        : maps.sourceMap,
      copies: edit.result.changed ? advanceSourceCopies(copies, next, edit.lineMap) : copies,
      authored: advanceAuthored(
        { before: after, after: next },
        authored,
        mapping,
        command.type === 'add-subtask',
      ),
      nodeMap: composeNodeMaps(nodeMap, mapping),
      correspondence: continuations(after, next, mapping),
    });
  }
  private async refresh(
    before: TaskSnapshot,
    candidate: SealedCandidate,
    current: TaskSnapshot,
    maps: PreparationMaps,
  ): Promise<TaskPreparedRootEdit | TaskEditRefreshUnavailable> {
    const { authored, copies } = maps;
    const allowed = (): boolean =>
      !this.family.attempted && copies.every((copy) => copy.permitted());
    if (!allowed()) return { type: 'invalid', result: invalidTaskTarget('target') };
    const refreshed = await this.ports.refresh?.(structuredClone(current), candidate);
    if (refreshed === undefined || !allowed())
      return { type: 'invalid', result: invalidTaskTarget('target') };
    if ('type' in refreshed) return refreshed;
    return new MarkdownTaskEditPreparation(refreshed.ports, this.family).stage(
      before,
      refreshed.content,
      refreshed.after,
      {
        nodeMap: candidate.nodeMap,
        sourceMap: maps.sourceMap,
        authored,
        copies,
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
