import { taskNodeSourceLine, taskTreeNodes } from './taskSearchProjection';
import type { TaskSnapshot } from './types';

export interface TaskOccurrenceAddress {
  readonly filePath: string;
  readonly rootRevision: string;
  readonly rootLine: number;
  /** Physical line offset from the confirmed root, not a child index. */
  readonly nodeOffset: number;
}

export type TaskOccurrenceWitness =
  | {
      readonly kind: 'continued';
      readonly before: TaskOccurrenceAddress;
      readonly after: TaskOccurrenceAddress;
    }
  | { readonly kind: 'removed'; readonly before: TaskOccurrenceAddress }
  | {
      readonly kind: 'created';
      readonly after: TaskOccurrenceAddress;
      readonly reason?: 'recurrence';
    };

function occurrenceKey(address: TaskOccurrenceAddress): string {
  return JSON.stringify([
    address.filePath,
    address.rootRevision,
    address.rootLine,
    address.nodeOffset,
  ]);
}

function occurrenceAddresses(roots: readonly TaskSnapshot[]): readonly TaskOccurrenceAddress[] {
  return roots.flatMap((root) =>
    [...taskTreeNodes(root)].map((node) =>
      Object.freeze({
        filePath: root.source.filePath,
        rootRevision: root.ref.revision,
        rootLine: root.source.line,
        nodeOffset: taskNodeSourceLine(node.target) - root.source.line,
      }),
    ),
  );
}

/** The caller supplies the exact populations available at its proof boundary. */
export function validOccurrenceWitnesses(
  witnesses: readonly TaskOccurrenceWitness[],
  before: (address: TaskOccurrenceAddress) => boolean,
  after: (address: TaskOccurrenceAddress) => boolean,
): boolean {
  const predecessors = new Set<string>();
  const successors = new Set<string>();
  const endpoint = (
    address: TaskOccurrenceAddress,
    seen: Set<string>,
    valid: (address: TaskOccurrenceAddress) => boolean,
  ): boolean => {
    const key = occurrenceKey(address);
    if (
      !Number.isSafeInteger(address.rootLine) ||
      address.rootLine < 0 ||
      !Number.isSafeInteger(address.nodeOffset) ||
      address.nodeOffset < 0 ||
      seen.has(key) ||
      !valid(address)
    )
      return false;
    seen.add(key);
    return true;
  };
  return witnesses.every(
    (witness) =>
      (witness.kind === 'created' || endpoint(witness.before, predecessors, before)) &&
      (witness.kind === 'removed' || endpoint(witness.after, successors, after)),
  );
}

export function freezeOccurrenceWitnesses(
  witnesses: readonly TaskOccurrenceWitness[],
): readonly TaskOccurrenceWitness[] {
  return Object.freeze(
    witnesses.map((witness) =>
      Object.freeze({
        ...witness,
        ...('before' in witness ? { before: Object.freeze({ ...witness.before }) } : {}),
        ...('after' in witness ? { after: Object.freeze({ ...witness.after }) } : {}),
      }),
    ),
  );
}

/** Unproved replacement is invalidation, never evidence of authored removal. */
export function reconcileOccurrenceWitnesses(
  before: readonly TaskSnapshot[],
  after: readonly TaskSnapshot[],
  candidates: readonly TaskOccurrenceWitness[],
  replacedPaths: ReadonlySet<string>,
): {
  readonly witnesses: readonly TaskOccurrenceWitness[];
  readonly invalidated: readonly TaskOccurrenceAddress[];
} {
  const prior = occurrenceAddresses(before);
  const current = occurrenceAddresses(after);
  const priorKeys = new Set(prior.map(occurrenceKey));
  const currentKeys = new Set(current.map(occurrenceKey));
  const witnesses =
    candidates.every((witness) => {
      if (witness.kind === 'created') return !priorKeys.has(occurrenceKey(witness.after));
      return witness.kind !== 'removed' || !currentKeys.has(occurrenceKey(witness.before));
    }) &&
    validOccurrenceWitnesses(
      candidates,
      (address) => !replacedPaths.has(address.filePath) && priorKeys.has(occurrenceKey(address)),
      (address) => currentKeys.has(occurrenceKey(address)),
    )
      ? freezeOccurrenceWitnesses(candidates)
      : Object.freeze([]);
  const witnessed = new Set(
    witnesses.flatMap((value) => (value.kind === 'created' ? [] : [occurrenceKey(value.before)])),
  );
  return {
    witnesses,
    invalidated: Object.freeze(
      prior.filter(
        (address) =>
          replacedPaths.has(address.filePath) ||
          (!currentKeys.has(occurrenceKey(address)) && !witnessed.has(occurrenceKey(address))),
      ),
    ),
  };
}
