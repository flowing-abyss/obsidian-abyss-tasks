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
  private readonly app: App;
  private readonly statusRegistry: StatusRegistry;
  private readonly settings: CalendarSettings | undefined;
  private readonly queries: TaskQueryApi | undefined;
  private readonly tasks: TaskApplicationApi | undefined;
  private readonly commentTimeContext: CommentTimeContextProvider | undefined;
  private readonly interactionOwnership: InteractionOwnershipPort;
  private backdropEl: HTMLElement | null = null;
  private modalEl: HTMLElement | null = null;
  private innerState: AppState | null = null;
  private innerPanel: RightPanel | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private ownerDoc: Document | null = null;
  private queryUnsub: (() => void) | null = null;
  private selectionUnsub: (() => void) | null = null;
  private ownedWriteRef: TaskRef | undefined = undefined;
  private ownershipToken: { release(): void } | null = null;

  constructor(...args: TaskModalConstructorArgs) {
    const [app, statusRegistry, settings, queries, tasks, commentTimeContext, ownership] = args;
    this.app = app;
    this.statusRegistry = statusRegistry;
    this.settings = settings;
    this.queries = queries;
    this.tasks = tasks;
    this.commentTimeContext = commentTimeContext;
    this.interactionOwnership = ownership ?? noInteractionOwnership;
  }

  open(task: TaskSnapshot, context?: string): void {
    this.close();
    this.ownershipToken = this.interactionOwnership.acquire({ blocksShortcuts: true });
    // Capture the active document at open time so close() removes from the same document
    this.ownerDoc = activeDocument;
    this.innerState = new AppState();
    this.innerState.set('taskStack', [task]);
    this.selectionUnsub = this.innerState.on('taskStack', (stack) => {
      if (this.ownedWriteRef == null) return;
      const ref = stack[0] != null ? rootTaskRef(stack[0]) : undefined;
      if (ref == null || !this.sameRef(ref, this.ownedWriteRef)) this.ownedWriteRef = undefined;
    });

    const backdrop = this.ownerDoc.body.createDiv({ cls: 'abyss-modal-backdrop' });
    this.backdropEl = backdrop;
    // Marks the document so hover-preview popovers can stack above the modal (see styles.css).
    this.ownerDoc.body.addClass('abyss-modal-open');

    const modal = backdrop.createDiv({ cls: 'abyss-modal' });
    this.modalEl = modal;
    if (context !== undefined && context.length > 0) {
      modal.createDiv({ cls: 'abyss-forecast-source-context', text: context });
    }

    const panelEl = modal.createDiv({ cls: 'abyss-right abyss-modal-body' });
    this.innerPanel = new RightPanel(
      this.innerState,
      this.app,
      this.statusRegistry,
      this.settings,
      undefined,
      this.tasks,
      (actions) => {
        this.renderCloseButton(actions);
      },
      (event) => {
        this.trackOwnWrite(event);
      },
      this.commentTimeContext,
      this.interactionOwnership,
    );
    this.innerPanel.mount(panelEl);
    // As in PanelView, RightPanel's synchronous history maintenance must run before
    // active-selection convergence consumes the pending owned-command evidence.
    this.queryUnsub =
      this.queries?.subscribe((event) => {
        this.onIndexEvent(event);
      }) ?? null;

    // A mocked/legacy panel may not invoke the render hook. Preserve the direct fallback.
    this.renderCloseButton(
      panelEl.querySelector<HTMLElement>('.abyss-right-header-actions') ?? panelEl,
    );

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) this.close();
    });

    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) this.close();
    };
    this.ownerDoc.addEventListener('keydown', this.keyHandler);
  }

  private renderCloseButton(parent: HTMLElement): void {
    const existing = this.modalEl?.querySelector<HTMLElement>('.abyss-modal-close-btn');
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
    const ownershipToken = this.ownershipToken;
    this.ownershipToken = null;
    ownershipToken?.release();
    if (this.keyHandler != null && this.ownerDoc != null) {
      this.ownerDoc.removeEventListener('keydown', this.keyHandler);
      this.keyHandler = null;
    }
    this.queryUnsub?.();
    this.queryUnsub = null;
    this.selectionUnsub?.();
    this.selectionUnsub = null;
    this.ownerDoc?.body.removeClass('abyss-modal-open');
    this.ownerDoc = null;
    this.innerPanel?.destroy();
    this.innerPanel = null;
    this.innerState = null;
    this.ownedWriteRef = undefined;
    this.modalEl = null;
    this.backdropEl?.remove();
    this.backdropEl = null;
  }

  private onIndexEvent(event: TaskIndexEvent): void {
    const stack = this.innerState?.get('taskStack');
    const root = stack?.[0];
    if (stack == null || root == null) return;
    const ref = rootTaskRef(root);
    if (this.queries == null || !this.affects(event, ref.filePath)) return;
    if ('source' in root && this.applyRenamedRoot(event, root, stack)) return;
    this.applyResolution(this.queries.resolve(ref), stack);
  }

  private applyRenamedRoot(
    event: TaskIndexEvent,
    root: TaskSnapshot,
    stack: TaskSelectionNode[],
  ): boolean {
    if (this.queries == null) return false;
    const renamed = renamedRootSelection(event, root, this.queries);
    if (renamed == null) return false;
    const draft = this.innerPanel?.captureDraftState();
    this.ownedWriteRef = undefined;
    this.innerState?.updateInspectorSelection(rebuildTaskSelection(renamed, stack));
    this.innerPanel?.restoreDraftState(draft, renamed);
    return true;
  }

  private affects(event: TaskIndexEvent, path: string): boolean {
    if (event.type === 'initialized') return true;
    if (event.type === 'changed') return event.files.includes(path);
    if (event.type === 'renamed') return event.oldPath === path || event.newPath === path;
    return event.path === path;
  }

  private applyResolution(resolution: TaskResolution, stack: TaskSelectionNode[]): void {
    this.clearResolutionMessage();
    if (resolution.type === 'exact' || resolution.type === 'rebased') {
      this.applyResolvedTask(resolution, stack);
      return;
    }
    const draft = this.innerPanel?.captureDraftState();
    this.ownedWriteRef = undefined;
    if (resolution.type === 'visual') {
      this.innerState?.updateInspectorSelection([resolution.current]);
      this.innerPanel?.detachDraftState(draft);
      return;
    }
    this.innerState?.set('taskStack', []);
    this.innerPanel?.detachDraftState(draft);
    if (!isDirtyDraftBundle(draft)) this.close();
  }

  private applyResolvedTask(
    resolution: Extract<TaskResolution, { type: 'exact' | 'rebased' }>,
    stack: TaskSelectionNode[],
  ): void {
    const current = resolution.type === 'exact' ? resolution.task : resolution.current;
    const consumedOwnedRef = this.consumedOwnedRef(resolution);
    const ownedSelection =
      consumedOwnedRef === undefined
        ? undefined
        : this.ownedSelection(consumedOwnedRef, current, stack);
    const draft =
      consumedOwnedRef != null
        ? this.innerPanel?.captureDraftStateForOwnedTransition(consumedOwnedRef, current.ref)
        : this.innerPanel?.captureDraftState();
    this.ownedWriteRef = undefined;
    this.innerState?.updateInspectorSelection(
      ownedSelection ??
        rebuildTaskSelection(current, stack, {
          preserveDependencyChanges:
            resolution.type === 'rebased' && resolution.evidence === 'authority-transition',
        }),
    );
    this.innerPanel?.restoreDraftState(draft, current);
  }

  private consumedOwnedRef(
    resolution: Extract<TaskResolution, { type: 'exact' | 'rebased' }>,
  ): TaskRef | undefined {
    if (resolution.type !== 'rebased' || resolution.evidence !== 'authority-transition') {
      return undefined;
    }
    const ownedWriteRef = this.ownedWriteRef;
    return ownedWriteRef != null && this.sameRef(ownedWriteRef, resolution.previous.ref)
      ? ownedWriteRef
      : undefined;
  }

  private ownedSelection(
    ref: TaskRef,
    current: TaskSnapshot,
    stack: TaskSelectionNode[],
  ): TaskSelectionNode[] | undefined {
    return this.innerPanel?.selectionForOwnedTransition(ref, current, stack);
  }

  private acknowledgeOwnWrite(taskOrRef?: TaskSelectionNode | TaskRef): void {
    const selected = this.innerState?.get('taskStack')[0];
    const selectedRef = selected != null ? rootTaskRef(selected) : undefined;
    let suppliedRef: TaskRef | undefined;
    if (taskOrRef != null)
      suppliedRef = 'revision' in taskOrRef ? taskOrRef : rootTaskRef(taskOrRef);
    if (suppliedRef != null && (selectedRef == null || !this.sameRef(suppliedRef, selectedRef)))
      return;
    const acknowledged = suppliedRef ?? selectedRef;
    this.ownedWriteRef = acknowledged != null ? { ...acknowledged } : undefined;
  }

  private trackOwnWrite(event: {
    readonly phase: 'started' | 'settled';
    readonly ref: TaskRef;
  }): void {
    if (event.phase === 'started') {
      this.acknowledgeOwnWrite(event.ref);
      return;
    }
    if (this.ownedWriteRef != null && this.sameRef(this.ownedWriteRef, event.ref)) {
      this.ownedWriteRef = undefined;
    }
  }

  private sameRef(left: TaskRef, right: TaskRef): boolean {
    return (
      left.filePath === right.filePath &&
      left.line === right.line &&
      left.revision === right.revision
    );
  }

  private clearResolutionMessage(): void {
    this.modalEl?.querySelector('.abyss-task-selection-message')?.remove();
  }
}
