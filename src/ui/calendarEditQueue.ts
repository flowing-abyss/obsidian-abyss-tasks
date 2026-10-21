import {
  type TaskApplicationApi,
  type TaskCommand,
  type TaskCommandResult,
  type TaskSnapshot,
} from '../tasks';
import { calendarOccurrenceForRender } from '../views/calendarOccurrences';
import { calendarEditWitness } from './calendarEditWitness';
import { calendarTaskWithOwnedRoot } from './calendarOwnedTask';
import {
  proveOwnedRootPlanningReceipt,
  proveOwnedTaskSelection,
  type OwnedTaskSelectionProof,
} from './ownedTaskSelection';
import { runAsyncAction } from './runAsyncAction';

interface LineageState {
  current: TaskSnapshot;
  currentKey: string;
  valid: boolean;
}
interface Lineage {
  state: LineageState | { readonly successor: Lineage };
}
function currentLineage(lineage: Lineage): { owner: Lineage; state: LineageState } {
  if (!('successor' in lineage.state)) return { owner: lineage, state: lineage.state };
  const current = currentLineage(lineage.state.successor);
  lineage.state = { successor: current.owner };
  return current;
}
interface CapturedSource {
  readonly task: TaskSnapshot;
  readonly lineage: Lineage;
}
export interface CalendarEditReceipt {
  readonly previous: TaskSnapshot;
  readonly command: TaskCommand;
  readonly result: TaskCommandResult;
  readonly proof: OwnedTaskSelectionProof | undefined;
}
export type CalendarEditExecutor = (
  build: (current: TaskSnapshot) => TaskCommand | undefined,
) => Promise<CalendarEditReceipt | undefined>;

function ownedReceiptProof(
  root: TaskSnapshot,
  command: TaskCommand,
  result: TaskCommandResult,
): OwnedTaskSelectionProof | undefined {
  if (result.type !== 'ok' || result.outcome.type !== 'task') return undefined;
  return (
    proveOwnedTaskSelection(result.outcome.task, [root], command) ??
    proveOwnedRootPlanningReceipt(result.outcome.task, root, command)
  );
}

/** Serializes accepted edits; only whole-tree owned receipts advance captured source authority. */
export class CalendarEditQueue {
  private readonly roots_abyssPrivate = new Map<string, Lineage>();
  private rendered_abyssPrivate = new Set<string>();
  private readonly pending_abyssPrivate: Array<() => Promise<void>> = [];
  private processing_abyssPrivate = false;

  constructor(private readonly api_abyssPrivate: TaskApplicationApi) {}

  private identity_abyssPrivate(root: TaskSnapshot): string {
    return JSON.stringify([root.ref.filePath, root.ref.line, root.ref.revision]);
  }

  private capture_abyssPrivate(task: TaskSnapshot): CapturedSource {
    const root = calendarOccurrenceForRender(task).source.root;
    const key = this.identity_abyssPrivate(root);
    let lineage = this.roots_abyssPrivate.get(key);
    if (lineage === undefined) {
      lineage = { state: { current: root, currentKey: key, valid: true } };
      this.roots_abyssPrivate.set(key, lineage);
    }
    this.rendered_abyssPrivate.add(key);
    return { task, lineage };
  }

  /** Visibility pins exact source refs for gestures that have started but not submitted yet. */
  retainRendered(roots: readonly TaskSnapshot[]): void {
    this.rendered_abyssPrivate = new Set(
      [...new Set(roots)].map((root) => this.identity_abyssPrivate(root)),
    );
    for (const [key, lineage] of this.roots_abyssPrivate) {
      if (key !== currentLineage(lineage).state.currentKey && !this.rendered_abyssPrivate.has(key))
        this.roots_abyssPrivate.delete(key);
    }
  }

  private resolve_abyssPrivate(captured: CapturedSource): TaskSnapshot | undefined {
    const { state } = currentLineage(captured.lineage);
    if (!state.valid) return undefined;
    const occurrence = calendarOccurrenceForRender(captured.task);
    const current = state.current;
    // Even an unchanged ref may be displayed with speculative planning from another pending edit.
    return calendarTaskWithOwnedRoot(occurrence, { before: occurrence.source.root, current });
  }

