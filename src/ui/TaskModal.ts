import { setIcon, type App } from 'obsidian';
import { AppState } from '../app/AppState';
import { RightPanel, type RightPanelMutationLifecycle } from '../panels/RightPanel';
import type { CalendarSettings } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import {
  sameTaskNodeRef,
  type CommentTimeContextProvider,
  type TaskApplicationApi,
  type TaskIndexEvent,
  type TaskQueryApi,
  type TaskRef,
  type TaskResolution,
  type TaskSnapshot,
} from '../tasks';
import { isRealmHTMLElement } from './domRealm';
import { isImeOwnedEvent } from './ime';
import { noInteractionOwnership, type InteractionOwnershipPort } from './interactionOwnership';
import { presentTaskCommandResult } from './taskCommandResult';
import { isDirtyDraftBundle, type RightPanelDraftBundle } from './taskDraftContinuity';
import {
  rebuildTaskSelection,
  renamedRootSelection,
  rootTaskRef,
  selectedRootResolution,
  taskNodeRef,
  taskSelectionPath,
  type TaskSelectionNode,
} from './taskSelection';
import { deviceTrackedTimeContext, type TrackingSurface } from './timeTracking/TimeBadge';
import { TrackingTicker } from './timeTracking/TrackingTicker';
import { createTrackingActions } from './timeTracking/trackingActions';

interface TaskModalOptions {
  readonly app: App;
  readonly statusRegistry: StatusRegistry;
  readonly settings?: CalendarSettings | undefined;
  readonly queries?: TaskQueryApi | undefined;
  readonly tasks?: TaskApplicationApi | undefined;
  readonly commentTimeContext?: CommentTimeContextProvider | undefined;
  readonly interactionOwnership?: InteractionOwnershipPort | undefined;
}

interface HierarchyContinuation {
  readonly state: AppState;
  readonly intent: number;
  readonly ref: TaskRef;
  readonly selection: readonly TaskSelectionNode[];
  deferredClose: boolean;
  draft: RightPanelDraftBundle | undefined;
}

export class TaskModal {
  private readonly app_abyssPrivate: App;
  private readonly statusRegistry_abyssPrivate: StatusRegistry;
  private readonly settings_abyssPrivate: CalendarSettings | undefined;
  private readonly queries_abyssPrivate: TaskQueryApi | undefined;
  private readonly tasks_abyssPrivate: TaskApplicationApi | undefined;
  private readonly commentTimeContext_abyssPrivate: CommentTimeContextProvider | undefined;
  private readonly interactionOwnership_abyssPrivate: InteractionOwnershipPort;
  private backdropEl_abyssPrivate: HTMLElement | null = null;
  private modalEl_abyssPrivate: HTMLElement | null = null;
  private innerState_abyssPrivate: AppState | null = null;
  private innerPanel_abyssPrivate: RightPanel | null = null;
  private keyHandler_abyssPrivate: ((e: KeyboardEvent) => void) | null = null;
  private opener_abyssPrivate: HTMLElement | null = null;
  private ownerDoc_abyssPrivate: Document | null = null;
  private queryUnsub_abyssPrivate: (() => void) | null = null;
  private selectionUnsub_abyssPrivate: (() => void) | null = null;
  private ownedWriteRef_abyssPrivate: TaskRef | undefined = undefined;
  private ownershipToken_abyssPrivate: { release(): void } | null = null;
  private timeTracking_abyssPrivate: TrackingSurface | undefined;
  private readonly hierarchyContinuations_abyssPrivate = new Map<object, HierarchyContinuation>();

  constructor(options: TaskModalOptions) {
    const {
      app,
      statusRegistry,
      settings,
      queries,
      tasks,
      commentTimeContext,
      interactionOwnership: ownership,
    } = options;
    this.app_abyssPrivate = app;
    this.statusRegistry_abyssPrivate = statusRegistry;
    this.settings_abyssPrivate = settings;
    this.queries_abyssPrivate = queries;
    this.tasks_abyssPrivate = tasks;
    this.commentTimeContext_abyssPrivate = commentTimeContext;
    this.interactionOwnership_abyssPrivate = ownership ?? noInteractionOwnership;
  }

