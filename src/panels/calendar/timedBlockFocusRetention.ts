import {
  localDate,
  shiftLocalDate,
  taskNodeSourceLine,
  type TaskApplicationApi,
  type TaskNodeRef,
  type TaskSnapshot,
} from '../../tasks';
import type { CalendarEditQueue } from '../../ui/calendarEditQueue';
import { isRealmHTMLElement } from '../../ui/domRealm';
import { presentTaskCommandResult } from '../../ui/taskCommandResult';
import { renderedTaskNodeElements } from '../../ui/taskPresentationIdentity';
import { TimedBlockKeyboardQueue } from '../../ui/timedBlockKeyboardQueue';
import {
  calendarMutationTarget,
  calendarOccurrenceForRender,
} from '../../views/calendarOccurrences';
import type { TimedBlockKeyboardIntent } from '../../views/timegrid/renderTimedBlocks';

interface TimedBlockFocusLocator {
  readonly filePath: string;
  readonly line: number;
  readonly segmentDate?: string;
  readonly sequence: number;
  readonly queueSequence?: number;
  readonly originElement?: HTMLElement;
  readonly suppressFollow?: boolean;
  readonly noopTarget?: TaskNodeRef | undefined;
}

export interface TimedBlockFocusRetentionHost {
  readonly editQueue?: CalendarEditQueue | undefined;
  /** Whether the centre panel currently shows the calendar (restorations and commits need it). */
  readonly isCalendarActive: () => boolean;
  /** The panel element of the last calendar render; null until the first render. */
  readonly root: () => HTMLElement | null;
  readonly holdPublication?: () => () => void;
  /** Re-anchors the calendar on the task a keyboard shift moved out of view. */
  readonly follow: (updated: TaskSnapshot, nextSegmentDate: string | undefined) => void;
}

function shouldFollowCommit(
  pending: TimedBlockFocusLocator,
  intent: TimedBlockKeyboardIntent,
  segmentChanged: boolean,
): boolean {
  return (
    pending.suppressFollow !== true &&
    [intent.type === 'shift-schedule', segmentChanged].includes(true)
  );
}

