import { localDate, shiftLocalDate, type TaskApplicationApi, type TaskSnapshot } from '../../tasks';
import { isRealmHTMLElement } from '../../ui/domRealm';
import { presentTaskCommandResult } from '../../ui/taskCommandResult';
import { TimedBlockKeyboardQueue } from '../../ui/timedBlockKeyboardQueue';
import { calendarRootTaskRef } from '../../views/calendarOccurrences';
import type { TimedBlockKeyboardIntent } from '../../views/timegrid/renderTimedBlocks';

interface TimedBlockFocusLocator {
  readonly filePath: string;
  readonly line: number;
  readonly segmentDate?: string;
  readonly sequence: number;
  readonly queueSequence?: number;
  readonly originElement?: HTMLElement;
}

interface PendingTimedBlockRestoration {
  readonly queueSequence: number;
  readonly focusSequence: number;
  readonly renderGeneration: number;
}

export interface TimedBlockFocusRetentionHost {
  /** Whether the centre panel currently shows the calendar (restorations and commits need it). */
  readonly isCalendarActive: () => boolean;
  /** The centre panel element while mounted, null before mount and after destroy. */
  readonly root: () => HTMLElement | null;
  /** Re-anchors the calendar on the task a keyboard shift moved out of view. */
  readonly follow: (updated: TaskSnapshot, nextSegmentDate: string | undefined) => void;
}

function findTimedBlock(
  container: HTMLElement,
  locator: Pick<TimedBlockFocusLocator, 'filePath' | 'line' | 'segmentDate'>,
): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('.abyss-tg-block')).find(
    (block) =>
      block.dataset['abyssTaskFile'] === locator.filePath &&
      block.dataset['abyssTaskLine'] === String(locator.line) &&
      (locator.segmentDate === undefined || block.dataset['tgSegmentDate'] === locator.segmentDate),
  );
}

function isRestorableTimedBlock(
  candidate: HTMLElement | undefined,
  container: HTMLElement,
): candidate is HTMLElement {
  return (
    candidate !== undefined &&
    candidate.isConnected &&
    isRealmHTMLElement(candidate) &&
    candidate.ownerDocument === container.ownerDocument
  );
}

function shiftFocusedSegmentDate(
  pending: TimedBlockFocusLocator,
  intent: TimedBlockKeyboardIntent,
  changed: boolean,
): string | undefined {
  if (!changed || intent.type !== 'shift-schedule' || pending.segmentDate === undefined) {
    return pending.segmentDate;
  }
  try {
    return shiftLocalDate(localDate(pending.segmentDate), intent.days);
  } catch {
    return pending.segmentDate;
  }
}

/**
 * Keeps keyboard focus on a timed block across the re-renders its own commands cause. Owns the
 * keyboard queue, the pending focus locator, and the per-sequence bookkeeping; restores focus on
 * the owning window's next timer tick once the committed render is on screen.
 */
export class TimedBlockFocusRetention {
  private readonly queue_abyssPrivate: TimedBlockKeyboardQueue | null;
  private pendingFocus_abyssPrivate: TimedBlockFocusLocator | undefined;
  private readonly settledSequences_abyssPrivate = new Set<number>();
  private readonly restoredSequences_abyssPrivate = new Set<number>();
  private readonly committedSequences_abyssPrivate = new Set<number>();
  private readonly pendingRestorations_abyssPrivate = new Map<
    number,
    PendingTimedBlockRestoration
  >();
  private nextRestoration_abyssPrivate = 0;
  private nextFocusSequence_abyssPrivate = 0;
  private renderGeneration_abyssPrivate = 0;