  open(task: TaskSnapshot, context?: string): void {
    this.close();
    this.ownershipToken_abyssPrivate = this.interactionOwnership_abyssPrivate.acquire({
      blocksShortcuts: true,
    });
    // Capture the active document at open time so close() removes from the same document
    this.ownerDoc_abyssPrivate = activeDocument;
    const active = this.ownerDoc_abyssPrivate.activeElement;
    this.opener_abyssPrivate =
      isRealmHTMLElement(active) && active !== this.ownerDoc_abyssPrivate.body ? active : null;
    this.innerState_abyssPrivate = new AppState();
    this.innerState_abyssPrivate.set('taskStack', [task]);
    this.selectionUnsub_abyssPrivate = this.innerState_abyssPrivate.on('taskStack', (stack) => {
      if (this.ownedWriteRef_abyssPrivate == null) return;
      const ref = stack[0] != null ? rootTaskRef(stack[0]) : undefined;
      if (ref == null || !this.sameRef_abyssPrivate(ref, this.ownedWriteRef_abyssPrivate))
        this.ownedWriteRef_abyssPrivate = undefined;
    });

    const backdrop = this.ownerDoc_abyssPrivate.body.createDiv({ cls: 'abyss-modal-backdrop' });
    this.backdropEl_abyssPrivate = backdrop;
    // Marks the document so hover-preview popovers can stack above the modal (see styles.css).
    this.ownerDoc_abyssPrivate.body.addClass('abyss-modal-open');

    const modal = backdrop.createDiv({ cls: 'abyss-modal' });
    this.modalEl_abyssPrivate = modal;
    if (context !== undefined && context.length > 0) {
      modal.createDiv({ cls: 'abyss-forecast-source-context', text: context });
    }

    const panelEl = modal.createDiv({ cls: 'abyss-right abyss-modal-body' });
    const openingState = this.innerState_abyssPrivate;
    this.innerPanel_abyssPrivate = new RightPanel({
      state: this.innerState_abyssPrivate,
      app: this.app_abyssPrivate,
      statusRegistry: this.statusRegistry_abyssPrivate,
      settings: this.settings_abyssPrivate,
      tasks: this.tasks_abyssPrivate,
      onRenderHeaderActions: (actions) => {
        this.renderCloseButton_abyssPrivate(actions);
      },
      onMutationLifecycle: (event) => {
        if (this.innerState_abyssPrivate !== openingState) return;
        if (event.operation === 'hierarchy') this.trackHierarchy_abyssPrivate(event, openingState);
        else this.trackOwnWrite_abyssPrivate(event);
      },
      commentTimeContext: this.commentTimeContext_abyssPrivate,
      interactionOwnership: this.interactionOwnership_abyssPrivate,
      timeTracking: this.createTrackingSurface_abyssPrivate(),
    });
    this.innerPanel_abyssPrivate.mount(panelEl);
    // As in PanelView, RightPanel's synchronous history maintenance must run before
    // active-selection convergence consumes the pending owned-command evidence.
    this.queryUnsub_abyssPrivate =
      this.queries_abyssPrivate?.subscribe((event) => {
        this.onIndexEvent_abyssPrivate(event);
      }) ?? null;

    // A mocked/legacy panel may not invoke the render hook. Preserve the direct fallback.
    this.renderCloseButton_abyssPrivate(
      panelEl.querySelector<HTMLElement>('.abyss-right-header-actions') ?? panelEl,
    );

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) this.closeFromUser_abyssPrivate();
    });

    this.keyHandler_abyssPrivate = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || isImeOwnedEvent(e)) return;
      e.preventDefault();
      e.stopPropagation();
      this.closeFromUser_abyssPrivate();
    };
    this.ownerDoc_abyssPrivate.addEventListener('keydown', this.keyHandler_abyssPrivate);
  }

  /** The modal hosts its own inspector, so it owns the tick and the write boundary it runs on. */
  private createTrackingSurface_abyssPrivate(): TrackingSurface | undefined {
    const tasks = this.tasks_abyssPrivate;
    const ownerWindow = this.ownerDoc_abyssPrivate?.defaultView;
    if (tasks === undefined || ownerWindow == null) return undefined;
    const surface: TrackingSurface = {
      ticker: new TrackingTicker({
        queries: tasks.queries,
        now: () => Date.now(),
        win: ownerWindow,
      }),
      actions: createTrackingActions(tasks, presentTaskCommandResult),
      context: deviceTrackedTimeContext,
    };
    this.timeTracking_abyssPrivate = surface;
    return surface;
  }

  private renderCloseButton_abyssPrivate(parent: HTMLElement): void {
    const existing =
      this.modalEl_abyssPrivate?.querySelector<HTMLElement>('.abyss-modal-close-btn');
    if (existing != null) {
      if (existing.parentElement !== parent) parent.appendChild(existing);
      return;
    }
    const closeBtn = parent.createEl('button');
    closeBtn.className = 'clickable-icon abyss-right-action-btn abyss-modal-close-btn';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.setAttribute('title', 'Close');
    setIcon(closeBtn, 'x');
    closeBtn.addEventListener('click', () => {
      this.closeFromUser_abyssPrivate();
    });
  }

  private closeFromUser_abyssPrivate(): void {
    const doc = this.ownerDoc_abyssPrivate;
    if (doc == null) {
      this.close();
      return;
    }
    const opener = this.opener_abyssPrivate;
    const active = doc.activeElement;
    const allowed =
      active === doc.body ||
      active === opener ||
      this.backdropEl_abyssPrivate?.contains(active) === true;
    this.close();
    if (allowed && opener?.isConnected === true && opener.ownerDocument === doc)
      opener.focus({ preventScroll: true });
  }

  close(): void {
    this.hierarchyContinuations_abyssPrivate.clear();
    this.opener_abyssPrivate = null;
    const ownershipToken = this.ownershipToken_abyssPrivate;
    this.ownershipToken_abyssPrivate = null;
    ownershipToken?.release();
    if (this.keyHandler_abyssPrivate != null && this.ownerDoc_abyssPrivate != null) {
      this.ownerDoc_abyssPrivate.removeEventListener('keydown', this.keyHandler_abyssPrivate);
      this.keyHandler_abyssPrivate = null;
    }
    this.queryUnsub_abyssPrivate?.();
    this.queryUnsub_abyssPrivate = null;
    this.selectionUnsub_abyssPrivate?.();
    this.selectionUnsub_abyssPrivate = null;
    this.ownerDoc_abyssPrivate?.body.removeClass('abyss-modal-open');
    this.ownerDoc_abyssPrivate = null;
    this.innerPanel_abyssPrivate?.destroy();
    this.innerPanel_abyssPrivate = null;
    this.timeTracking_abyssPrivate?.ticker.destroy();
    this.timeTracking_abyssPrivate = undefined;
    this.innerState_abyssPrivate = null;
    this.ownedWriteRef_abyssPrivate = undefined;
    this.modalEl_abyssPrivate = null;
    this.backdropEl_abyssPrivate?.remove();
    this.backdropEl_abyssPrivate = null;
  }

  private trackHierarchy_abyssPrivate(event: RightPanelMutationLifecycle, state: AppState): void {
    if (event.phase === 'started') {
      this.hierarchyContinuations_abyssPrivate.set(event.token, {
        state,
        intent: state.taskSelectionIntentGeneration,
        ref: event.ref,
        selection: [...state.get('taskStack')],
        deferredClose: false,
        draft: undefined,
      });
      return;
    }
    const continuation = this.hierarchyContinuations_abyssPrivate.get(event.token);
    this.hierarchyContinuations_abyssPrivate.delete(event.token);
    if (continuation !== undefined) this.settleHierarchy_abyssPrivate(continuation);
  }

  private settleHierarchy_abyssPrivate(continuation: HierarchyContinuation): void {
    const state = continuation.state;
    if (
      !continuation.deferredClose ||
      this.innerState_abyssPrivate !== state ||
      this.modalEl_abyssPrivate === null ||
      state.get('taskStack').length > 0
    )
      return;
    const restored = this.exactHierarchyRestoration_abyssPrivate(continuation);
    if (restored !== undefined) {
      state.updateInspectorSelection(restored.selection);
      this.innerPanel_abyssPrivate?.restoreDraftState(continuation.draft, restored.root);
      return;
    }
    if (
      this.hierarchyContinuations_abyssPrivate.size === 0 &&
      !this.hasDirtyHierarchyDraft_abyssPrivate(continuation)
    )
      this.close();
  }

  private hasDirtyHierarchyDraft_abyssPrivate(continuation: HierarchyContinuation): boolean {
    return (
      isDirtyDraftBundle(continuation.draft) ||
      isDirtyDraftBundle(this.innerPanel_abyssPrivate?.captureDraftState())
    );
  }

  private exactHierarchyRestoration_abyssPrivate(
    continuation: HierarchyContinuation,
  ): { root: TaskSnapshot; selection: TaskSelectionNode[] } | undefined {
    if (continuation.state.taskSelectionIntentGeneration !== continuation.intent) return undefined;
    const resolution = this.queries_abyssPrivate?.resolve(continuation.ref);
    if (
      resolution?.type !== 'exact' ||
      !this.sameRef_abyssPrivate(resolution.task.ref, continuation.ref)
    )
      return undefined;
    const selected = continuation.selection[continuation.selection.length - 1];
    if (selected === undefined) return undefined;
    const restored = taskSelectionPath(resolution.task, selected);
    if (
      restored?.length !== continuation.selection.length ||
      !restored.every((node, index) => {
        const prior = continuation.selection[index];
        return prior !== undefined && sameTaskNodeRef(taskNodeRef(node), taskNodeRef(prior));
      })
    )
      return undefined;
    return { root: resolution.task, selection: restored };
  }

  private deferHierarchyClose_abyssPrivate(
    stack: readonly TaskSelectionNode[],
    draft: RightPanelDraftBundle | undefined,
  ): boolean {
    const root = stack[0];
    if (root === undefined) return false;
    const continuations = [...this.hierarchyContinuations_abyssPrivate.values()].filter(
      (candidate) =>
        candidate.state === this.innerState_abyssPrivate &&
        this.sameRef_abyssPrivate(candidate.ref, rootTaskRef(root)),
    );
    for (const continuation of continuations) {
      continuation.deferredClose = true;
      continuation.draft = draft;
    }
    return continuations.length > 0;
  }

  private onIndexEvent_abyssPrivate(event: TaskIndexEvent): void {
    const stack = this.innerState_abyssPrivate?.get('taskStack');
    const root = stack?.[0];
    if (stack == null || root == null) return;
    const ref = rootTaskRef(root);
    if (this.queries_abyssPrivate == null || !this.affects_abyssPrivate(event, ref.filePath))
      return;
    if ('source' in root && this.applyRenamedRoot_abyssPrivate(event, root, stack)) return;
    const removalPending = this.innerState_abyssPrivate?.isTaskRemovalPending(ref) === true;
    this.applyResolution_abyssPrivate(
      selectedRootResolution(this.queries_abyssPrivate, ref, removalPending),
      stack,
    );
  }

  private applyRenamedRoot_abyssPrivate(
    event: TaskIndexEvent,
    root: TaskSnapshot,
    stack: TaskSelectionNode[],
  ): boolean {
    if (this.queries_abyssPrivate == null) return false;
    const renamed = renamedRootSelection(event, root, this.queries_abyssPrivate);
    if (renamed == null) return false;
    const draft = this.innerPanel_abyssPrivate?.captureDraftState();
    this.ownedWriteRef_abyssPrivate = undefined;
    this.innerState_abyssPrivate?.updateInspectorSelection(rebuildTaskSelection(renamed, stack));
    this.innerPanel_abyssPrivate?.restoreDraftState(draft, renamed);
    return true;
  }

  private affects_abyssPrivate(event: TaskIndexEvent, path: string): boolean {
    if (event.type === 'initialized') return true;
    if (event.type === 'changed') return event.files.includes(path);
    if (event.type === 'renamed') return event.oldPath === path || event.newPath === path;
    return event.path === path;
  }

  private applyResolution_abyssPrivate(
    resolution: TaskResolution,
    stack: TaskSelectionNode[],
  ): void {
    this.clearResolutionMessage_abyssPrivate();
    if (resolution.type === 'exact' || resolution.type === 'rebased') {
      this.applyResolvedTask_abyssPrivate(resolution, stack);
      return;
    }
    const draft = this.innerPanel_abyssPrivate?.captureDraftState();
    this.ownedWriteRef_abyssPrivate = undefined;
    if (resolution.type === 'visual') {
      this.innerState_abyssPrivate?.updateInspectorSelection([resolution.current]);
      this.innerPanel_abyssPrivate?.detachDraftState(draft);
      return;
    }
    this.detachUnavailableHierarchy_abyssPrivate(stack, draft);
  }

  private detachUnavailableHierarchy_abyssPrivate(
    stack: readonly TaskSelectionNode[],
    draft: RightPanelDraftBundle | undefined,
  ): void {
    this.innerState_abyssPrivate?.clearReconciledTaskSelection();
    this.innerPanel_abyssPrivate?.detachDraftState(draft);
    if (this.deferHierarchyClose_abyssPrivate(stack, draft)) return;
    if (!isDirtyDraftBundle(draft)) this.close();
  }

  private applyResolvedTask_abyssPrivate(
    resolution: Extract<TaskResolution, { type: 'exact' | 'rebased' }>,
    stack: TaskSelectionNode[],
  ): void {
    const current = resolution.type === 'exact' ? resolution.task : resolution.current;
    const consumedOwnedRef = this.consumedOwnedRef_abyssPrivate(resolution);
    const ownedSelection =
      consumedOwnedRef === undefined
        ? undefined
        : this.ownedSelection_abyssPrivate(consumedOwnedRef, current, stack);
    const draft =
      consumedOwnedRef != null
        ? this.innerPanel_abyssPrivate?.captureDraftStateForOwnedTransition(
            consumedOwnedRef,
            current.ref,
          )
        : this.innerPanel_abyssPrivate?.captureDraftState();
    this.ownedWriteRef_abyssPrivate = undefined;
    this.innerState_abyssPrivate?.updateInspectorSelection(
      ownedSelection ??
        rebuildTaskSelection(current, stack, {
          preserveDependencyChanges:
            resolution.type === 'rebased' && resolution.evidence === 'authority-transition',
        }),
    );
    this.innerPanel_abyssPrivate?.restoreDraftState(draft, current);
  }

  private consumedOwnedRef_abyssPrivate(
    resolution: Extract<TaskResolution, { type: 'exact' | 'rebased' }>,
  ): TaskRef | undefined {
    if (resolution.type !== 'rebased' || resolution.evidence !== 'authority-transition') {
      return undefined;
    }
    const ownedWriteRef = this.ownedWriteRef_abyssPrivate;
    return ownedWriteRef != null &&
      this.sameRef_abyssPrivate(ownedWriteRef, resolution.previous.ref)
      ? ownedWriteRef
      : undefined;
  }

  private ownedSelection_abyssPrivate(
    ref: TaskRef,
    current: TaskSnapshot,
    stack: TaskSelectionNode[],
  ): TaskSelectionNode[] | undefined {
    return this.innerPanel_abyssPrivate?.selectionForOwnedTransition(ref, current, stack);
  }

  private acknowledgeOwnWrite_abyssPrivate(taskOrRef?: TaskSelectionNode | TaskRef): void {
    const selected = this.innerState_abyssPrivate?.get('taskStack')[0];
    const selectedRef = selected != null ? rootTaskRef(selected) : undefined;
    let suppliedRef: TaskRef | undefined;
    if (taskOrRef != null)
      suppliedRef = 'revision' in taskOrRef ? taskOrRef : rootTaskRef(taskOrRef);
    if (
      suppliedRef != null &&
      (selectedRef == null || !this.sameRef_abyssPrivate(suppliedRef, selectedRef))
    )
      return;
    const acknowledged = suppliedRef ?? selectedRef;
    this.ownedWriteRef_abyssPrivate = acknowledged != null ? { ...acknowledged } : undefined;
  }

  private trackOwnWrite_abyssPrivate(event: {
    readonly phase: 'started' | 'settled';
    readonly ref: TaskRef;
  }): void {
    if (event.phase === 'started') {
      this.acknowledgeOwnWrite_abyssPrivate(event.ref);
      return;
    }
    if (
      this.ownedWriteRef_abyssPrivate != null &&
      this.sameRef_abyssPrivate(this.ownedWriteRef_abyssPrivate, event.ref)
    ) {
      this.ownedWriteRef_abyssPrivate = undefined;
    }
  }

  private sameRef_abyssPrivate(left: TaskRef, right: TaskRef): boolean {
    return (
      left.filePath === right.filePath &&
      left.line === right.line &&
      left.revision === right.revision
    );
  }

  private clearResolutionMessage_abyssPrivate(): void {
    this.modalEl_abyssPrivate?.querySelector('.abyss-task-selection-message')?.remove();
  }
}
