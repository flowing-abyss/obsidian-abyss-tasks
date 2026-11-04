import type { ApiResultV1, ErrorCategoryV1 } from '../../api';
import type {
  TaskAcceptedOccurrenceChange,
  TaskOccurrenceAddress,
  TaskReadNode,
  TaskStatusOccurrenceContinuation,
} from '../tasks';
import { apiError, freezeValue } from './values';

declare const reservationBrand: unique symbol;
/** Registry-owned, undisclosed capacity for one possible recurrence receipt. */
export interface TaskIdentityReservation {
  readonly [reservationBrand]: true;
}
interface IdentityRecord {
  readonly target: string;
  address: TaskOccurrenceAddress;
  state: 'retained' | 'removed' | 'unproven';
  revision: number;
  semantics: number | undefined;
  expires: number;
  pins: number;
}
type RootIndex<T> = Map<string, Map<string, Map<number, T>>>;
type AddressIndex = RootIndex<Map<number, IdentityRecord>>;
function rootAt<T>(index: RootIndex<T>, address: TaskOccurrenceAddress): T | undefined {
  return index.get(address.filePath)?.get(address.rootRevision)?.get(address.rootLine);
}
function putRoot<T>(index: RootIndex<T>, address: TaskOccurrenceAddress, value: T): void {
  let path = index.get(address.filePath);
  if (path === undefined) {
    path = new Map();
    index.set(address.filePath, path);
  }
  let revision = path.get(address.rootRevision);
  if (revision === undefined) {
    revision = new Map();
    path.set(address.rootRevision, revision);
  }
  revision.set(address.rootLine, value);
}
function sameAddress(a: TaskOccurrenceAddress, b: TaskOccurrenceAddress): boolean {
  return (
    a.filePath === b.filePath &&
    a.rootRevision === b.rootRevision &&
    a.rootLine === b.rootLine &&
    a.nodeOffset === b.nodeOffset
  );
}
const errors = {
  DISPOSED: ['lifecycle', 'Task identities are disposed.'],
  RESOURCE_LIMIT: ['resource', 'Task identity capacity is exhausted.'],
  EXPIRED_TARGET: ['unavailable', 'Task target has expired.'],
} as const satisfies Record<string, readonly [ErrorCategoryV1, string]>;
function failure(code: keyof typeof errors): ApiResultV1<never> {
  const [category, message] = errors[code];
  return freezeValue({ ok: false, error: apiError(category, code, message) });
}
type PredecessorWitness = Exclude<
  TaskAcceptedOccurrenceChange['witnesses'][number],
  { kind: 'created' }
>;
interface WitnessedIdentity {
  readonly witness: PredecessorWitness;
  readonly record: IdentityRecord;
}
function rootAddress(ref: {
  filePath: string;
  revision: string;
  line: number;
}): TaskOccurrenceAddress {
  return { filePath: ref.filePath, rootRevision: ref.revision, rootLine: ref.line, nodeOffset: 0 };
}

/** Stores only issued occurrences and accepted-operation reservations, never a source tree. */
export class TaskIdentityRegistry {
  private readonly records_abyssPrivate = new Map<string, IdentityRecord>();
  private readonly addresses_abyssPrivate: AddressIndex = new Map();
  // Successful projections move records to the end. Clock rollback disables the ordered fast path.
  private readonly idle_abyssPrivate = new Map<string, IdentityRecord>();
  private readonly reservations_abyssPrivate = new Map<TaskIdentityReservation, string>();
  private readonly claims_abyssPrivate = new WeakMap<
    TaskIdentityReservation,
    { readonly target: string }
  >();
  private readonly epoch_abyssPrivate: string;
  private readonly now_abyssPrivate: () => number;
  private readonly max_abyssPrivate: number;
  private readonly ttl_abyssPrivate: number;
  private counter_abyssPrivate = 0;
  private expiryOrdered_abyssPrivate = true;
  private latestExpiry_abyssPrivate = -Infinity;
  private disposed_abyssPrivate = false;