  constructor(
    tasks: TaskApplicationApi | undefined,
    private readonly host_abyssPrivate: TimedBlockFocusRetentionHost,
  ) {
    this.queue_abyssPrivate =
      tasks == null
        ? null
        : new TimedBlockKeyboardQueue(tasks, {
            onCommitted: (task, intent, sequence, changed) => {
              this.handleCommit_abyssPrivate(task, intent, sequence, changed);
            },
            onSettled: (_taskKey, sequence, summary) => {
              this.handleSettled_abyssPrivate(sequence, summary.anyChanged, summary.sourceChanged);
            },
            present: (result) => {
              presentTaskCommandResult(result);
              if (result.type !== 'ok' || result.outcome.type !== 'task') {
                this.clearFocus_abyssPrivate();
              }
            },
          });
  }

  handleIntent(task: TaskSnapshot, intent: TimedBlockKeyboardIntent): void {
    const root = this.host_abyssPrivate.root();
    if (calendarRootTaskRef(task) === undefined || this.queue_abyssPrivate == null || root == null)
      return;
    const active = root.ownerDocument.activeElement;
    const originElement = isRealmHTMLElement(active)
      ? (active.closest<HTMLElement>('.abyss-tg-block') ?? undefined)
      : undefined;
    const previousQueueSequence = this.pendingFocus_abyssPrivate?.queueSequence;
    const provisionalFocus = this.provisionalFocus_abyssPrivate(task, originElement);
    this.pendingFocus_abyssPrivate = provisionalFocus;
    const queueSequence = this.queue_abyssPrivate.enqueue(task, intent);
    if (queueSequence === undefined) {
      this.handleRejectedIntent_abyssPrivate(provisionalFocus.sequence, previousQueueSequence);
      return;
    }
    this.acceptIntent_abyssPrivate(provisionalFocus, queueSequence, previousQueueSequence);
  }

  /** The former retainTimedBlockFocus: a block inside the panel received focus. */
  retain(block: HTMLElement): void {
    const filePath = block.dataset['abyssTaskFile'];
    const lineText = block.dataset['abyssTaskLine'];
    if (filePath === undefined || lineText === undefined) return;
    const line = Number(lineText);
    if (!Number.isInteger(line)) return;
    const segmentDate = block.dataset['tgSegmentDate'];

    const pending = this.pendingFocus_abyssPrivate;
    if (this.isDifferentPreCommitOrigin_abyssPrivate(block, pending)) {
      this.replacePreCommitFocus_abyssPrivate(block, pending.queueSequence, {
        filePath,
        line,
        ...(segmentDate !== undefined && { segmentDate }),
      });
      return;
    }
    if (this.sameFocus_abyssPrivate(pending, filePath, line, segmentDate)) return;
    if (pending?.queueSequence !== undefined) {
      this.queue_abyssPrivate?.cancel();
      this.clearSequenceState_abyssPrivate(pending.queueSequence);
    }
    this.pendingFocus_abyssPrivate = this.createFocus_abyssPrivate(
      block,
      filePath,
      line,
      segmentDate,
    );
  }

  hasPending(): boolean {
    return this.pendingFocus_abyssPrivate != null;
  }

  cancel(): void {
    this.queue_abyssPrivate?.cancel();
    this.pendingFocus_abyssPrivate = undefined;
    this.settledSequences_abyssPrivate.clear();
    this.restoredSequences_abyssPrivate.clear();
    this.committedSequences_abyssPrivate.clear();
    this.pendingRestorations_abyssPrivate.clear();
    this.renderGeneration_abyssPrivate += 1;
  }

  captureActiveFocus(root: HTMLElement): void {
    if (this.pendingFocus_abyssPrivate?.queueSequence !== undefined) return;
    const active = root.ownerDocument.activeElement;
    if (!isRealmHTMLElement(active) || !root.contains(active)) return;
    const block = active.closest<HTMLElement>('.abyss-tg-block');
    if (block == null) return;
    this.retain(block);
  }

  /** Before a view mount or patch: the coming render must restore this sequence again. */
  beforeViewUpdate(): void {
    const queueSequence = this.pendingFocus_abyssPrivate?.queueSequence;
    if (queueSequence !== undefined) this.restoredSequences_abyssPrivate.delete(queueSequence);
  }

