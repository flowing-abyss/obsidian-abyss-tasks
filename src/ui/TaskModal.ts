import type { App } from 'obsidian';
import { AppState } from '../app/AppState';
import { RightPanel } from '../panels/RightPanel';
import type { CalendarSettings } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import type {
  CommentTimeContextProvider,
  TaskApplicationApi,
  TaskIndexEvent,
  TaskQueryApi,
  TaskRef,
  TaskResolution,
  TaskSnapshot,
} from '../tasks';
import { noInteractionOwnership, type InteractionOwnershipPort } from './interactionOwnership';
import { isDirtyDraftBundle } from './taskDraftContinuity';
import {
  rebuildTaskSelection,
  renamedRootSelection,
  rootTaskRef,
  type TaskSelectionNode,
} from './taskSelection';

type TaskModalConstructorArgs = [
  app: App,
  statusRegistry: StatusRegistry,
  settings?: CalendarSettings,
  queries?: TaskQueryApi,
  tasks?: TaskApplicationApi,
  commentTimeContext?: CommentTimeContextProvider,
  interactionOwnership?: InteractionOwnershipPort,
];

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
  private ownerDoc_abyssPrivate: Document | null = null;
  private queryUnsub_abyssPrivate: (() => void) | null = null;
  private selectionUnsub_abyssPrivate: (() => void) | null = null;
  private ownedWriteRef_abyssPrivate: TaskRef | undefined = undefined;
  private ownershipToken_abyssPrivate: { release(): void } | null = null;

  constructor(...args: TaskModalConstructorArgs) {
    const [app, statusRegistry, settings, queries, tasks, commentTimeContext, ownership] = args;
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
    this.innerPanel_abyssPrivate = new RightPanel(
      this.innerState_abyssPrivate,
      this.app_abyssPrivate,
      this.statusRegistry_abyssPrivate,
      this.settings_abyssPrivate,
      undefined,
      this.tasks_abyssPrivate,
      (actions) => {
        this.renderCloseButton_abyssPrivate(actions);
      },
      (event) => {
        this.trackOwnWrite_abyssPrivate(event);
      },
      this.commentTimeContext_abyssPrivate,
      this.interactionOwnership_abyssPrivate,
    );
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
      if (e.target === backdrop) this.close();
    });

    this.keyHandler_abyssPrivate = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) this.close();
    };
    this.ownerDoc_abyssPrivate.addEventListener('keydown', this.keyHandler_abyssPrivate);
  }

  private renderCloseButton_abyssPrivate(parent: HTMLElement): void {
    const existing =
      this.modalEl_abyssPrivate?.querySelector<HTMLElement>('.abyss-modal-close-btn');
    if (existing != null) {
      if (existing.parentElement !== parent) parent.appendChild(existing);
      return;
    }
    const closeBtn = parent.createEl('button');
    closeBtn.className = 'abyss-right-action-btn abyss-modal-close-btn';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.setAttribute('title', 'Close');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => {
      this.close();
    });
  }

  close(): void {
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
    this.innerState_abyssPrivate = null;
    this.ownedWriteRef_abyssPrivate = undefined;
    this.modalEl_abyssPrivate = null;
    this.backdropEl_abyssPrivate?.remove();
    this.backdropEl_abyssPrivate = null;
  }

  private onIndexEvent_abyssPrivate(event: TaskIndexEvent): void {
    const stack = this.innerState_abyssPrivate?.get('taskStack');
    const root = stack?.[0];
    if (stack == null || root == null) return;
    const ref = rootTaskRef(root);
    if (this.queries_abyssPrivate == null || !this.affects_abyssPrivate(event, ref.filePath))
      return;
    if ('source' in root && this.applyRenamedRoot_abyssPrivate(event, root, stack)) return;
    this.applyResolution_abyssPrivate(this.queries_abyssPrivate.resolve(ref), stack);
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
    this.innerState_abyssPrivate?.set('taskStack', []);
    this.innerPanel_abyssPrivate?.detachDraftState(draft);
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
