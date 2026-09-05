import type { TaskResolutionCandidate } from './commands';
import {
  sameTaskNodeRef,
  type SubtaskRef,
  type SubtaskSnapshot,
  type TaskNodeRef,
  type TaskRef,
  type TaskSnapshot,
} from './types';
export interface RootRevisionOverride {
  readonly line: number;
  readonly source: string;
  readonly revision: string;
}

export type RebaseEvidence = 'byte-identical-relocation' | 'authority-transition';

export type VisualEvidence = 'same-line' | 'anchored-range';

export interface RootReconciliationBasis {
  readonly observed: TaskSnapshot;
  readonly previousRootAnchor?: { readonly line: number; readonly originalBlock: string };
  readonly nextRootAnchor?: { readonly line: number; readonly originalBlock: string };
  readonly authorityTransition?: RootRevisionOverride;
}

export type TaskResolution =
  | { readonly type: 'exact'; readonly task: TaskSnapshot; readonly basis: RootReconciliationBasis }
  | {
      readonly type: 'rebased';
      readonly previous: TaskSnapshot;
      readonly current: TaskSnapshot;
      readonly evidence: RebaseEvidence;
      readonly basis: RootReconciliationBasis;
    }
  | {
      readonly type: 'visual';
      readonly stale: TaskRef;
      readonly current: TaskSnapshot;
      readonly evidence: VisualEvidence;
    }
  | { readonly type: 'uncertain'; readonly ref: TaskRef }
  | { readonly type: 'not-found'; readonly ref: TaskRef }
  | { readonly type: 'ambiguous'; readonly candidates: readonly TaskResolutionCandidate[] };

export interface RootReconciliationOptions {
  readonly previousRoots?: readonly TaskSnapshot[];
  readonly authorityTransitions?: readonly ProvenRootRevisionOverride[];
}

export interface ProvenRootRevisionOverride extends RootRevisionOverride {
  readonly previousRevision: string;
}

export interface ProvenRootTransition {
  readonly previous: TaskSnapshot;
  readonly current: TaskSnapshot;
  readonly evidence: RebaseEvidence;
  readonly basis: RootReconciliationBasis;
}

interface VisualRootTransition {
  readonly stale: TaskRef;
  readonly current: TaskSnapshot;
  readonly evidence: VisualEvidence;
}

type IndexedRootTransition = ProvenRootTransition & { readonly currentIndex: number };

interface ReconciliationContext {
  readonly previousRoots: readonly TaskSnapshot[];
  readonly currentRoots: readonly TaskSnapshot[];
  readonly resolved: Map<number, IndexedRootTransition>;
  readonly occupiedCurrent: Set<number>;
}

export interface RootReconciliationTransitions {
  readonly writable: ReadonlyMap<string, ProvenRootTransition>;
  readonly visual: ReadonlyMap<string, VisualRootTransition>;
}

export type NestedTaskResolution =
  | { readonly type: 'exact'; readonly task: SubtaskSnapshot }
  | {
      readonly type: 'rebased';
      readonly previous: SubtaskSnapshot;
      readonly current: SubtaskSnapshot;
      readonly evidence: 'byte-identical-relocation';
    }
  | { readonly type: 'not-found'; readonly ref: SubtaskRef }
  | { readonly type: 'ambiguous'; readonly candidates: readonly SubtaskSnapshot[] };

function refKey(ref: TaskRef): string {
  return JSON.stringify([ref.filePath, ref.line, ref.revision]);
}

export function taskReconciliationKey(ref: TaskRef): string {
  return refKey(ref);
}

function rootCandidate(task: TaskSnapshot): TaskResolutionCandidate {
  return { root: task, target: { type: 'task', ref: task.ref } };
}

function uniqueSourcePairs(
  previousRoots: readonly TaskSnapshot[],
  currentRoots: readonly TaskSnapshot[],
): Array<readonly [number, number]> {
  const previousBySource = new Map<string, number[]>();
  const currentBySource = new Map<string, number[]>();
  previousRoots.forEach((task, index) => {
    const matches = previousBySource.get(task.source.originalBlock) ?? [];
    matches.push(index);
    previousBySource.set(task.source.originalBlock, matches);
  });
  currentRoots.forEach((task, index) => {
    const matches = currentBySource.get(task.source.originalBlock) ?? [];
    matches.push(index);
    currentBySource.set(task.source.originalBlock, matches);
  });
  const pairs: Array<readonly [number, number]> = [];
  for (const [source, previous] of previousBySource) {
    const current = currentBySource.get(source) ?? [];
    const previousIndex = previous[0];
    const currentIndex = current[0];
    if (
      previous.length === 1 &&
      current.length === 1 &&
      previousIndex !== undefined &&
      currentIndex !== undefined
    ) {
      pairs.push([previousIndex, currentIndex]);
    }
  }
  return pairs;
}

