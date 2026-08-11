import type { TaskResolutionCandidate } from './commands';
import type { SubtaskRef, SubtaskSnapshot, TaskRef, TaskSnapshot } from './types';
export interface RootRevisionOverride {
  readonly line: number;
  readonly source: string;
  readonly revision: string;
}

export type RebaseEvidence =
  | 'byte-identical-relocation'
  | 'authority-transition'
  | 'anchored-range';

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

function rootAnchor(task: TaskSnapshot): { readonly line: number; readonly originalBlock: string } {
  return { line: task.source.line, originalBlock: task.source.originalBlock };
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
    if (previous.length === 1 && current.length === 1) pairs.push([previous[0]!, current[0]!]);
  }
  return pairs;
}

function authorityPairs(
  previousRoots: readonly TaskSnapshot[],
  currentRoots: readonly TaskSnapshot[],
  authorityTransitions: readonly ProvenRootRevisionOverride[],
): Array<readonly [number, number, ProvenRootRevisionOverride]> {
  const pairs: Array<readonly [number, number, ProvenRootRevisionOverride]> = [];
  for (const transition of authorityTransitions) {
    const currentMatches = currentRoots
      .map((task, index) => ({ task, index }))
      .filter(
        ({ task }) =>
          task.source.line === transition.line &&
          task.source.originalBlock === transition.source &&
          task.ref.revision === transition.revision,
      );
    const previousMatches = previousRoots
      .map((task, index) => ({ task, index }))
      .filter(({ task }) => task.ref.revision === transition.previousRevision);
    if (currentMatches.length === 1 && previousMatches.length === 1) {
      pairs.push([previousMatches[0]!.index, currentMatches[0]!.index, transition]);
    }
  }
  return pairs;
}

/**
 * Reconciles every root in one observed file generation against its immediate successor.
 * A root is never paired by title, fuzzy similarity, or a stale line alone.
 */
export function reconcileRootTransitions(
  previousRoots: readonly TaskSnapshot[],
  currentRoots: readonly TaskSnapshot[],
  authorityTransitions: readonly ProvenRootRevisionOverride[] = [],
): ReadonlyMap<string, ProvenRootTransition> {
  const resolved = new Map<number, ProvenRootTransition>();
  const occupiedCurrent = new Set<number>();

  const add = (
    previousIndex: number,
    currentIndex: number,
    evidence: RebaseEvidence,
    basis: RootReconciliationBasis,
  ): void => {
    if (resolved.has(previousIndex) || occupiedCurrent.has(currentIndex)) return;
    resolved.set(previousIndex, {
      previous: previousRoots[previousIndex]!,
      current: currentRoots[currentIndex]!,
      evidence,
      basis,
    });
    occupiedCurrent.add(currentIndex);
  };

  for (const [previousIndex, currentIndex, transition] of authorityPairs(
    previousRoots,
    currentRoots,
    authorityTransitions,
  )) {
    const previous = previousRoots[previousIndex]!;
    add(previousIndex, currentIndex, 'authority-transition', {
      observed: previous,
      authorityTransition: {
        line: transition.line,
        source: transition.source,
        revision: transition.revision,
      },
    });
  }

  for (const [previousIndex, currentIndex] of uniqueSourcePairs(previousRoots, currentRoots)) {
    const previous = previousRoots[previousIndex]!;
    add(previousIndex, currentIndex, 'byte-identical-relocation', { observed: previous });
  }

  const anchors = [...resolved.entries()]
    .map(([previousIndex, transition]) => ({
      previousIndex,
      currentIndex: currentRoots.indexOf(transition.current),
    }))
    .sort((left, right) => left.previousIndex - right.previousIndex);
  const monotonicAnchors = anchors.filter(
    (anchor, index) => index === 0 || anchor.currentIndex > anchors[index - 1]!.currentIndex,
  );
  const boundaries = [
    { previousIndex: -1, currentIndex: -1, real: false },
    ...monotonicAnchors.map((anchor) => ({ ...anchor, real: true })),
    { previousIndex: previousRoots.length, currentIndex: currentRoots.length, real: false },
  ];
  for (let boundaryIndex = 0; boundaryIndex < boundaries.length - 1; boundaryIndex++) {
    const left = boundaries[boundaryIndex]!;
    const right = boundaries[boundaryIndex + 1]!;
    const previousCount = right.previousIndex - left.previousIndex - 1;
    const currentCount = right.currentIndex - left.currentIndex - 1;
    if (previousCount === 0 || previousCount !== currentCount || !left.real || !right.real) {
      continue;
    }
    for (let offset = 1; offset <= previousCount; offset++) {
      const previousIndex = left.previousIndex + offset;
      const currentIndex = left.currentIndex + offset;
      const previous = previousRoots[previousIndex]!;
      add(previousIndex, currentIndex, 'anchored-range', {
        observed: previous,
        ...(left.real && { previousRootAnchor: rootAnchor(previousRoots[left.previousIndex]!) }),
        ...(right.real && { nextRootAnchor: rootAnchor(previousRoots[right.previousIndex]!) }),
      });
    }
  }

  return new Map(
    [...resolved.values()].map((transition) => [refKey(transition.previous.ref), transition]),
  );
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
  if (exact) return { type: 'exact', task: exact, basis: { observed } };

  const previousRoots = options.previousRoots ?? [observed];
  const transition = reconcileRootTransitions(
    previousRoots,
    currentRoots,
    options.authorityTransitions,
  ).get(refKey(observed.ref));
  if (transition) return { type: 'rebased', ...transition };

  const sourceMatches = currentRoots.filter(
    (task) => task.source.originalBlock === observed.source.originalBlock,
  );
  if (sourceMatches.length > 1) {
    return { type: 'ambiguous', candidates: sourceMatches.map(rootCandidate) };
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
    const current = sourceMatches[0]!;
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