  beginRender(): number {
    return ++this.renderGeneration_abyssPrivate;
  }

  deferFocus(container: HTMLElement, renderGeneration: number): void {
    const scheduled = this.pendingFocus_abyssPrivate;
    if (scheduled == null) return;
    const focusSequence = scheduled.sequence;
    const queueSequence = scheduled.queueSequence;
    if (queueSequence !== undefined && !this.committedSequences_abyssPrivate.has(queueSequence))
      return;

    const scheduledCandidate = findTimedBlock(container, scheduled);
    if (queueSequence !== undefined && scheduledCandidate === scheduled.originElement) return;
    const ownerWindow = container.ownerDocument.defaultView;
    if (ownerWindow === null) return;
    const restorationId = this.reserveRestoration_abyssPrivate(
      scheduledCandidate,
      scheduled,
      renderGeneration,
    );

    ownerWindow.setTimeout(() => {
      this.restoreDeferredFocus_abyssPrivate(container, {
        focusSequence,
        renderGeneration,
        ...(restorationId !== undefined && { restorationId }),
      });
    }, 0);
  }

  /** Defers the pending focus against the mounted panel; a null root is a no-op. */
  private deferFocusAtRoot_abyssPrivate(): void {
    const root = this.host_abyssPrivate.root();
    if (root !== null) this.deferFocus(root, this.renderGeneration_abyssPrivate);
  }

  private handleSettled_abyssPrivate(
    sequence: number,
    anyChanged: boolean,
    sourceChanged: boolean,
  ): void {
    if (this.pendingFocus_abyssPrivate?.queueSequence !== sequence) return;
    if ((anyChanged || sourceChanged) && !this.committedSequences_abyssPrivate.has(sequence)) {
      this.committedSequences_abyssPrivate.add(sequence);
      this.deferFocusAtRoot_abyssPrivate();
    }
    const pendingRestoration = this.hasPendingRestoration_abyssPrivate(sequence);
    if (
      (!anyChanged && !sourceChanged && !pendingRestoration) ||
      this.restoredSequences_abyssPrivate.has(sequence)
    ) {
      this.clearFocus_abyssPrivate(sequence);
      return;
    }
    this.settledSequences_abyssPrivate.add(sequence);
  }

  private provisionalFocus_abyssPrivate(
    task: TaskSnapshot,
    originElement: HTMLElement | undefined,
  ): TimedBlockFocusLocator {
    const segmentDate = originElement?.dataset['tgSegmentDate'];
    return {
      filePath: task.source.filePath,
      line: task.source.line,
      ...(segmentDate !== undefined && { segmentDate }),
      sequence: ++this.nextFocusSequence_abyssPrivate,
      ...(originElement !== undefined && { originElement }),
    };
  }

  private handleRejectedIntent_abyssPrivate(
    focusSequence: number,
    previousQueueSequence: number | undefined,
  ): void {
    if (this.pendingFocus_abyssPrivate?.sequence === focusSequence) this.clearFocus_abyssPrivate();
    if (previousQueueSequence !== undefined)
      this.clearSequenceState_abyssPrivate(previousQueueSequence);
  }

  private acceptIntent_abyssPrivate(
    provisionalFocus: TimedBlockFocusLocator,
    queueSequence: number,
    previousQueueSequence: number | undefined,
  ): void {
    if (this.pendingFocus_abyssPrivate?.sequence !== provisionalFocus.sequence) return;
    if (previousQueueSequence !== undefined && previousQueueSequence !== queueSequence) {
      this.clearSequenceState_abyssPrivate(previousQueueSequence);
    }
    this.settledSequences_abyssPrivate.delete(queueSequence);
    if (previousQueueSequence !== queueSequence) {
      this.restoredSequences_abyssPrivate.delete(queueSequence);
      this.committedSequences_abyssPrivate.delete(queueSequence);
    }
    this.pendingFocus_abyssPrivate = { ...provisionalFocus, queueSequence };
  }