function authorityPairs(
  previousRoots: readonly TaskSnapshot[],
  currentRoots: readonly TaskSnapshot[],
  authorityTransitions: readonly ProvenRootRevisionOverride[],
): Array<readonly [number, number, ProvenRootRevisionOverride]> {
  const previousByRevision = new Map<string, number[]>();
  const currentByAuthority = new Map<string, number[]>();
  previousRoots.forEach((task, index) => {
    const matches = previousByRevision.get(task.ref.revision) ?? [];
    matches.push(index);
    previousByRevision.set(task.ref.revision, matches);
  });
  currentRoots.forEach((task, index) => {
    const key = JSON.stringify([task.source.line, task.source.originalBlock, task.ref.revision]);
    const matches = currentByAuthority.get(key) ?? [];
    matches.push(index);
    currentByAuthority.set(key, matches);
  });
  const pairs: Array<readonly [number, number, ProvenRootRevisionOverride]> = [];
  for (const transition of authorityTransitions) {
    const currentMatches =
      currentByAuthority.get(
        JSON.stringify([transition.line, transition.source, transition.revision]),
      ) ?? [];
    const previousMatches = previousByRevision.get(transition.previousRevision) ?? [];
    const previousIndex = previousMatches[0];
    const currentIndex = currentMatches[0];
    if (
      currentMatches.length === 1 &&
      previousMatches.length === 1 &&
      previousIndex !== undefined &&
      currentIndex !== undefined
    ) {
      pairs.push([previousIndex, currentIndex, transition]);
    }
  }
  return pairs;
}

function addResolvedTransition(
  context: ReconciliationContext,
  previousIndex: number,
  currentIndex: number,
  transition: Omit<ProvenRootTransition, 'previous' | 'current'>,
): void {
  if (context.resolved.has(previousIndex) || context.occupiedCurrent.has(currentIndex)) return;
  const previous = context.previousRoots[previousIndex];
  const current = context.currentRoots[currentIndex];
  if (previous === undefined || current === undefined) return;
  context.resolved.set(previousIndex, { previous, current, ...transition, currentIndex });
  context.occupiedCurrent.add(currentIndex);
}

function addAuthorityTransitions(
  context: ReconciliationContext,
  authorityTransitions: readonly ProvenRootRevisionOverride[],
): void {
  for (const [previousIndex, currentIndex, transition] of authorityPairs(
    context.previousRoots,
    context.currentRoots,
    authorityTransitions,
  )) {
    const previous = context.previousRoots[previousIndex];
    if (previous === undefined) continue;
    addResolvedTransition(context, previousIndex, currentIndex, {
      evidence: 'authority-transition',
      basis: {
        observed: previous,
        authorityTransition: {
          line: transition.line,
          source: transition.source,
          revision: transition.revision,
        },
      },
    });
  }
}

function addSourceTransitions(context: ReconciliationContext): void {
  for (const [previousIndex, currentIndex] of uniqueSourcePairs(
    context.previousRoots,
    context.currentRoots,
  )) {
    const previous = context.previousRoots[previousIndex];
    if (previous === undefined) continue;
    addResolvedTransition(context, previousIndex, currentIndex, {
      evidence: 'byte-identical-relocation',
      basis: { observed: previous },
    });
  }
}

interface ReconciliationBoundary {
  readonly previousIndex: number;
  readonly currentIndex: number;
  readonly real: boolean;
}

function reconciliationBoundaries(context: ReconciliationContext): ReconciliationBoundary[] {
  const anchors = [...context.resolved.entries()]
    .map(([previousIndex, transition]) => ({
      previousIndex,
      currentIndex: transition.currentIndex,
    }))
    .sort((left, right) => left.previousIndex - right.previousIndex);
  const monotonic = anchors.filter((anchor, index) => {
    const previous = anchors[index - 1];
    return previous === undefined || anchor.currentIndex > previous.currentIndex;
  });
  return [
    { previousIndex: -1, currentIndex: -1, real: false },
    ...monotonic.map((anchor) => ({ ...anchor, real: true })),
    {
      previousIndex: context.previousRoots.length,
      currentIndex: context.currentRoots.length,
      real: false,
    },
  ];
}