function findTimedBlock(
  container: HTMLElement,
  locator: Pick<TimedBlockFocusLocator, 'filePath' | 'line' | 'segmentDate'>,
  projectedOrigin?: HTMLElement,
): HTMLElement | undefined {
  const blocks = Array.from(container.querySelectorAll<HTMLElement>('.abyss-tg-block'));
  const sourceKey = projectedOrigin?.dataset['abyssTaskNodeRefKey'];
  if (sourceKey !== undefined)
    return blocks.find(
      (block) =>
        block.dataset['abyssTaskNodeRefKey'] === sourceKey &&
        (locator.segmentDate === undefined ||
          block.dataset['tgSegmentDate'] === locator.segmentDate),
    );
  return blocks.find(
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

function clampFocusedSegmentDate(updated: TaskSnapshot, date: string): string {
  const occurrence = calendarOccurrenceForRender(updated);
  if (occurrence.kind !== 'materialized') return date;
  const occupied = occurrence.occupied;
  if (occupied.kind === 'point') return occupied.date;
  if (date < occupied.start) return occupied.start;
  return date > occupied.due ? occupied.due : date;
}

function shiftFocusedSegmentDate(
  pending: TimedBlockFocusLocator,
  intent: TimedBlockKeyboardIntent,
  changed: boolean,
  updated: TaskSnapshot,
): string | undefined {
  const date = pending.segmentDate;
  if (!changed || date === undefined || pending.suppressFollow === true) return date;
  if (intent.type === 'extend-due') return clampFocusedSegmentDate(updated, date);
  if (intent.type !== 'shift-schedule') return date;
  try {
    return shiftLocalDate(localDate(date), intent.days);
  } catch {
    return date;
  }
}

/**
 * Keeps keyboard focus on a timed block across the re-renders its own commands cause. Owns the
 * keyboard queue, the pending focus locator, and the per-sequence bookkeeping. A committed
 * replacement receives focus in the publication turn so native repeated keys keep their target.
 */
export class TimedBlockFocusRetention {
  private readonly queue_abyssPrivate: TimedBlockKeyboardQueue | null;
  private pendingFocus_abyssPrivate: TimedBlockFocusLocator | undefined;
  private readonly settledSequences_abyssPrivate = new Set<number>();
  private readonly restoredSequences_abyssPrivate = new Set<number>();
  private readonly committedSequences_abyssPrivate = new Set<number>();
  private nextFocusSequence_abyssPrivate = 0;
  private renderGeneration_abyssPrivate = 0;
  private submittedProjection_abyssPrivate = false;

  constructor(
    tasks: TaskApplicationApi | undefined,
    private readonly host_abyssPrivate: TimedBlockFocusRetentionHost,
  ) {
    this.queue_abyssPrivate =
      tasks == null
        ? null
        : new TimedBlockKeyboardQueue(
            tasks,
            {
              ...(host_abyssPrivate.holdPublication !== undefined && {
                holdPublication: host_abyssPrivate.holdPublication,
              }),
              onCommitted: (task, intent, sequence, changed) => {
                this.handleCommit_abyssPrivate(task, intent, sequence, changed);
              },
              onNoop: (task, sequence) => {
                this.handleNoop_abyssPrivate(task, sequence);
              },
              onSettled: (_taskKey, sequence, summary) => {
                this.handleSettled_abyssPrivate(
                  sequence,
                  summary.anyChanged,
                  summary.sourceChanged,
                );
              },
              onInvalidated: () => {
                this.clearFocus_abyssPrivate();
              },
              present: (result) => {
                presentTaskCommandResult(result);
                if (result.type !== 'ok' || result.outcome.type !== 'task') {
                  this.clearFocus_abyssPrivate();
                }
              },
            },
            host_abyssPrivate.editQueue,
          );
  }

  handleIntent(task: TaskSnapshot, intent: TimedBlockKeyboardIntent): void {
    const root = this.host_abyssPrivate.root();
    if (
      calendarMutationTarget(task) === undefined ||
      this.queue_abyssPrivate == null ||
      root == null
    )
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

  /** Records that a block inside the panel received focus. */
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
    if (this.sameFocus_abyssPrivate(pending, filePath, line, block)) return;
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

  settlePointerTask(
    task: TaskSnapshot,
    segmentDate?: string,
  ): TaskSnapshot | Promise<TaskSnapshot> {
    const root = this.host_abyssPrivate.root();
    if (root !== null) this.captureActiveFocus(root);
    const pending = this.pendingFocus_abyssPrivate;
    const sameSource = this.isPointerSource_abyssPrivate(task, pending);
    if (pending !== undefined)
      this.pendingFocus_abyssPrivate = {
        ...pending,
        ...(sameSource && segmentDate !== undefined && { segmentDate }),
        suppressFollow: true,
      };
    return this.queue_abyssPrivate?.settlePointerTask(task) ?? task;
  }

  private isSubmittedOrigin_abyssPrivate(
    block: HTMLElement,
    pending: TimedBlockFocusLocator | undefined,
  ): boolean {
    return (
      this.submittedProjection_abyssPrivate &&
      (pending?.suppressFollow === true || pending?.noopTarget !== undefined) &&
      pending.originElement === block
    );
  }

  private isPointerSource_abyssPrivate(
    task: TaskSnapshot,
    pending: TimedBlockFocusLocator | undefined,
  ): boolean {
    const target = calendarOccurrenceForRender(task).source.target;
    const root = this.host_abyssPrivate.root();
    const origin = pending?.originElement;
    const sameOrigin =
      root !== null &&
      origin !== undefined &&
      renderedTaskNodeElements(root, target).includes(origin);
    return (
      sameOrigin ||
      (!this.submittedProjection_abyssPrivate &&
        pending?.filePath === task.source.filePath &&
        pending.line === taskNodeSourceLine(target))
    );
  }

  cancel(): void {
    this.queue_abyssPrivate?.cancel();
    this.pendingFocus_abyssPrivate = undefined;
    this.settledSequences_abyssPrivate.clear();
    this.restoredSequences_abyssPrivate.clear();
    this.committedSequences_abyssPrivate.clear();
    this.renderGeneration_abyssPrivate += 1;
  }

  captureActiveFocus(root: HTMLElement): void {
    if (
      this.pendingFocus_abyssPrivate?.queueSequence !== undefined ||
      this.pendingFocus_abyssPrivate?.suppressFollow === true
    )
      return;
    const active = root.ownerDocument.activeElement;
    if (!isRealmHTMLElement(active) || !root.contains(active)) return;
    const block = active.closest<HTMLElement>('.abyss-tg-block');
    if (block == null) return;
    this.retain(block);
  }

  /** Before a view mount or patch: the coming render must restore this sequence again. */
  beforeViewUpdate(canonical = true): void {
    this.submittedProjection_abyssPrivate = !canonical;
    if (canonical) this.queue_abyssPrivate?.published();
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
    if (!this.isPendingRestorable_abyssPrivate(scheduled, focusSequence)) return;

    const scheduledCandidate = this.findBlock_abyssPrivate(container, scheduled);
    if (queueSequence !== undefined && scheduledCandidate === scheduled.originElement) return;
    const ownerWindow = container.ownerDocument.defaultView;
    if (ownerWindow === null) return;
    const restore = (): void => {
      this.restoreDeferredFocus_abyssPrivate(container, {
        focusSequence,
        renderGeneration,
      });
    };
    if (queueSequence !== undefined || this.submittedProjection_abyssPrivate) restore();
    else ownerWindow.setTimeout(restore, 0);
  }

  /** Defers the pending focus against the mounted panel; a null root is a no-op. */
  private deferFocusAtRoot_abyssPrivate(): void {
    const root = this.host_abyssPrivate.root();
    if (root !== null) this.deferFocus(root, this.renderGeneration_abyssPrivate);
  }

  private findBlock_abyssPrivate(
    container: HTMLElement,
    pending: TimedBlockFocusLocator,
  ): HTMLElement | undefined {
    if (pending.noopTarget !== undefined && !this.submittedProjection_abyssPrivate)
      return renderedTaskNodeElements(container, pending.noopTarget).find(
        (block) =>
          block.classList.contains('abyss-tg-block') &&
          (pending.segmentDate === undefined ||
            block.dataset['tgSegmentDate'] === pending.segmentDate),
      );
    if (
      pending.noopTarget !== undefined &&
      pending.originElement?.dataset['abyssTaskNodeRefKey'] === undefined
    )
      return undefined;
    return findTimedBlock(
      container,
      pending,
      this.submittedProjection_abyssPrivate ? pending.originElement : undefined,
    );
  }

  private handleSettled_abyssPrivate(
    sequence: number,
    anyChanged: boolean,
    sourceChanged: boolean,
  ): void {
    const pending = this.pendingFocus_abyssPrivate;
    if (pending?.queueSequence !== sequence) return;
    if ((anyChanged || sourceChanged) && !this.committedSequences_abyssPrivate.has(sequence)) {
      this.committedSequences_abyssPrivate.add(sequence);
      this.deferFocusAtRoot_abyssPrivate();
    }
    if (
      (!anyChanged && !sourceChanged && pending.noopTarget === undefined) ||
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
      line: taskNodeSourceLine(calendarMutationTarget(task) ?? { type: 'task', ref: task.ref }),
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
    block: HTMLElement,
  ): boolean {
    return (
      this.isSubmittedOrigin_abyssPrivate(block, pending) ||
      (pending?.filePath === filePath &&
        pending.line === line &&
        pending.segmentDate === block.dataset['tgSegmentDate'])
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

  private restoreDeferredFocus_abyssPrivate(
    container: HTMLElement,
    options: {
      readonly focusSequence: number;
      readonly renderGeneration: number;
    },
  ): void {
    if (options.renderGeneration !== this.renderGeneration_abyssPrivate) return;
    const pending = this.pendingFocus_abyssPrivate;
    if (!this.isPendingRestorable_abyssPrivate(pending, options.focusSequence)) return;
    const candidate = this.findBlock_abyssPrivate(container, pending);
    if (!isRestorableTimedBlock(candidate, container)) return;
    // Restoring our own projection is not a new focus transfer that cancels the queued write.
    this.pendingFocus_abyssPrivate = { ...pending, originElement: candidate };
    candidate.focus({ preventScroll: pending.suppressFollow === true });
    // A forecast block is never selected; the selection sync owns the class only for task nodes.
    if (candidate.dataset['occurrenceState'] !== 'forecast') candidate.classList.add('is-selected');
    if (!this.didRestore_abyssPrivate(candidate, pending.sequence)) return;
    this.finishRestoration_abyssPrivate(pending.queueSequence);
  }

  private isPendingRestorable_abyssPrivate(
    pending: TimedBlockFocusLocator | undefined,
    focusSequence: number,
  ): pending is TimedBlockFocusLocator {
    if (pending?.sequence !== focusSequence || !this.host_abyssPrivate.isCalendarActive())
      return false;
    return (
      pending.queueSequence === undefined ||
      pending.suppressFollow === true ||
      pending.noopTarget !== undefined ||
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
    if (
      this.submittedProjection_abyssPrivate &&
      this.pendingFocus_abyssPrivate?.noopTarget !== undefined
    )
      return;
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

  private clearSequenceState_abyssPrivate(queueSequence: number): void {
    this.settledSequences_abyssPrivate.delete(queueSequence);
    this.restoredSequences_abyssPrivate.delete(queueSequence);
    this.committedSequences_abyssPrivate.delete(queueSequence);
  }

  private handleCommit_abyssPrivate(
    updated: TaskSnapshot,
    intent: TimedBlockKeyboardIntent,
    queueSequence: number,
    changed: boolean,
  ): void {
    const pending = this.pendingFocus_abyssPrivate;
    if (!this.acceptsCommit_abyssPrivate(pending, queueSequence)) return;
    this.pendingFocus_abyssPrivate = { ...pending, noopTarget: undefined };
    this.committedSequences_abyssPrivate.add(queueSequence);
    const line = taskNodeSourceLine(
      calendarMutationTarget(updated) ?? { type: 'task', ref: updated.ref },
    );
    const sourceChanged = pending.filePath !== updated.source.filePath || pending.line !== line;
    const nextSegmentDate = shiftFocusedSegmentDate(pending, intent, changed, updated);
    const segmentChanged = nextSegmentDate !== pending.segmentDate;
    const identityChanged = [sourceChanged, segmentChanged].includes(true);
    const presentationChanged = [changed, identityChanged].includes(true);
    if (presentationChanged) this.restoredSequences_abyssPrivate.delete(queueSequence);
    if (identityChanged) {
      this.pendingFocus_abyssPrivate = {
        ...pending,
        noopTarget: undefined,
        filePath: updated.source.filePath,
        line,
        ...(nextSegmentDate !== undefined && { segmentDate: nextSegmentDate }),
        sequence: ++this.nextFocusSequence_abyssPrivate,
      };
    }
    if (presentationChanged || !this.restoredSequences_abyssPrivate.has(queueSequence)) {
      this.deferFocusAtRoot_abyssPrivate();
    }
    if (shouldFollowCommit(pending, intent, segmentChanged))
      this.host_abyssPrivate.follow(updated, nextSegmentDate);
  }

  private handleNoop_abyssPrivate(task: TaskSnapshot, queueSequence: number): void {
    const pending = this.pendingFocus_abyssPrivate;
    if (!this.acceptsCommit_abyssPrivate(pending, queueSequence)) return;
    const target = calendarMutationTarget(task);
    if (target === undefined) return;
    this.restoredSequences_abyssPrivate.delete(queueSequence);
    this.pendingFocus_abyssPrivate = {
      ...pending,
      filePath: task.source.filePath,
      line: taskNodeSourceLine(target),
      noopTarget: target,
    };
    this.deferFocusAtRoot_abyssPrivate();
  }

  private acceptsCommit_abyssPrivate(
    pending: TimedBlockFocusLocator | undefined,
    queueSequence: number,
  ): pending is TimedBlockFocusLocator {
    return pending?.queueSequence === queueSequence && this.host_abyssPrivate.isCalendarActive();
  }
}