  private isDifferentPreCommitOrigin_abyssPrivate(
    block: HTMLElement,
    pending: TimedBlockFocusLocator | undefined,
  ): pending is TimedBlockFocusLocator & { readonly queueSequence: number } {
    return (
      pending?.queueSequence !== undefined &&
      !this.committedSequences_abyssPrivate.has(pending.queueSequence) &&
      pending.originElement !== undefined &&
      block !== pending.originElement
    );
  }

  private replacePreCommitFocus_abyssPrivate(
    block: HTMLElement,
    queueSequence: number,
    locator: Pick<TimedBlockFocusLocator, 'filePath' | 'line' | 'segmentDate'>,
  ): void {
    this.queue_abyssPrivate?.cancel();
    this.clearFocus_abyssPrivate(queueSequence);
    this.pendingFocus_abyssPrivate = this.createFocus_abyssPrivate(
      block,
      locator.filePath,
      locator.line,
      locator.segmentDate,
    );
  }

  private sameFocus_abyssPrivate(
    pending: TimedBlockFocusLocator | undefined,
    filePath: string,
    line: number,
    segmentDate: string | undefined,
  ): boolean {
    return (
      pending?.filePath === filePath && pending.line === line && pending.segmentDate === segmentDate
    );
  }

  private createFocus_abyssPrivate(
    block: HTMLElement,
    filePath: string,
    line: number,
    segmentDate: string | undefined,
  ): TimedBlockFocusLocator {
    return {
      filePath,
      line,
      ...(segmentDate !== undefined && { segmentDate }),
      sequence: ++this.nextFocusSequence_abyssPrivate,
      originElement: block,
    };
  }

  private reserveRestoration_abyssPrivate(
    candidate: HTMLElement | undefined,
    scheduled: TimedBlockFocusLocator,
    renderGeneration: number,
  ): number | undefined {
    const queueSequence = scheduled.queueSequence;
    if (
      queueSequence === undefined ||
      candidate?.isConnected !== true ||
      candidate === scheduled.originElement
    ) {
      return undefined;
    }
    const restorationId = ++this.nextRestoration_abyssPrivate;
    this.pendingRestorations_abyssPrivate.set(restorationId, {
      queueSequence,
      focusSequence: scheduled.sequence,
      renderGeneration,
    });
    return restorationId;
  }

  private restoreDeferredFocus_abyssPrivate(
    container: HTMLElement,
    options: {
      readonly focusSequence: number;
      readonly renderGeneration: number;
      readonly restorationId?: number;
    },
  ): void {
    if (!this.canRunRestoration_abyssPrivate(options)) return;
    const pending = this.pendingFocus_abyssPrivate;
    if (!this.isPendingRestorable_abyssPrivate(pending, options.focusSequence)) return;
    const candidate = findTimedBlock(container, pending);
    if (!isRestorableTimedBlock(candidate, container)) return;
    candidate.focus();
    candidate.classList.add('is-selected');
    if (!this.didRestore_abyssPrivate(candidate, pending.sequence)) return;
    this.finishRestoration_abyssPrivate(pending.queueSequence);
  }

  private canRunRestoration_abyssPrivate(options: {
    readonly renderGeneration: number;
    readonly restorationId?: number;
  }): boolean {
    if (
      options.restorationId !== undefined &&
      !this.pendingRestorations_abyssPrivate.delete(options.restorationId)
    ) {
      return false;
    }
    return options.renderGeneration === this.renderGeneration_abyssPrivate;
  }

  private isPendingRestorable_abyssPrivate(
    pending: TimedBlockFocusLocator | undefined,
    focusSequence: number,
  ): pending is TimedBlockFocusLocator {
    if (pending?.sequence !== focusSequence || !this.host_abyssPrivate.isCalendarActive())
      return false;
    return (
      pending.queueSequence === undefined ||
      this.committedSequences_abyssPrivate.has(pending.queueSequence)
    );
  }