  constructor(options: {
    epoch: string;
    now: () => number;
    maxTargets?: number;
    idleTtlMs?: number;
  }) {
    this.epoch_abyssPrivate = options.epoch;
    this.now_abyssPrivate = options.now;
    this.max_abyssPrivate = options.maxTargets ?? 50_000;
    this.ttl_abyssPrivate = options.idleTtlMs ?? 1_800_000;
  }

  project(
    node: TaskReadNode,
    semanticsRevision: number,
  ): ApiResultV1<{ target: string; revision: string; parentTarget?: string }> {
    if (this.disposed_abyssPrivate) return failure('DISPOSED');
    this.retire_abyssPrivate();
    const addresses =
      node.parent !== undefined && !sameAddress(node.parent, node.address)
        ? [node.address, node.parent]
        : [node.address];
    const existing = addresses.map((address) => this.at_abyssPrivate(address));
    const needed = existing.filter((record) => record === undefined).length;
    if (
      !this.capacity_abyssPrivate(needed) ||
      existing.some(
        (record) =>
          record !== undefined &&
          record.semantics !== semanticsRevision &&
          record.revision >= Number.MAX_SAFE_INTEGER,
      )
    )
      return failure('RESOURCE_LIMIT');
    const records = addresses.map((address, i) => {
      const record =
        existing[i] ?? this.create_abyssPrivate(this.token_abyssPrivate(), address, 'retained');
      if (record.semantics !== undefined && record.semantics !== semanticsRevision)
        record.revision++;
      record.semantics = semanticsRevision;
      this.renew_abyssPrivate(record);
      return record;
    });
    const record = records[0];
    if (record === undefined) throw new Error('Missing projected task identity');
    return freezeValue({
      ok: true,
      value: {
        target: record.target,
        revision: this.revision_abyssPrivate(record),
        ...(records[1] !== undefined ? { parentTarget: records[1].target } : {}),
      },
    });
  }

  lookup(target: string): ApiResultV1<{
    address: TaskOccurrenceAddress;
    revision: string;
    state: 'retained' | 'removed' | 'unproven';
  }> {
    if (this.disposed_abyssPrivate) return failure('DISPOSED');
    this.retire_abyssPrivate();
    const record = this.records_abyssPrivate.get(target);
    if (record === undefined || record.expires <= this.now_abyssPrivate())
      return failure('EXPIRED_TARGET');
    return freezeValue({
      ok: true,
      value: {
        address: { ...record.address },
        revision: this.revision_abyssPrivate(record),
        state: record.state,
      },
    });
  }

  pin(target: string): ApiResultV1<() => void> {
    const found = this.lookup(target);
    if (!found.ok) return found;
    const record = this.records_abyssPrivate.get(target);
    if (record === undefined) return failure('EXPIRED_TARGET');
    record.pins++;
    let released = false;
    return Object.freeze({
      ok: true,
      value: () => {
        if (released) return;
        released = true;
        record.pins--;
        if (
          record.pins === 0 &&
          (this.disposed_abyssPrivate || record.expires <= this.now_abyssPrivate())
        )
          this.remove_abyssPrivate(record);
      },
    });
  }

  reserveNext(): ApiResultV1<TaskIdentityReservation> {
    if (this.disposed_abyssPrivate) return failure('DISPOSED');
    this.retire_abyssPrivate();
    if (!this.capacity_abyssPrivate(1)) return failure('RESOURCE_LIMIT');
    const reservation = Object.freeze({}) as TaskIdentityReservation;
    this.reservations_abyssPrivate.set(reservation, this.token_abyssPrivate());
    return Object.freeze({ ok: true, value: reservation });
  }