function addVisualRange(
  context: ReconciliationContext,
  visual: Map<number, VisualRootTransition>,
  left: ReconciliationBoundary,
  right: ReconciliationBoundary,
): void {
  const previousCount = right.previousIndex - left.previousIndex - 1;
  const currentCount = right.currentIndex - left.currentIndex - 1;
  if (previousCount === 0 || previousCount !== currentCount || !left.real || !right.real) return;
  for (let offset = 1; offset <= previousCount; offset++) {
    const previousIndex = left.previousIndex + offset;
    const currentIndex = left.currentIndex + offset;
    if (context.resolved.has(previousIndex) || context.occupiedCurrent.has(currentIndex)) continue;
    const previous = context.previousRoots[previousIndex];
    const current = context.currentRoots[currentIndex];
    if (previous === undefined || current === undefined) continue;
    visual.set(previousIndex, { stale: previous.ref, current, evidence: 'anchored-range' });
    context.occupiedCurrent.add(currentIndex);
  }
}

function visualTransitions(context: ReconciliationContext): Map<number, VisualRootTransition> {
  const visual = new Map<number, VisualRootTransition>();
  const boundaries = reconciliationBoundaries(context);
  for (let index = 0; index < boundaries.length - 1; index++) {
    const left = boundaries[index];
    const right = boundaries[index + 1];
    if (left !== undefined && right !== undefined) addVisualRange(context, visual, left, right);
  }
  return visual;
}

function keyedVisualTransitions(
  context: ReconciliationContext,
  visual: ReadonlyMap<number, VisualRootTransition>,
): Map<string, VisualRootTransition> {
  return new Map(
    [...visual.entries()].flatMap(([previousIndex, transition]) => {
      const previous = context.previousRoots[previousIndex];
      return previous === undefined ? [] : [[refKey(previous.ref), transition] as const];
    }),
  );
}

/**
 * Reconciles every root in one observed file generation against its immediate successor.
 * A root is never paired by title, fuzzy similarity, or a stale line alone.
 */
export function reconcileRootTransitions(
  previousRoots: readonly TaskSnapshot[],
  currentRoots: readonly TaskSnapshot[],
  authorityTransitions: readonly ProvenRootRevisionOverride[] = [],
): RootReconciliationTransitions {
  const context: ReconciliationContext = {
    previousRoots,
    currentRoots,
    resolved: new Map(),
    occupiedCurrent: new Set(),
  };
  addAuthorityTransitions(context, authorityTransitions);
  addSourceTransitions(context);
  const visual = visualTransitions(context);
  return {
    writable: new Map(
      [...context.resolved.values()].map(({ currentIndex: _currentIndex, ...transition }) => [
        refKey(transition.previous.ref),
        transition,
      ]),
    ),
    visual: keyedVisualTransitions(context, visual),
  };
}

export function reconcileRoot(
  observed: TaskSnapshot,
  currentRoots: readonly TaskSnapshot[],
  options: RootReconciliationOptions = {},
): TaskResolution {
  const revisionMatches = currentRoots.filter(
    (task) =>
      task.ref.filePath === observed.ref.filePath && task.ref.revision === observed.ref.revision,
  );
  const exact = revisionMatches.find((task) => task.source.line === observed.source.line);
  if (revisionMatches.length > 1) {
    return { type: 'ambiguous', candidates: revisionMatches.map(rootCandidate) };
  }
  if (exact != null) return { type: 'exact', task: exact, basis: { observed } };

  const previousRoots = options.previousRoots ?? [observed];
  const transitions = reconcileRootTransitions(
    previousRoots,
    currentRoots,
    options.authorityTransitions,
  );
  const transition = transitions.writable.get(refKey(observed.ref));
  if (transition != null) return { type: 'rebased', ...transition };

  const sourceMatches = currentRoots.filter(
    (task) => task.source.originalBlock === observed.source.originalBlock,
  );
  if (sourceMatches.length > 1) {
    return { type: 'ambiguous', candidates: sourceMatches.map(rootCandidate) };
  }
  const visual = transitions.visual.get(refKey(observed.ref));
  if (visual != null) return { type: 'visual', ...visual };
  const sameLine = currentRoots.find((task) => task.source.line === observed.source.line);
  if (sameLine != null) {
    return {
      type: 'visual',
      stale: observed.ref,
      current: sameLine,
      evidence: 'same-line',
    };
  }
  return currentRoots.length === 0
    ? { type: 'not-found', ref: observed.ref }
    : { type: 'uncertain', ref: observed.ref };
}