  private didRestore_abyssPrivate(candidate: HTMLElement, sequence: number): boolean {
    return (
      candidate.ownerDocument.activeElement === candidate &&
      this.pendingFocus_abyssPrivate?.sequence === sequence
    );
  }

  private finishRestoration_abyssPrivate(queueSequence: number | undefined): void {
    if (queueSequence === undefined) {
      this.clearFocus_abyssPrivate();
      return;
    }
    this.restoredSequences_abyssPrivate.add(queueSequence);
    if (this.settledSequences_abyssPrivate.has(queueSequence))
      this.clearFocus_abyssPrivate(queueSequence);
  }

  private clearFocus_abyssPrivate(queueSequence?: number): void {
    const pending = this.pendingFocus_abyssPrivate;
    if (queueSequence !== undefined && pending?.queueSequence !== queueSequence) return;
    const ownedSequence = pending?.queueSequence ?? queueSequence;
    if (ownedSequence !== undefined) {
      this.clearSequenceState_abyssPrivate(ownedSequence);
    }
    this.pendingFocus_abyssPrivate = undefined;
  }

  private hasPendingRestoration_abyssPrivate(queueSequence: number): boolean {
    const pending = this.pendingFocus_abyssPrivate;
    if (pending?.queueSequence !== queueSequence) return false;
    return Array.from(this.pendingRestorations_abyssPrivate.values()).some(
      (restoration) =>
        restoration.queueSequence === queueSequence &&
        restoration.focusSequence === pending.sequence &&
        restoration.renderGeneration === this.renderGeneration_abyssPrivate,
    );
  }

  private clearSequenceState_abyssPrivate(queueSequence: number): void {
    this.settledSequences_abyssPrivate.delete(queueSequence);
    this.restoredSequences_abyssPrivate.delete(queueSequence);
    this.committedSequences_abyssPrivate.delete(queueSequence);
    for (const [id, restoration] of this.pendingRestorations_abyssPrivate) {
      if (restoration.queueSequence === queueSequence) {
        this.pendingRestorations_abyssPrivate.delete(id);
      }
    }
  }

  private handleCommit_abyssPrivate(
    updated: TaskSnapshot,
    intent: TimedBlockKeyboardIntent,
    queueSequence: number,
    changed: boolean,
  ): void {
    const pending = this.pendingFocus_abyssPrivate;
    if (!this.acceptsCommit_abyssPrivate(pending, queueSequence)) return;
    this.committedSequences_abyssPrivate.add(queueSequence);
    const sourceChanged =
      pending.filePath !== updated.source.filePath || pending.line !== updated.source.line;
    const nextSegmentDate = shiftFocusedSegmentDate(pending, intent, changed);
    const segmentChanged = nextSegmentDate !== pending.segmentDate;
    const identityChanged = [sourceChanged, segmentChanged].includes(true);
    const presentationChanged = [changed, identityChanged].includes(true);
    if (presentationChanged) this.restoredSequences_abyssPrivate.delete(queueSequence);
    if (identityChanged) {
      this.pendingFocus_abyssPrivate = {
        ...pending,
        filePath: updated.source.filePath,
        line: updated.source.line,
        ...(nextSegmentDate !== undefined && { segmentDate: nextSegmentDate }),
        sequence: ++this.nextFocusSequence_abyssPrivate,
      };
    }
    if (presentationChanged || !this.restoredSequences_abyssPrivate.has(queueSequence)) {
      this.deferFocusAtRoot_abyssPrivate();
    }
    if (intent.type === 'shift-schedule') this.host_abyssPrivate.follow(updated, nextSegmentDate);
  }

  private acceptsCommit_abyssPrivate(
    pending: TimedBlockFocusLocator | undefined,
    queueSequence: number,
  ): pending is TimedBlockFocusLocator {
    return pending?.queueSequence === queueSequence && this.host_abyssPrivate.isCalendarActive();
  }
}