  claimNext(
    reservation: TaskIdentityReservation,
    continuation: TaskStatusOccurrenceContinuation,
  ): { readonly target: string } {
    const claimed = this.claims_abyssPrivate.get(reservation);
    if (claimed !== undefined) return claimed;
    const reserved = this.reservations_abyssPrivate.get(reservation);
    if (reserved === undefined) throw new Error('Task identity reservation is not active');
    this.retire_abyssPrivate();
    const target = this.claimTarget_abyssPrivate(reserved, continuation);
    this.reservations_abyssPrivate.delete(reservation);
    const result = Object.freeze({ target });
    this.claims_abyssPrivate.set(reservation, result);
    return result;
  }

  releaseReservation(reservation: TaskIdentityReservation): void {
    this.reservations_abyssPrivate.delete(reservation);
  }

  apply(change: TaskAcceptedOccurrenceChange): void {
    if (this.disposed_abyssPrivate) return;
    this.retire_abyssPrivate();
    const witnessed = this.witnessed_abyssPrivate(change);
    const matched = new Set(witnessed.map(({ record }) => record));
    for (const record of this.uncertain_abyssPrivate(change)) {
      if (!matched.has(record)) this.invalidate_abyssPrivate(record, 'unproven');
    }
    // Detach all predecessors first: physical coordinates can be reused or swapped.
    for (const { record } of witnessed) this.unlink_abyssPrivate(record);
    // Creation at byte-identical coordinates must not inherit the old handle.
    for (const witness of change.witnesses) {
      if (witness.kind === 'created') this.retireAddress_abyssPrivate(witness.after);
    }
    for (const value of witnessed) this.advance_abyssPrivate(value);
  }

  private claimTarget_abyssPrivate(
    reserved: string,
    continuation: TaskStatusOccurrenceContinuation,
  ): string {
    if (this.disposed_abyssPrivate) return reserved;
    const current = continuation.state === 'retained' ? continuation.current : undefined;
    if (current !== undefined) {
      const existing = this.at_abyssPrivate(current);
      if (existing !== undefined) return existing.target;
      this.create_abyssPrivate(reserved, current, 'retained');
    } else {
      const state = continuation.state === 'removed' ? 'removed' : 'unproven';
      this.create_abyssPrivate(reserved, continuation.origin, state);
    }
    return reserved;
  }

  private witnessed_abyssPrivate(change: TaskAcceptedOccurrenceChange): WitnessedIdentity[] {
    if (change.restored) return [];
    return change.witnesses.flatMap((witness) => {
      if (witness.kind === 'created') return [];
      const record = this.at_abyssPrivate(witness.before);
      return record === undefined ? [] : [{ witness, record }];
    });
  }

  private uncertain_abyssPrivate(change: TaskAcceptedOccurrenceChange): Set<IdentityRecord> {
    const after: RootIndex<true> = new Map();
    for (const root of change.after) putRoot(after, rootAddress(root.ref), true);
    const uncertain = new Set<IdentityRecord>();
    for (const root of change.before) {
      const address = rootAddress(root.ref);
      if (change.restored || rootAt(after, address) === undefined) {
        const records = rootAt(this.addresses_abyssPrivate, address);
        records?.forEach((record) => {
          uncertain.add(record);
        });
      }
    }
    for (const address of change.invalidated) {
      const record = this.at_abyssPrivate(address);
      if (record !== undefined) uncertain.add(record);
    }
    return uncertain;
  }

  private advance_abyssPrivate({ witness, record }: WitnessedIdentity): void {
    if (witness.kind === 'removed') {
      record.state = 'removed';
      return;
    }
    if (!sameAddress(record.address, witness.after)) {
      if (record.revision >= Number.MAX_SAFE_INTEGER) {
        record.state = 'unproven';
        return;
      }
      record.revision++;
    }
    this.retireAddress_abyssPrivate(witness.after);
    record.address = Object.freeze({ ...witness.after });
    this.link_abyssPrivate(record);
  }

  private retireAddress_abyssPrivate(address: TaskOccurrenceAddress): void {
    const prior = this.at_abyssPrivate(address);
    if (prior !== undefined) this.invalidate_abyssPrivate(prior, 'unproven');
  }