export function reconcileNested(
  observed: SubtaskSnapshot,
  currentParent: TaskSnapshot | SubtaskSnapshot,
): NestedTaskResolution {
  const sourceMatches = currentParent.subtasks.filter(
    (candidate) => candidate.ref.originalBlock === observed.ref.originalBlock,
  );
  if (sourceMatches.length > 1) {
    return {
      type: 'ambiguous',
      candidates: sourceMatches,
    };
  }
  if (sourceMatches.length === 1) {
    const current = sourceMatches[0];
    if (current === undefined) return { type: 'not-found', ref: observed.ref };
    if (current.ref.relativeLine === observed.ref.relativeLine) {
      return { type: 'exact', task: current };
    }
    return {
      type: 'rebased',
      previous: observed,
      current,
      evidence: 'byte-identical-relocation',
    };
  }
  return { type: 'not-found', ref: observed.ref };
}

/** A stale nested ref must be unique in both its predecessor and current parent. */
function provenChildPair(
  previous: TaskSnapshot | SubtaskSnapshot,
  current: TaskSnapshot | SubtaskSnapshot,
  ref: SubtaskRef,
  dependencyChanges: boolean,
): { previous: SubtaskSnapshot; current: SubtaskSnapshot } | undefined {
  const predecessors = previous.subtasks.filter(
    (child) => child.ref.originalBlock === ref.originalBlock,
  );
  const observed = predecessors[0];
  if (predecessors.length !== 1 || observed?.ref.relativeLine !== ref.relativeLine)
    return undefined;
  const metadataMatch = dependencyChanges ? dependencyChangedChild(observed, current) : undefined;
  if (metadataMatch !== undefined) return { previous: observed, current: metadataMatch };
  const resolved = reconcileNested(observed, current);
  if (resolved.type !== 'exact' && resolved.type !== 'rebased') return undefined;
  return {
    previous: observed,
    current: resolved.type === 'exact' ? resolved.task : resolved.current,
  };
}

function dependencyIdentity(node: SubtaskSnapshot): unknown {
  return {
    ...node,
    ref: { relativeLine: node.ref.relativeLine },
    dependencyId: undefined,
    dependsOn: undefined,
    subtasks: node.subtasks.map(dependencyIdentity),
    comments: node.comments.map((comment) => ({
      ...comment,
      ref: {
        relativeLine: comment.ref.relativeLine,
        originalMarkdown: comment.ref.originalMarkdown,
      },
    })),
  };
}

function dependencyChangedChild(
  previous: SubtaskSnapshot,
  current: TaskSnapshot | SubtaskSnapshot,
): SubtaskSnapshot | undefined {
  const positioned = current.subtasks.filter(
    (child) => child.ref.relativeLine === previous.ref.relativeLine,
  );
  const candidate = positioned[0];
  return positioned.length === 1 &&
    candidate !== undefined &&
    JSON.stringify(dependencyIdentity(candidate)) === JSON.stringify(dependencyIdentity(previous))
    ? candidate
    : undefined;
}

function exactChildPair(
  current: TaskSnapshot | SubtaskSnapshot,
  ref: SubtaskRef,
): { previous: SubtaskSnapshot; current: SubtaskSnapshot } | undefined {
  const exact = current.subtasks.find((child) =>
    sameTaskNodeRef({ type: 'subtask', ref: child.ref }, { type: 'subtask', ref }),
  );
  return exact === undefined ? undefined : { previous: exact, current: exact };
}

export function reconcileTaskNodeRef(
  previous: TaskSnapshot,
  current: TaskSnapshot,
  target: TaskNodeRef,
  options: { readonly dependencyChanges?: boolean } = {},
): TaskNodeRef | undefined {
  if (target.type === 'task') return { type: 'task', ref: current.ref };
  const chain: SubtaskRef[] = [];
  let root: TaskNodeRef = target;
  while (root.type === 'subtask') {
    chain.unshift(root.ref);
    root = root.ref.parent;
  }
  const exactRoot = sameTaskNodeRef(root, { type: 'task', ref: current.ref });
  if (!exactRoot && !sameTaskNodeRef(root, { type: 'task', ref: previous.ref })) return undefined;
  let before: TaskSnapshot | SubtaskSnapshot = previous;
  let after: TaskSnapshot | SubtaskSnapshot = current;
  for (const ref of chain) {
    const pair: { previous: SubtaskSnapshot; current: SubtaskSnapshot } | undefined = exactRoot
      ? exactChildPair(after, ref)
      : provenChildPair(before, after, ref, options.dependencyChanges === true);
    if (pair === undefined) return undefined;
    before = pair.previous;
    after = pair.current;
  }
  return 'source' in after ? { type: 'task', ref: after.ref } : { type: 'subtask', ref: after.ref };
}