  execute(
    task: TaskSnapshot,
    build: (current: TaskSnapshot) => TaskCommand | undefined,
  ): Promise<CalendarEditReceipt | undefined> {
    return this.capture(task)(build);
  }

  /** Bind at input acceptance, even when keyboard repeats defer their eventual dispatch. */
  capture(task: TaskSnapshot): CalendarEditExecutor {
    const captured = this.capture_abyssPrivate(task);
    return (build) =>
      this.enqueue_abyssPrivate(async () => {
        try {
          const previous = this.resolve_abyssPrivate(captured);
          const command = previous === undefined ? undefined : build(previous);
          if (previous === undefined || command === undefined) return undefined;
          const issued = calendarEditWitness(previous, command);
          let prepared = issued;
          const result = await this.api_abyssPrivate.execute(command, {
            onPreparedPatch: (patch) => {
              // Preparation may rebase the target; proof still belongs to the issued source.
              prepared = calendarEditWitness(
                previous,
                issued.type === 'patch' ? { ...issued, patch: patch.patch } : patch,
              );
            },
          });
          const root = calendarOccurrenceForRender(previous).source.root;
          const proof = ownedReceiptProof(root, prepared, result);
          if (proof !== undefined && result.type === 'ok' && result.outcome.type === 'task') {
            this.advance_abyssPrivate(captured.lineage, result.outcome.task);
          } else this.invalidate_abyssPrivate(captured.lineage);
          return { previous, command: prepared, result, proof };
        } catch (error) {
          this.invalidate_abyssPrivate(captured.lineage);
          throw error;
        }
      });
  }

  /** Existing inert actions use the proved predecessor, then require fresh canonical publication. */
  runAfter(task: TaskSnapshot, action: (current: TaskSnapshot) => Promise<void>): Promise<void> {
    const captured = this.capture_abyssPrivate(task);
    return this.enqueue_abyssPrivate(async () => {
      const current = this.resolve_abyssPrivate(captured);
      if (current === undefined) return;
      try {
        await action(current);
      } finally {
        this.invalidate_abyssPrivate(captured.lineage);
      }
    });
  }

  private enqueue_abyssPrivate<T>(action: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.pending_abyssPrivate.push(async () => {
        try {
          resolve(await action());
        } catch (error) {
          reject(
            error instanceof Error ? error : new Error(`Calendar edit failed: ${String(error)}`),
          );
        }
      });
      this.next_abyssPrivate();
    });
  }

  private advance_abyssPrivate(lineage: Lineage, current: TaskSnapshot): void {
    const { owner, state } = currentLineage(lineage);
    const key = this.identity_abyssPrivate(current);
    const alias = this.roots_abyssPrivate.get(key);
    if (alias !== undefined) {
      const existing = currentLineage(alias);
      // A remount may expose this exact committed ref before its proved receipt arrives.
      if (existing.owner !== owner && existing.state.valid && existing.state.currentKey === key)
        existing.owner.state = { successor: owner };
    }
    if (!this.rendered_abyssPrivate.has(state.currentKey))
      this.roots_abyssPrivate.delete(state.currentKey);
    state.current = current;
    state.currentKey = key;
    this.roots_abyssPrivate.set(key, owner);
  }

  private invalidate_abyssPrivate(lineage: Lineage): void {
    const { owner, state } = currentLineage(lineage);
    state.valid = false;
    // Queued captures keep this invalid object. A fresh gesture can try its explicit source again.
    for (const [key, value] of this.roots_abyssPrivate) {
      if (currentLineage(value).owner === owner) this.roots_abyssPrivate.delete(key);
    }
  }

  /** Only a publication after settlement can retire the retained DOM's source aliases. */
  published(): void {
    if (this.processing_abyssPrivate || this.pending_abyssPrivate.length > 0) return;
    this.roots_abyssPrivate.clear();
    this.rendered_abyssPrivate.clear();
  }

  private next_abyssPrivate(): void {
    if (this.processing_abyssPrivate) return;
    const action = this.pending_abyssPrivate.shift();
    if (action === undefined) return;
    this.processing_abyssPrivate = true;
    runAsyncAction(
      action().finally(() => {
        this.processing_abyssPrivate = false;
        this.next_abyssPrivate();
      }),
    );
  }
}