  dispose(): void {
    if (this.disposed_abyssPrivate) return;
    this.disposed_abyssPrivate = true;
    this.addresses_abyssPrivate.clear();
    this.idle_abyssPrivate.clear();
    for (const record of this.records_abyssPrivate.values())
      if (record.pins === 0) this.records_abyssPrivate.delete(record.target);
    // Accepted operations still own reservations and pins until their settlement releases them.
  }

  private capacity_abyssPrivate(count: number): boolean {
    return (
      this.records_abyssPrivate.size + this.reservations_abyssPrivate.size + count <=
        this.max_abyssPrivate && this.counter_abyssPrivate <= Number.MAX_SAFE_INTEGER - count
    );
  }
  private token_abyssPrivate(): string {
    return `${this.epoch_abyssPrivate}:t:${++this.counter_abyssPrivate}`;
  }
  private revision_abyssPrivate(record: IdentityRecord): string {
    return `${record.target}:r:${record.revision}`;
  }
  private at_abyssPrivate(address: TaskOccurrenceAddress): IdentityRecord | undefined {
    return rootAt(this.addresses_abyssPrivate, address)?.get(address.nodeOffset);
  }
  private link_abyssPrivate(record: IdentityRecord): void {
    let offsets = rootAt(this.addresses_abyssPrivate, record.address);
    if (offsets === undefined) {
      offsets = new Map();
      putRoot(this.addresses_abyssPrivate, record.address, offsets);
    }
    offsets.set(record.address.nodeOffset, record);
  }
  private unlink_abyssPrivate(record: IdentityRecord): void {
    const { filePath, rootRevision, rootLine, nodeOffset } = record.address;
    const path = this.addresses_abyssPrivate.get(filePath);
    if (path === undefined) return;
    const revision = path.get(rootRevision);
    if (revision === undefined) return;
    const offsets = revision.get(rootLine);
    if (offsets?.get(nodeOffset) !== record) return;
    offsets.delete(nodeOffset);
    if (offsets.size === 0) revision.delete(rootLine);
    if (revision.size === 0) path.delete(rootRevision);
    if (path.size === 0) this.addresses_abyssPrivate.delete(filePath);
  }

  private create_abyssPrivate(
    target: string,
    address: TaskOccurrenceAddress,
    state: IdentityRecord['state'],
  ): IdentityRecord {
    const record: IdentityRecord = {
      target,
      address: Object.freeze({ ...address }),
      state,
      revision: 1,
      semantics: undefined,
      expires: 0,
      pins: 0,
    };
    this.records_abyssPrivate.set(target, record);
    if (state === 'retained') this.link_abyssPrivate(record);
    this.renew_abyssPrivate(record);
    return record;
  }
  private renew_abyssPrivate(record: IdentityRecord): void {
    record.expires = this.now_abyssPrivate() + this.ttl_abyssPrivate;
    this.idle_abyssPrivate.delete(record.target);
    if (this.idle_abyssPrivate.size === 0) this.expiryOrdered_abyssPrivate = true;
    else if (record.expires < this.latestExpiry_abyssPrivate)
      this.expiryOrdered_abyssPrivate = false;
    this.latestExpiry_abyssPrivate = record.expires;
    this.idle_abyssPrivate.set(record.target, record);
  }
  private invalidate_abyssPrivate(record: IdentityRecord, state: 'removed' | 'unproven'): void {
    this.unlink_abyssPrivate(record);
    record.state = state;
  }
  private remove_abyssPrivate(record: IdentityRecord): void {
    this.unlink_abyssPrivate(record);
    this.records_abyssPrivate.delete(record.target);
    this.idle_abyssPrivate.delete(record.target);
  }
  private retire_abyssPrivate(): void {
    const now = this.now_abyssPrivate();
    for (const record of this.idle_abyssPrivate.values()) {
      if (record.expires > now) {
        if (this.expiryOrdered_abyssPrivate) break;
        continue;
      }
      this.idle_abyssPrivate.delete(record.target);
      if (record.pins === 0) this.remove_abyssPrivate(record);
    }
  }
}
