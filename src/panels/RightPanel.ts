import type { App } from 'obsidian';
import { Component, Notice, setIcon } from 'obsidian';
import type { AppState, InspectorHistoryFrame } from '../app/AppState';
import type { TaskSearchApi } from '../tasks';
import type { LocalSearchScopeHost } from '../ui/localSearchKeys';
import type { TaskDependencySearchProvider } from '../ui/TaskDependencySearchProvider';
import { InspectorDependencies } from './right/InspectorDependencies';
import { InspectorPlanningSurfaces } from './right/InspectorPlanningSurfaces';
import { InspectorSections } from './right/InspectorSections';
import type {
  AddDateField,
  InspectorTaskOwner,
  PlanningControlKey,
  SchedulingDateField,
  ShowInTaskList,
  TaskLike,
} from './right/inspectorTypes';

import type { CalendarSettings } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import {
  cloneTaskSnapshot,
  durationMinutes,
  localTime,
  sameTaskNodeRef,
  type CommentRef,
  type CommentTimeContext,
  type CommentTimeContextProvider,
  type CompletionTrackingWitness,
  type CreateDependencySubtaskCommand,
  type DependencyDirection,
  type LocalDate,
  type PlanningTarget,
  type SubtaskPatch,
  type SubtaskRef,
  type SubtaskSnapshot,
  type TaskApplicationApi,
  type TaskCommand,
  type TaskCommandResult,
  type TaskCommentSnapshot,
  type TaskNodeRef,
  type TaskPatch,
  type TaskPriority,
  type TaskRef,
  type TaskSnapshot,
  type TaskTextTarget,
} from '../tasks';
import { type DependencyPickerCommitResult } from '../ui/dependencySearch';
import { createInlineTaskUndo, type InlineUndoPosition } from '../ui/inlineTaskUndo';
import { noInteractionOwnership, type InteractionOwnershipPort } from '../ui/interactionOwnership';
import {
  proveOwnedCompletionFollowUp,
  proveOwnedTaskSelection,
  rebuildOwnedTaskSelection,
  type OwnedTaskSelectionProof,
} from '../ui/ownedTaskSelection';
import { renderTaskText } from '../ui/renderTaskText';
import { runAsyncAction } from '../ui/runAsyncAction';
import { renderStatusMarker } from '../ui/StatusMarker';
import {
  PENDING_TASK_EDIT_RESULT,
  presentTaskArchiveResult,
  presentTaskCommandResult,
  requestTaskStatusChange,
} from '../ui/taskCommandResult';
import { dependencyCompletionBlocked } from '../ui/taskDependencyPresentation';
import {
  createRightPanelDraftRebaseContext,
  draftIdentity,
  draftPlainText,
  isDirtyDraft,
  isEntryDraft,
  rebaseRightPanelDraft,
  unfocusedDraft,
  type RightPanelDraftBundle,
  type RightPanelDraftState,
} from '../ui/taskDraftContinuity';
import { bindTaskHierarchyDrop, executeTaskHierarchy } from '../ui/taskHierarchyActions';
import { rebuildTaskSelection, rootTaskRef, taskNodeLine, taskNodeRef } from '../ui/taskSelection';
import { taskRemovalInverse } from '../ui/taskUndoNotice';
import {
  mountTimeBadge,
  type TimeBadgeHandle,
  type TrackedNode,
  type TrackingSurface,
} from '../ui/timeTracking/TimeBadge';

interface RightPanelOptions {
  readonly onShowInTaskList?: ShowInTaskList | undefined;
  readonly state: AppState;
  readonly app: App;
  readonly statusRegistry: StatusRegistry;
  readonly settings?: CalendarSettings | undefined;
  readonly onSuccessfulMutation?: ((ref?: TaskRef) => void) | undefined;
  readonly tasks?: TaskApplicationApi | undefined;
  readonly search?: TaskSearchApi | undefined;
  readonly localSearchScope?: LocalSearchScopeHost | undefined;
  readonly dependencySearch?: TaskDependencySearchProvider | undefined;
  readonly onRenderHeaderActions?: ((actions: HTMLElement) => void) | undefined;
  readonly onMutationLifecycle?: ((event: RightPanelMutationLifecycle) => void) | undefined;
  readonly commentTimeContext?: CommentTimeContextProvider | undefined;
  readonly interactionOwnership?: InteractionOwnershipPort | undefined;
  readonly timeTracking?: TrackingSurface | undefined;
}

interface TextDraftSnapshot {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly hadFocus: boolean;
  readonly dirty: boolean;
}

export interface RightPanelMutationLifecycle {
  readonly phase: 'started' | 'settled';
  readonly ref: TaskRef;
  readonly token: object;
  readonly operation?: 'hierarchy';
}

interface SubmittedDraft {
  readonly ref: TaskRef;
  readonly rootAliases: TaskRef[];
  readonly draft?: RightPanelDraftState;
  readonly origin: RightPanelDraftBundle['origin'];
  readonly command?: TaskCommand;
  readonly selection: readonly TaskLike[];
  readonly creationPolicy?: Parameters<typeof rebuildOwnedTaskSelection>[3];
  successorSelection?: readonly TaskLike[];
  proof?: OwnedTaskSelectionProof;
  dismissed?: boolean;
  epoch: number;
  consumed: boolean;
}

function rootRefForPlanningTarget(target: PlanningTarget): TaskRef {
  let node: TaskNodeRef = target;
  while (node.type === 'subtask') node = node.ref.parent;
  return node.ref;
}

function sameTaskRef(left: TaskRef, right: TaskRef): boolean {
  return (
    left.filePath === right.filePath && left.line === right.line && left.revision === right.revision
  );
}

function sameTaskNodeAddress(left: TaskNodeRef, right: TaskNodeRef): boolean {
  if (left.type === 'task' && right.type === 'task')
    return left.ref.filePath === right.ref.filePath && left.ref.line === right.ref.line;
  return (
    left.type === 'subtask' &&
    right.type === 'subtask' &&
    left.ref.relativeLine === right.ref.relativeLine &&
    sameTaskNodeAddress(left.ref.parent, right.ref.parent)
  );
}

function sameCommentRef(left: CommentRef, right: CommentRef): boolean {
  return (
    left.relativeLine === right.relativeLine &&
    left.originalMarkdown === right.originalMarkdown &&
    sameTaskNodeRef(left.parent, right.parent)
  );
}

function planningChildChain(target: PlanningTarget): readonly SubtaskRef[] {
  const chain: SubtaskRef[] = [];
  let node: TaskNodeRef = target;
  while (node.type === 'subtask') {
    chain.push(node.ref);
    node = node.ref.parent;
  }
  chain.reverse();
  return chain;
}

function rebuildPlanningTargetStack(root: TaskSnapshot, target: PlanningTarget): TaskLike[] {
  const stack: TaskLike[] = [root];
  let current: TaskLike = root;
  for (const ref of planningChildChain(target)) {
    const child: SubtaskSnapshot | undefined = current.subtasks.find(
      (candidate) => candidate.ref.relativeLine === ref.relativeLine,
    );
    if (child == null) break;
    stack.push(child);
    current = child;
  }
  return stack;
}

function commentRefOf(comment: TaskCommentSnapshot): CommentRef {
  return comment.ref;
}

function textDraftSnapshot(
  element: HTMLInputElement | HTMLTextAreaElement,
  base: string,
  active: Element | null,
): TextDraftSnapshot {
  return {
    value: element.value,
    selectionStart: element.selectionStart ?? 0,
    selectionEnd: element.selectionEnd ?? 0,
    hadFocus: active === element,
    dirty: element.value !== base,
  };
}

function clearOptionalTimer(ownerWindow: Window | null, timer: number | undefined): void {
  if (timer !== undefined) ownerWindow?.clearTimeout(timer);
}

async function executeTaskCommand(
  tasks: TaskApplicationApi,
  command: TaskCommand,
): Promise<TaskCommandResult> {
  try {
    return await tasks.execute(command);
  } catch {
    return { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
  }
}

/** Holds the root's removal pending in the inspector's own state until the command settles. */
async function whileRemovingRoot<T>(
  state: AppState,
  ref: TaskRef,
  remove: () => Promise<T>,
): Promise<T> {
  const release = state.beginTaskRemoval(ref);
  try {
    return await remove();
  } finally {
    release();
  }
}

function subtaskUndoPosition(
  stack: readonly TaskLike[],
  ref: SubtaskRef,
): InlineUndoPosition | undefined {
  const parent = stack.find((node) => sameTaskNodeRef(taskNodeRef(node), ref.parent));
  if (parent === undefined) return undefined;
  const index = parent.subtasks.findIndex((sub) =>
    sameTaskNodeRef(taskNodeRef(sub), { type: 'subtask', ref }),
  );
  const sub = parent.subtasks[index];
  return sub === undefined
    ? undefined
    : {
        list: '.abyss-subtask-section .abyss-subtask-list',
        index,
        title: sub.title,
      };
}

/** A result's submission token, with whether the result changed the note. */
interface PlanningResultSubmission {
  readonly token: object;
  readonly changed: boolean;
}

function planningResultSubmission(
  token: object | undefined,
  changed: boolean,
): PlanningResultSubmission | undefined {
  return token === undefined ? undefined : { token, changed };
}

/**
 * Marks the option for `priority` in a priority popover and clears the others: `is-active`,
 * `aria-selected`, and the check. The build and a rollback share it, so they cannot disagree.
 */

export class RightPanel {
  private readonly undo_abyssPrivate = createInlineTaskUndo();
  private selectionEpoch_abyssPrivate = 0;
  private undoConvergence_abyssPrivate: SubmittedDraft | undefined;
  private ownedConvergence_abyssPrivate: SubmittedDraft | undefined;
  private restoredFocusTimer_abyssPrivate: number | undefined;
  private readonly completionConfirmationAbortController_abyssPrivate = new AbortController();
  private el_abyssPrivate!: HTMLElement;
  private mounted_abyssPrivate = false;
  private listActivation_abyssPrivate = new AbortController();
  private pendingPlanningRender_abyssPrivate = false;
  private pendingPlanningMetadata_abyssPrivate = false;
  private queuedPlanningRender_abyssPrivate:
    | { readonly ownerWindow: Window; readonly timer: number; readonly generation: number }
    | undefined;
  private planningRenderGeneration_abyssPrivate = 0;
  private readonly state_abyssPrivate: AppState;
  private readonly app_abyssPrivate: App;
  private readonly statusRegistry_abyssPrivate: StatusRegistry;
  private readonly settings_abyssPrivate: CalendarSettings | undefined;
  private readonly tasks_abyssPrivate: TaskApplicationApi | undefined;
  private readonly onRenderHeaderActions_abyssPrivate: ((actions: HTMLElement) => void) | undefined;
  private readonly onMutationLifecycle_abyssPrivate:
    ((event: RightPanelMutationLifecycle) => void) | undefined;
  private readonly commentTimeContext_abyssPrivate: CommentTimeContextProvider | undefined;
  private readonly interactionOwnership_abyssPrivate: InteractionOwnershipPort;
  private readonly timeTracking_abyssPrivate: TrackingSurface | undefined;
  private timeBadge_abyssPrivate: TimeBadgeHandle | undefined;
  private off_abyssPrivate?: () => void;
  private offDependencyQueries_abyssPrivate: (() => void) | undefined;
  private endTaskDrag_abyssPrivate: (() => void) | undefined;
  private md_abyssPrivate = new Component();
  private readonly onSuccessfulMutation_abyssPrivate: ((ref?: TaskRef) => void) | undefined;
  private readonly submittedDrafts_abyssPrivate = new Map<object, SubmittedDraft>();
  private detachedDrafts_abyssPrivate: Array<{
    readonly id: number;
    readonly key: string;
    readonly draft: RightPanelDraftState;
    readonly origin: RightPanelDraftBundle['origin'];
  }> = [];
  private nextDetachedDraftId_abyssPrivate = 0;
  private detachedAnnouncement_abyssPrivate = '';
  private detachedFocusTimer_abyssPrivate: number | undefined;

  private readonly taskOwners_abyssPrivate = new Map<string, InspectorTaskOwner>();
  private readonly breadcrumbTitles_abyssPrivate: Array<{
    readonly element: HTMLElement;
    readonly owner: InspectorTaskOwner;
    task: TaskLike;
    component: Component;
  }> = [];
  private retainedStack_abyssPrivate: readonly TaskLike[] = [];
  private retainedDocument_abyssPrivate: Document | undefined;
  private metadataTask_abyssPrivate: TaskLike | undefined;
  private retainedProof_abyssPrivate: OwnedTaskSelectionProof | undefined;

  private taskOwner_abyssPrivate(task: TaskLike): InspectorTaskOwner {
    const key = JSON.stringify(taskNodeRef(task));
    let owner = this.taskOwners_abyssPrivate.get(key);
    if (owner === undefined) {
      owner = { current: task };
      this.taskOwners_abyssPrivate.set(key, owner);
    }
    return owner;
  }

  private retireTaskOwners_abyssPrivate(): void {
    for (const owner of this.taskOwners_abyssPrivate.values()) owner.current = undefined;
    this.taskOwners_abyssPrivate.clear();
    this.breadcrumbTitles_abyssPrivate.length = 0;
    this.retainedStack_abyssPrivate = [];
    this.retainedProof_abyssPrivate = undefined;
    this.sections_abyssPrivate.destroy();
  }

  private readonly sections_abyssPrivate: InspectorSections;
  private readonly dependencies_abyssPrivate: InspectorDependencies;
  private readonly planningSurfaces_abyssPrivate: InspectorPlanningSurfaces;

  constructor(options: RightPanelOptions) {
    const {
      state,
      app,
      statusRegistry,
      settings,
      onSuccessfulMutation,
      tasks,
      onRenderHeaderActions,
      onMutationLifecycle,
      commentTimeContext,
      interactionOwnership = noInteractionOwnership,
      timeTracking,
    } = options;
    this.state_abyssPrivate = state;
    this.app_abyssPrivate = app;
    this.statusRegistry_abyssPrivate = statusRegistry;
    this.settings_abyssPrivate = settings;
    this.onSuccessfulMutation_abyssPrivate = onSuccessfulMutation;
    this.tasks_abyssPrivate = tasks;
    this.onRenderHeaderActions_abyssPrivate = onRenderHeaderActions;
    this.onMutationLifecycle_abyssPrivate = onMutationLifecycle;
    this.commentTimeContext_abyssPrivate = commentTimeContext;
    this.interactionOwnership_abyssPrivate = interactionOwnership;
    this.timeTracking_abyssPrivate = timeTracking;
    this.planningSurfaces_abyssPrivate = new InspectorPlanningSurfaces({
      app,
      settings,
      statusRegistry,
      queries: tasks?.queries,
      interactionOwnership,
      timeTracking,
      host: {
        showInTaskList:
          options.onShowInTaskList === undefined
            ? undefined
            : (task) => {
                this.showInTaskList_abyssPrivate(task, options.onShowInTaskList);
              },
        root: () => this.el_abyssPrivate,
        mounted: () => this.mounted_abyssPrivate,
        component: () => this.md_abyssPrivate,
        taskOwner: (task) => this.taskOwner_abyssPrivate(task),
        stack: () => this.state_abyssPrivate.get('taskStack'),
        rebuildPlanningTargetStack: (root, target) => rebuildPlanningTargetStack(root, target),
        dependencyTask: (stack) => this.dependencyTask_abyssPrivate(stack),
        trackingNode: () => this.trackingNode_abyssPrivate(),
        timeBadge: () => this.timeBadge_abyssPrivate,
        formatDate: (date) => this.formatDate_abyssPrivate(date),
        onTypedInputReleased: () => {
          this.scheduleDeferredPlanningRender_abyssPrivate();
        },
        closeAttachedSearch: () => {
          this.dependencies_abyssPrivate.closeAttachedSearch();
        },
        closeSearchSurface: (surface) => {
          this.dependencies_abyssPrivate.closeSearchSurface(surface);
        },
      },
      commands: {
        setStatus: (task, symbol) => this.setStatus_abyssPrivate(task, symbol),
        updatePriority: (task, priority) => this.updatePriority_abyssPrivate(task, priority),
        updateDate: (task, field, date) => this.updateDate_abyssPrivate(task, field, date),
        clearDate: (task) => this.clearDate_abyssPrivate(task),
        clearPlanningDate: (task, field) => this.clearPlanningDate_abyssPrivate(task, field),
        updateTime: (task, time) => this.updateTime_abyssPrivate(task, time),
        updateDuration: (task, minutes) => this.updateDuration_abyssPrivate(task, minutes),
        clearDuration: (task) => this.clearDuration_abyssPrivate(task),
        removeTag: (task, tag) => this.removeTag_abyssPrivate(task, tag),
        addTags: (task, tags) => this.addTags_abyssPrivate(task, tags),
        executePlanningPatch: (task, patch) => this.executePlanningPatch_abyssPrivate(task, patch),
        archiveRootTask: (ref) => this.archiveRootTask_abyssPrivate(ref),
        deleteTask: (task) => this.deleteTask_abyssPrivate(task),
        promoteSubtask: (task) => this.promoteSubtask_abyssPrivate(task),
      },
    });
    this.dependencies_abyssPrivate = this.createDependencies_abyssPrivate(options);
    this.sections_abyssPrivate = this.createSections_abyssPrivate();
  }

  private showInTaskList_abyssPrivate(task: TaskLike, action: ShowInTaskList | undefined): void {
    if (action === undefined) return;
    this.listActivation_abyssPrivate.abort();
    const controller = new AbortController();
    this.listActivation_abyssPrivate = controller;
    const owner = this.taskOwner_abyssPrivate(task);
    const target = taskNodeRef(task);
    const intent = this.state_abyssPrivate.taskSelectionIntentGeneration;
    const window = this.el_abyssPrivate.ownerDocument.defaultView;
    const isCurrent = (): boolean =>
      !controller.signal.aborted &&
      this.mounted_abyssPrivate &&
      this.el_abyssPrivate.ownerDocument.defaultView === window &&
      this.state_abyssPrivate.taskSelectionIntentGeneration === intent &&
      owner.current !== undefined &&
      sameTaskNodeRef(taskNodeRef(owner.current), target);
    if (!isCurrent()) return;
    void action(target, { signal: controller.signal, isCurrent }).catch((error: unknown) => {
      if (!isCurrent()) return;
      console.error('[abyss-tasks] task list navigation failed', {
        phase: 'activation',
        category: error instanceof Error ? error.name : typeof error,
      });
      new Notice('Could not show task in task list');
    });
  }

  private createDependencies_abyssPrivate(options: RightPanelOptions): InspectorDependencies {
    return new InspectorDependencies({
      state: this.state_abyssPrivate,
      queries: this.tasks_abyssPrivate?.queries,
      search: options.search,
      provider: options.dependencySearch,
      localSearchScope: options.localSearchScope,
      statusRegistry: this.statusRegistry_abyssPrivate,
      interactionOwnership: this.interactionOwnership_abyssPrivate,
      surfaces: this.planningSurfaces_abyssPrivate,
      host: {
        root: () => this.el_abyssPrivate,
        mounted: () => this.mounted_abyssPrivate,
        dependencyTask: (stack) => this.dependencyTask_abyssPrivate(stack),
        isBlocked: (task) => this.isDependencyBlocked_abyssPrivate(task),
        detachUndo: () => {
          this.undo_abyssPrivate.detach();
        },
        renderUndo: () => {
          this.undo_abyssPrivate.render(this.el_abyssPrivate);
        },
        refreshTimeBadge: () => this.timeBadge_abyssPrivate?.update(),
        finishTaskDrag: () => {
          this.finishTaskDrag_abyssPrivate();
        },
        setTaskDragCleanup: (cleanup) => {
          this.setTaskDragCleanup_abyssPrivate(cleanup);
        },
      },
      commands: {
        executeDependencyCommand: (command, position) =>
          this.executeDependencyCommand_abyssPrivate(command, position),
        createDependencySubtask: (text, direction) =>
          this.createDependencySubtask_abyssPrivate(text, direction),
      },
    });
  }

  private createSections_abyssPrivate(): InspectorSections {
    return new InspectorSections({
      app: this.app_abyssPrivate,
      state: this.state_abyssPrivate,
      statusRegistry: this.statusRegistry_abyssPrivate,
      interactionOwnership: this.interactionOwnership_abyssPrivate,
      host: {
        root: () => this.el_abyssPrivate,
        component: () => this.md_abyssPrivate,
        taskOwner: (task) => this.taskOwner_abyssPrivate(task),
        renderTaskStatusMarker: (parent, task) => {
          this.renderTaskStatusMarker_abyssPrivate(parent, task);
        },
        bindHierarchyDrop: (surface, task) => {
          this.bindHierarchyDrop_abyssPrivate(surface, task);
        },
        finishTaskDrag: () => {
          this.finishTaskDrag_abyssPrivate();
        },
        setTaskDragCleanup: (cleanup) => {
          this.setTaskDragCleanup_abyssPrivate(cleanup);
        },
        dismissEntrySubmission: (kind, target) => {
          this.dismissEntrySubmission_abyssPrivate(kind, target);
        },
        cancelRestoredDraftFocus: (document) => {
          clearOptionalTimer(document.defaultView, this.restoredFocusTimer_abyssPrivate);
        },
      },
      commands: {
        saveTaskTitle: (task, text) => this.saveTaskTitle_abyssPrivate(task, text),
        appendToTitle: (task, text) => this.appendToTitle_abyssPrivate(task, text),
        updateDescription: (task, text) => this.updateDescription_abyssPrivate(task, text),
        addSubTask: (task, text) => this.addSubTask_abyssPrivate(task, text),
        addComment: (task, text, list, input) =>
          this.addComment_abyssPrivate(task, text, list, input),
        updateComment: (task, comment, text) =>
          this.updateComment_abyssPrivate(task, comment, text),
        deleteComment: (task, comment) => this.deleteComment_abyssPrivate(task, comment),
        deleteTask: (task) => this.deleteTask_abyssPrivate(task),
        reorderSubTask: (parent, moved, target, position) =>
          this.reorderSubTask_abyssPrivate(parent, moved, target, position),
        executeLinkEdit: (target, occurrence, replacement) =>
          this.executeLinkEdit_abyssPrivate(target, occurrence, replacement),
      },
    });
  }

  mount(container: HTMLElement): void {
    this.el_abyssPrivate = container;
    this.mounted_abyssPrivate = true;
    this.mountTimeBadge_abyssPrivate(container);
    this.dependencies_abyssPrivate.updateDisclosureSelection(
      this.state_abyssPrivate.get('taskStack'),
      false,
    );
    const offSelection = this.state_abyssPrivate.on('taskStack', (next, previous) => {
      const prior = this.dependencyTask_abyssPrivate(previous);
      const selected = next[next.length - 1];
      const sameSelection =
        prior !== undefined &&
        selected !== undefined &&
        sameTaskNodeRef(taskNodeRef(prior), taskNodeRef(selected));
      const owned = this.consumeOwnedSelection_abyssPrivate(next);
      const continuesOwnedSelection = owned !== undefined;
      this.retainedProof_abyssPrivate = owned?.proof;
      const continuesSelection = sameSelection || continuesOwnedSelection;
      this.dependencies_abyssPrivate.updateDisclosureSelection(next, continuesSelection);
      const statusFocus = continuesSelection
        ? this.planningSurfaces_abyssPrivate.statusFocusTarget(previous, (focusedStack) => {
            const nextRoot = next[0];
            if (owned?.command !== undefined && nextRoot !== undefined && 'source' in nextRoot) {
              const mapped = rebuildOwnedTaskSelection(
                nextRoot,
                focusedStack,
                owned.command,
                owned.creationPolicy,
              );
              if (mapped !== undefined) return mapped[mapped.length - 1];
            }
            return this.dependencyTask_abyssPrivate(focusedStack);
          })
        : undefined;
      const controls = continuesSelection
        ? this.planningSurfaces_abyssPrivate.planningFocusKeys()
        : undefined;
      this.advanceSelectionEpoch_abyssPrivate(sameSelection, continuesOwnedSelection);
      if (this.isCompletionSubmission_abyssPrivate(owned) && owned !== undefined)
        owned.epoch = this.selectionEpoch_abyssPrivate;
      this.render_abyssPrivate(statusFocus, controls);
    });
    const offHistory = this.state_abyssPrivate.onCommit((changed) => {
      if (
        changed.has('inspectorBackStack') &&
        !changed.has('taskStack') &&
        (this.el_abyssPrivate.querySelector('.abyss-inspector-back') !== null) !==
          this.state_abyssPrivate.get('inspectorBackStack').length > 0
      )
        this.render_abyssPrivate(undefined, this.planningSurfaces_abyssPrivate.planningFocusKeys());
    });
    const offDrag = this.state_abyssPrivate.on('draggingTaskNode', (next, previous) => {
      if (next?.source === 'center-card' || previous?.source === 'center-card')
        this.dependencies_abyssPrivate.refresh();
      else this.dependencies_abyssPrivate.clearDropClasses();
    });
    this.off_abyssPrivate = () => {
      offSelection();
      offHistory();
      offDrag();
    };
    this.offDependencyQueries_abyssPrivate = this.tasks_abyssPrivate?.queries.subscribe(() => {
      this.refreshInspectorHistory();
      queueMicrotask(() => {
        if (this.mounted_abyssPrivate) this.dependencies_abyssPrivate.refresh();
      });
    });
    this.render_abyssPrivate();
  }

  private advanceSelectionEpoch_abyssPrivate(
    sameSelection: boolean,
    continuesOwnedSelection: boolean,
  ): void {
    if (!sameSelection) {
      this.selectionEpoch_abyssPrivate++;
      if (this.undoConvergence_abyssPrivate?.command?.type !== 'restore-subtask')
        this.undo_abyssPrivate.clear();
      if (!continuesOwnedSelection) {
        this.dependencies_abyssPrivate.cancelSearch();
        this.planningSurfaces_abyssPrivate.clearRecurrenceIntent();
      }
    }
    if (this.undoConvergence_abyssPrivate !== undefined) {
      this.undoConvergence_abyssPrivate.epoch = this.selectionEpoch_abyssPrivate;
      this.undoConvergence_abyssPrivate = undefined;
    }
  }

  private consumeOwnedSelection_abyssPrivate(
    next: readonly TaskLike[],
  ): SubmittedDraft | undefined {
    const owned = this.ownedConvergence_abyssPrivate;
    this.ownedConvergence_abyssPrivate = undefined;
    const ownedSelection = owned?.successorSelection;
    return owned?.epoch === this.selectionEpoch_abyssPrivate &&
      next.length === ownedSelection?.length &&
      next.every((node, index) => {
        const successor = ownedSelection[index];
        return (
          successor !== undefined && sameTaskNodeRef(taskNodeRef(node), taskNodeRef(successor))
        );
      })
      ? owned
      : undefined;
  }

  /** One badge per mounted inspector: it owns its popover across every re-render below it. */
  private mountTimeBadge_abyssPrivate(container: HTMLElement): void {
    const tracking = this.timeTracking_abyssPrivate;
    if (tracking === undefined) return;
    this.timeBadge_abyssPrivate = mountTimeBadge({
      ...tracking,
      popoverOwner: container,
      boundary: container,
      node: () => this.trackingNode_abyssPrivate(),
      ownership: this.interactionOwnership_abyssPrivate,
    });
  }

  /** The selection as the index holds it now, so a tracking write never uses a stale ref. */
  private trackingNode_abyssPrivate(): TrackedNode | undefined {
    const task = this.dependencyTask_abyssPrivate();
    return task === undefined ? undefined : { snapshot: task, ref: taskNodeRef(task) };
  }

  onWindowMigrated(): void {
    this.listActivation_abyssPrivate.abort();
    const draft = this.captureDraftState();
    this.dependencies_abyssPrivate.cancelSearch();
    this.planningSurfaces_abyssPrivate.clearAnchoredSurfaces();
    this.retireTaskOwners_abyssPrivate();
    this.render_abyssPrivate();
    const root = this.state_abyssPrivate.get('taskStack')[0];
    if (root !== undefined && 'source' in root) this.restoreDraftState(draft, root);
  }

  destroy(): void {
    this.listActivation_abyssPrivate.abort();
    this.retireTaskOwners_abyssPrivate();
    this.invalidateDeferredPlanningRender_abyssPrivate();
    clearOptionalTimer(
      this.el_abyssPrivate.ownerDocument.defaultView,
      this.restoredFocusTimer_abyssPrivate,
    );
    this.ownedConvergence_abyssPrivate = undefined;
    this.undo_abyssPrivate.clear();
    this.undoConvergence_abyssPrivate = undefined;
    this.timeBadge_abyssPrivate?.destroy();
    this.timeBadge_abyssPrivate = undefined;
    this.mounted_abyssPrivate = false;
    this.planningSurfaces_abyssPrivate.resetRenderedControls();
    this.planningSurfaces_abyssPrivate.clearRecurrenceIntent();
    this.finishTaskDrag_abyssPrivate();
    this.completionConfirmationAbortController_abyssPrivate.abort();
    this.off_abyssPrivate?.();
    this.offDependencyQueries_abyssPrivate?.();
    this.dependencies_abyssPrivate.cancelSearch();
    this.dependencies_abyssPrivate.clearDisclosure();
    if (this.detachedFocusTimer_abyssPrivate !== undefined)
      window.clearTimeout(this.detachedFocusTimer_abyssPrivate);
    this.planningSurfaces_abyssPrivate.clearAnchoredSurfaces();
    this.el_abyssPrivate.empty();
    this.md_abyssPrivate.unload();
  }

  captureDraftState(): RightPanelDraftBundle | undefined {
    if (!this.mounted_abyssPrivate) return undefined;
    const stack = this.state_abyssPrivate.get('taskStack');
    const task = stack[stack.length - 1];
    const active = this.el_abyssPrivate.ownerDocument.activeElement;
    const candidates: RightPanelDraftState[] = [];
    const recurrence = this.planningSurfaces_abyssPrivate.captureRecurrenceDraft(active);
    if (recurrence != null) candidates.push(recurrence);
    const target = task != null ? taskNodeRef(task) : undefined;
    if (task == null || target == null)
      return candidates.length > 0 ? { entries: candidates } : undefined;
    candidates.push(...this.captureTextDrafts_abyssPrivate(task, target, active));
    const entries = candidates.filter((candidate) => candidate.hadFocus || isDirtyDraft(candidate));
    if (entries.length === 0) return undefined;
    const origin = this.draftOrigin_abyssPrivate(stack, task);
    return { entries, ...(origin != null && { origin }) };
  }

  private captureTextDrafts_abyssPrivate(
    task: TaskLike,
    target: PlanningTarget,
    active: Element | null,
  ): RightPanelDraftState[] {
    const candidates: RightPanelDraftState[] = [];
    const title =
      this.el_abyssPrivate.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit');
    if (title != null) {
      candidates.push({
        kind: 'title',
        target: { type: 'title', target },
        ...textDraftSnapshot(title, task.markdownTitle, active),
      });
    }
    const description =
      this.el_abyssPrivate.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit');
    if (description != null) {
      candidates.push({
        kind: 'description',
        target: { type: 'description', target },
        ...textDraftSnapshot(description, task.description ?? '', active),
      });
    }
    const rows = [...this.el_abyssPrivate.querySelectorAll<HTMLElement>('.abyss-comment-row')];
    for (const [index, row] of rows.entries()) {
      const commentEdit = row.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input');
      if (commentEdit == null) continue;
      const comment = task.comments[index];
      if (comment != null) {
        candidates.push({
          kind: 'existing-comment',
          target: { type: 'comment', ref: comment.ref },
          ...textDraftSnapshot(commentEdit, comment.text, active),
        });
      }
    }
    const newSubtask = this.el_abyssPrivate.querySelector<HTMLInputElement>(
      '.abyss-subtask-new-input',
    );
    if (newSubtask != null) {
      candidates.push({
        kind: 'new-subtask',
        parent: target,
        ...textDraftSnapshot(newSubtask, '', active),
      });
    }
    const newComment =
      this.el_abyssPrivate.querySelector<HTMLTextAreaElement>('.abyss-comment-input');
    if (newComment != null) {
      candidates.push({
        kind: 'new-comment',
        parent: target,
        ...textDraftSnapshot(newComment, '', active),
      });
    }
    return candidates;
  }

  private draftOrigin_abyssPrivate(
    stack: readonly TaskLike[],
    task: TaskLike,
  ): RightPanelDraftBundle['origin'] {
    const root = stack[0];
    if (root == null || !('source' in root)) return undefined;
    return {
      taskTitle: task.title,
      filePath: root.source.filePath,
      line: taskNodeLine(root, task),
    };
  }

  private isCompletionSubmission_abyssPrivate(submitted: SubmittedDraft | undefined): boolean {
    return (
      submitted?.command?.type === 'set-status' || submitted?.command?.type === 'toggle-completion'
    );
  }

  ownedRefForCompletionFollowUp(
    current: TaskSnapshot,
    stack: readonly TaskLike[],
    witness: CompletionTrackingWitness | undefined,
  ): TaskRef | undefined {
    if (witness === undefined || !sameTaskRef(witness.after, current.ref)) return undefined;
    const submitted = this.submissionForOwnedTransition_abyssPrivate(witness.before, stack);
    if (submitted?.consumed !== true || !this.isCompletionSubmission_abyssPrivate(submitted))
      return undefined;
    return this.selectionForOwnedTransition(witness.before, current, stack, witness) === undefined
      ? undefined
      : witness.before;
  }

  selectionForOwnedTransition(
    consumedRef: TaskRef | undefined,
    current: TaskSnapshot,
    stack: readonly TaskLike[],
    witness?: CompletionTrackingWitness,
  ): TaskLike[] | undefined {
    if (consumedRef === undefined) return undefined;
    const submitted = this.submissionForOwnedTransition_abyssPrivate(consumedRef, stack);
    if (submitted?.command === undefined) return undefined;
    const proof = submitted.consumed
      ? proveOwnedCompletionFollowUp(current, stack, {
          original: submitted.selection,
          command: submitted.command,
          witness,
        })
      : proveOwnedTaskSelection(
          current,
          submitted.selection,
          submitted.command,
          submitted.creationPolicy,
        );
    if (proof !== undefined) {
      submitted.proof = proof;
      submitted.successorSelection = proof.selection;
    }
    return proof?.selection;
  }

  private submissionForOwnedTransition_abyssPrivate(
    consumedRef: TaskRef,
    stack: readonly TaskLike[],
  ): SubmittedDraft | undefined {
    const submitted = [...this.submittedDrafts_abyssPrivate.values()].find((candidate) =>
      candidate.rootAliases.some((alias) => sameTaskRef(alias, consumedRef)),
    );
    if (submitted?.command === undefined || submitted.epoch !== this.selectionEpoch_abyssPrivate)
      return undefined;
    const basis = submitted.consumed ? submitted.successorSelection : submitted.selection;
    if (
      stack.length !== basis?.length ||
      !stack.every((node, index) => {
        const previous = basis[index];
        return previous !== undefined && sameTaskNodeRef(taskNodeRef(node), taskNodeRef(previous));
      })
    )
      return undefined;
    return submitted;
  }

  captureDraftStateForOwnedTransition(
    consumedOwnedRef: TaskRef,
    successorRef: TaskRef,
    token?: object,
  ): RightPanelDraftBundle | undefined {
    const bundle = this.captureDraftState();
    const submitted = this.submittedDraftForRef_abyssPrivate(consumedOwnedRef, token);
    if (submitted?.rootAliases.some((alias) => sameTaskRef(alias, consumedOwnedRef)) !== true) {
      return bundle;
    }
    if (!submitted.rootAliases.some((alias) => sameTaskRef(alias, successorRef))) {
      submitted.rootAliases.push({ ...successorRef });
    }
    if (submitted.consumed) {
      if (this.isCompletionSubmission_abyssPrivate(submitted))
        this.captureOwnedConvergence_abyssPrivate(submitted);
      return this.mapOwnedDraftBundle_abyssPrivate(bundle, submitted.proof);
    }
    submitted.consumed = true;
    this.captureUndoConvergence_abyssPrivate(submitted);
    this.captureOwnedConvergence_abyssPrivate(submitted);
    const submittedDraft = submitted.draft;
    if (submittedDraft == null || bundle == null)
      return this.mapOwnedDraftBundle_abyssPrivate(bundle, submitted.proof);
    const entries = bundle.entries.flatMap((candidate) =>
      this.consumeSubmittedEntry_abyssPrivate(candidate, submittedDraft, submitted),
    );
    return this.mapOwnedDraftBundle_abyssPrivate(
      entries.length > 0 ? { ...bundle, entries } : undefined,
      submitted.proof,
    );
  }

  private submittedDraftForRef_abyssPrivate(
    consumedOwnedRef: TaskRef,
    token: object | undefined,
  ): SubmittedDraft | undefined {
    return token != null
      ? this.submittedDrafts_abyssPrivate.get(token)
      : [...this.submittedDrafts_abyssPrivate.values()].find((candidate) =>
          candidate.rootAliases.some((alias) => sameTaskRef(alias, consumedOwnedRef)),
        );
  }

  private mapOwnedDraftBundle_abyssPrivate(
    bundle: RightPanelDraftBundle | undefined,
    proof: OwnedTaskSelectionProof | undefined,
  ): RightPanelDraftBundle | undefined {
    if (bundle === undefined || proof === undefined) return bundle;
    const root = proof.selection[0];
    if (root === undefined || !('source' in root)) return bundle;
    const context = createRightPanelDraftRebaseContext(proof);
    return {
      ...bundle,
      entries: bundle.entries.map((draft) => rebaseRightPanelDraft(draft, root, context) ?? draft),
    };
  }

  private consumeSubmittedEntry_abyssPrivate(
    candidate: RightPanelDraftState,
    submittedDraft: RightPanelDraftState,
    submitted: SubmittedDraft,
  ): RightPanelDraftState[] {
    const matches = this.sameDraftPayload_abyssPrivate(candidate, submittedDraft);
    if (!isEntryDraft(candidate)) {
      if (matches) this.consumeSubmittedEditor_abyssPrivate(candidate);
      return matches ? [] : [candidate];
    }
    const parent = this.successorDraftParent_abyssPrivate(candidate.parent, submitted);
    if (!matches) return [{ ...candidate, parent: parent ?? candidate.parent }];
    this.clearSubmittedEntryInput_abyssPrivate(candidate.kind);
    if (!candidate.hadFocus || submitted.dismissed === true || parent === undefined) return [];
    return [{ ...candidate, parent, value: '', selectionStart: 0, selectionEnd: 0, dirty: false }];
  }

  private consumeSubmittedEditor_abyssPrivate(draft: RightPanelDraftState): void {
    if (draft.kind === 'existing-comment')
      this.sections_abyssPrivate.consumeCommentEditor(draft.target.ref);
    if (draft.kind === 'recurrence-editor')
      this.planningSurfaces_abyssPrivate.consumeRecurrenceDraft();
  }

  private clearSubmittedEntryInput_abyssPrivate(kind: 'new-subtask' | 'new-comment'): void {
    const input = this.el_abyssPrivate.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      kind === 'new-subtask' ? '.abyss-subtask-new-input' : '.abyss-comment-input',
    );
    if (input !== null) input.value = '';
  }

  private successorDraftParent_abyssPrivate(
    parent: TaskNodeRef,
    submitted: SubmittedDraft,
  ): TaskNodeRef | undefined {
    const selected = submitted.selection[submitted.selection.length - 1];
    const successor = submitted.successorSelection?.[submitted.successorSelection.length - 1];
    return selected !== undefined &&
      successor !== undefined &&
      sameTaskNodeRef(parent, taskNodeRef(selected))
      ? taskNodeRef(successor)
      : undefined;
  }

  private captureOwnedConvergence_abyssPrivate(submitted: SubmittedDraft): void {
    if (
      submitted.successorSelection !== undefined &&
      submitted.epoch === this.selectionEpoch_abyssPrivate
    ) {
      this.ownedConvergence_abyssPrivate = submitted;
      queueMicrotask(() => {
        if (this.ownedConvergence_abyssPrivate === submitted)
          this.ownedConvergence_abyssPrivate = undefined;
      });
    }
  }

  private captureUndoConvergence_abyssPrivate(submitted: SubmittedDraft): void {
    // Only the immediately following owned selection update may advance the deletion's epoch.
    if (
      submitted.epoch === this.selectionEpoch_abyssPrivate &&
      (submitted.command?.type === 'delete-subtask' ||
        submitted.command?.type === 'restore-subtask')
    ) {
      this.undoConvergence_abyssPrivate = submitted;
      queueMicrotask(() => {
        this.undoConvergence_abyssPrivate = undefined;
      });
    }
  }

  private snapshotDraft_abyssPrivate(draft: RightPanelDraftState): RightPanelDraftState {
    if (draft.kind !== 'recurrence-editor') return { ...draft };
    return {
      ...draft,
      editor: {
        ...draft.editor,
        weekdays: [...draft.editor.weekdays],
        monthly: { ...draft.editor.monthly },
        yearly: { ...draft.editor.yearly },
      },
    };
  }

  private sameDraftPayload_abyssPrivate(
    left: RightPanelDraftState,
    right: RightPanelDraftState,
  ): boolean {
    if (draftIdentity(left) !== draftIdentity(right) || left.kind !== right.kind) return false;
    if (left.kind !== 'recurrence-editor' && right.kind !== 'recurrence-editor') {
      return left.value === right.value;
    }
    if (left.kind !== 'recurrence-editor' || right.kind !== 'recurrence-editor') return false;
    const semanticEditor = (editor: typeof left.editor): readonly unknown[] => [
      editor.mode,
      editor.preset,
      editor.intervalText,
      editor.unit,
      editor.weekdays,
      editor.monthly,
      editor.yearly,
      editor.whenDone,
      editor.onCompletion,
      editor.customDraft,
    ];
    return (
      JSON.stringify(semanticEditor(left.editor)) === JSON.stringify(semanticEditor(right.editor))
    );
  }

  private beginDraftSubmission_abyssPrivate(
    target: PlanningTarget,
    matchesDraft?: (draft: RightPanelDraftState) => boolean,
    command?: TaskCommand,
  ): object | undefined {
    const ref = rootRefForPlanningTarget(target);
    if (
      [...this.submittedDrafts_abyssPrivate.values()].some((submitted) =>
        submitted.rootAliases.some((alias) => sameTaskRef(alias, ref)),
      )
    ) {
      return undefined;
    }
    const bundle = this.captureDraftState();
    const candidate = matchesDraft != null ? bundle?.entries.find(matchesDraft) : undefined;
    const stack = this.state_abyssPrivate.get('taskStack');
    const root = stack[0];
    const token = Object.freeze({});
    this.submittedDrafts_abyssPrivate.set(token, {
      ref: { ...ref },
      rootAliases: [{ ...ref }],
      ...(candidate != null && { draft: this.snapshotDraft_abyssPrivate(candidate) }),
      origin: bundle?.origin,
      selection:
        root !== undefined && 'source' in root
          ? rebuildTaskSelection(cloneTaskSnapshot(root), stack)
          : [],
      ...(command === undefined ? {} : { command: structuredClone(command) }),
      creationPolicy: this.creationProofPolicy_abyssPrivate(),
      consumed: false,
      epoch: this.selectionEpoch_abyssPrivate,
    });
    this.onMutationLifecycle_abyssPrivate?.({ phase: 'started', ref: { ...ref }, token });
    return token;
  }

  private creationProofPolicy_abyssPrivate(): Parameters<typeof rebuildOwnedTaskSelection>[3] {
    const settings = this.settings_abyssPrivate;
    return settings === undefined
      ? undefined
      : {
          taskPrefix: settings.taskPrefix,
          inbox: { ...settings.inbox },
          addCreatedDate: settings.taskLifecycle.addCreatedDate,
        };
  }

  private matchesBlockCommandDraft_abyssPrivate(
    draft: RightPanelDraftState,
    command: TaskCommand,
  ): boolean {
    if (command.type === 'set-description') {
      return draft.kind === 'description' && sameTaskNodeRef(draft.target.target, command.target);
    }
    if (command.type === 'add-subtask') {
      return draft.kind === 'new-subtask' && sameTaskNodeRef(draft.parent, command.parent);
    }
    if (command.type === 'add-comment') {
      return draft.kind === 'new-comment' && sameTaskNodeRef(draft.parent, command.parent);
    }
    if (command.type === 'update-comment' || command.type === 'delete-comment') {
      return draft.kind === 'existing-comment' && sameCommentRef(draft.target.ref, command.comment);
    }
    return false;
  }

  private settleDraftSubmission_abyssPrivate(token: object, result: TaskCommandResult): void {
    const submitted = this.submittedDrafts_abyssPrivate.get(token);
    if (submitted == null) return;
    this.submittedDrafts_abyssPrivate.delete(token);
    if (result.type !== 'ok' && submitted.consumed && submitted.draft != null) {
      this.recoverSubmittedDraft_abyssPrivate(submitted);
    }
    this.onMutationLifecycle_abyssPrivate?.({ phase: 'settled', ref: { ...submitted.ref }, token });
  }

  /**
   * Reopens or preserves a consumed submission's draft after its write failed. The draft keeps the
   * focus it had at submit time only while no control holds focus now.
   */
  private recoveryDraftOwner_abyssPrivate(draft: RightPanelDraftState): TaskNodeRef {
    switch (draft.kind) {
      case 'title':
      case 'description':
        return draft.target.target;
      case 'existing-comment':
        return draft.target.ref.parent;
      case 'new-comment':
      case 'new-subtask':
        return draft.parent;
      case 'recurrence-editor':
        return draft.target;
    }
  }

  private admittedRecoveryDraft_abyssPrivate(
    submitted: SubmittedDraft,
    stack: readonly TaskLike[],
  ): RightPanelDraftState | undefined {
    const draft = submitted.draft;
    const original = submitted.selection[submitted.selection.length - 1];
    const current = stack[stack.length - 1];
    if (
      draft === undefined ||
      original === undefined ||
      current === undefined ||
      !sameTaskNodeRef(this.recoveryDraftOwner_abyssPrivate(draft), taskNodeRef(original))
    )
      return undefined;
    const sameStack = (expected: readonly TaskLike[] | undefined): boolean =>
      stack.length === expected?.length &&
      stack.every((node, index) => {
        const prior = expected[index];
        return prior !== undefined && sameTaskNodeRef(taskNodeRef(node), taskNodeRef(prior));
      });
    if (!sameStack(submitted.selection) && !sameStack(submitted.successorSelection))
      return undefined;
    return this.mappedRecoveryDraft_abyssPrivate(draft, current);
  }

  private mappedRecoveryDraft_abyssPrivate(
    draft: RightPanelDraftState,
    current: TaskLike,
  ): RightPanelDraftState | undefined {
    const target = taskNodeRef(current);
    switch (draft.kind) {
      case 'title':
        return { ...draft, target: { type: 'title', target } };
      case 'description':
        return { ...draft, target: { type: 'description', target } };
      case 'existing-comment': {
        const matches = current.comments.filter(
          (comment) =>
            comment.ref.relativeLine === draft.target.ref.relativeLine &&
            comment.ref.originalMarkdown === draft.target.ref.originalMarkdown,
        );
        const comment = matches.length === 1 ? matches[0] : undefined;
        return comment === undefined
          ? undefined
          : { ...draft, target: { ...draft.target, ref: comment.ref } };
      }
      case 'new-comment':
      case 'new-subtask':
        return { ...draft, parent: target };
      case 'recurrence-editor':
        return { ...draft, target };
    }
  }

  private recoverSubmittedDraft_abyssPrivate(submitted: SubmittedDraft): void {
    const submittedDraft = submitted.draft;
    if (submittedDraft == null || submitted.dismissed === true) return;
    const preserveOriginal = (): void => {
      this.appendDetachedDraft_abyssPrivate(unfocusedDraft(submittedDraft), submitted.origin);
    };
    const stack = this.state_abyssPrivate.get('taskStack');
    const root = stack[0];
    const current = stack[stack.length - 1];
    const admitted = this.admittedRecoveryDraft_abyssPrivate(submitted, stack);
    if (
      admitted === undefined ||
      current === undefined ||
      root === undefined ||
      !('source' in root)
    ) {
      preserveOriginal();
      return;
    }
    const currentRef = taskNodeRef(current);
    const active = this.el_abyssPrivate.ownerDocument.activeElement;
    const candidates = this.captureRecoveryCandidates_abyssPrivate(current, currentRef, active);
    const disposition = this.recoveryLiveDisposition_abyssPrivate(candidates, admitted, currentRef);
    if (disposition !== 'unrepresented') {
      if (disposition === 'conflict') preserveOriginal();
      return;
    }
    this.restoreDraftState(
      {
        entries: [this.recoverableDraft_abyssPrivate(admitted)],
        ...(submitted.origin !== undefined && { origin: submitted.origin }),
      },
      root,
    );
  }

  private captureRecoveryCandidates_abyssPrivate(
    current: TaskLike,
    currentRef: TaskNodeRef,
    active: Element | null,
  ): RightPanelDraftState[] {
    const candidates = this.captureTextDrafts_abyssPrivate(current, currentRef, active);
    const recurrence = this.planningSurfaces_abyssPrivate.captureRecurrenceDraft(active);
    if (recurrence !== undefined) candidates.push(recurrence);
    return candidates;
  }

  private recoveryLiveDisposition_abyssPrivate(
    candidates: readonly RightPanelDraftState[],
    admitted: RightPanelDraftState,
    currentRef: TaskNodeRef,
  ): 'equal' | 'conflict' | 'unrepresented' {
    const live = candidates.find((entry) => draftIdentity(entry) === draftIdentity(admitted));
    if (live !== undefined)
      return this.sameDraftPayload_abyssPrivate(live, admitted) ? 'equal' : 'conflict';
    return candidates.some((entry) => entry.hadFocus || isDirtyDraft(entry)) ||
      this.planningSurfaces_abyssPrivate.hasFocusedTypedInputFor(currentRef)
      ? 'conflict'
      : 'unrepresented';
  }

  restoreDraftState(bundle: RightPanelDraftBundle | undefined, currentRoot: TaskSnapshot): void {
    if (bundle == null) return;
    let focusTarget: HTMLElement | undefined;
    const context = createRightPanelDraftRebaseContext();
    for (const draft of bundle.entries) {
      const restoredFocus = this.restoreDraftEntry_abyssPrivate(
        draft,
        currentRoot,
        bundle.origin,
        context,
      );
      if (restoredFocus != null) focusTarget = restoredFocus;
    }
    if (focusTarget != null) {
      const focus = focusTarget;
      focus.focus();
      const ownerWindow = this.el_abyssPrivate.ownerDocument.defaultView;
      clearOptionalTimer(ownerWindow, this.restoredFocusTimer_abyssPrivate);
      this.restoredFocusTimer_abyssPrivate = ownerWindow?.setTimeout(() => {
        this.restoredFocusTimer_abyssPrivate = undefined;
        if (
          this.mounted_abyssPrivate &&
          focus.isConnected &&
          focus.ownerDocument.activeElement === focus
        )
          focus.focus();
      }, 0);
    }
  }

  private restoreDraftEntry_abyssPrivate(
    draft: RightPanelDraftState,
    currentRoot: TaskSnapshot,
    origin?: RightPanelDraftBundle['origin'],
    context = createRightPanelDraftRebaseContext(),
  ): HTMLElement | undefined {
    const rebased = rebaseRightPanelDraft(draft, currentRoot, context);
    if (rebased == null) {
      this.preserveDirtyDraft_abyssPrivate(draft, origin);
      return undefined;
    }
    const stack = this.state_abyssPrivate.get('taskStack');
    const task = stack[stack.length - 1];
    if (task == null) {
      this.preserveDirtyDraft_abyssPrivate(rebased, origin);
      return undefined;
    }
    if (rebased.kind === 'recurrence-editor') {
      return this.restoreRecurrenceDraft_abyssPrivate(rebased, task, stack, origin);
    }
    const edit = this.restoreTextDraftElement_abyssPrivate(rebased, task);
    if (edit == null) {
      if (rebased.dirty) this.appendDetachedDraft_abyssPrivate(rebased, origin);
      return undefined;
    }
    edit.value = rebased.value;
    edit.setSelectionRange(rebased.selectionStart, rebased.selectionEnd);
    return rebased.hadFocus ? edit : undefined;
  }

  private preserveDirtyDraft_abyssPrivate(
    draft: RightPanelDraftState,
    origin?: RightPanelDraftBundle['origin'],
  ): void {
    if (isDirtyDraft(draft)) this.appendDetachedDraft_abyssPrivate(draft, origin);
  }

  /** Reopens a captured repeat editor on the control that opened it, carrying its intent on. */
  private restoreRecurrenceDraft_abyssPrivate(
    draft: Extract<RightPanelDraftState, { readonly kind: 'recurrence-editor' }>,
    task: TaskLike,
    stack: readonly TaskLike[],
    origin?: RightPanelDraftBundle['origin'],
  ): HTMLElement | undefined {
    const result = this.planningSurfaces_abyssPrivate.restoreRecurrenceDraft(draft, task, stack);
    if (!result.anchorFound) this.preserveDirtyDraft_abyssPrivate(draft, origin);
    return result.focus;
  }

  private restoreTextDraftElement_abyssPrivate(
    rebased: Exclude<RightPanelDraftState, { readonly kind: 'recurrence-editor' }>,
    task: TaskLike,
  ): HTMLInputElement | HTMLTextAreaElement | null {
    if (rebased.kind === 'title') {
      if (this.el_abyssPrivate.querySelector('.abyss-right-title-edit') === null)
        this.clickElement_abyssPrivate('.abyss-right-title-view');
      return this.el_abyssPrivate.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit');
    }
    if (rebased.kind === 'description') {
      if (this.el_abyssPrivate.querySelector('.abyss-right-desc-edit') === null)
        this.clickElement_abyssPrivate('.abyss-right-desc-view');
      return this.el_abyssPrivate.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit');
    }
    if (rebased.kind === 'existing-comment') {
      return this.restoreCommentDraftElement_abyssPrivate(rebased, task);
    }
    if (rebased.kind === 'new-subtask') {
      if (this.el_abyssPrivate.querySelector('.abyss-subtask-new-input') === null)
        this.clickElement_abyssPrivate('.abyss-subtask-section .abyss-subtask-add-row');
      return this.el_abyssPrivate.querySelector<HTMLInputElement>('.abyss-subtask-new-input');
    }
    return this.el_abyssPrivate.querySelector<HTMLTextAreaElement>('.abyss-comment-input');
  }

  private restoreCommentDraftElement_abyssPrivate(
    draft: Extract<RightPanelDraftState, { readonly kind: 'existing-comment' }>,
    task: TaskLike,
  ): HTMLTextAreaElement | null {
    const index = task.comments.findIndex(
      (comment) =>
        comment.ref.relativeLine === draft.target.ref.relativeLine &&
        comment.ref.originalMarkdown === draft.target.ref.originalMarkdown,
    );
    const row = this.el_abyssPrivate.querySelectorAll<HTMLElement>('.abyss-comment-row')[index];
    const text = row?.querySelector<HTMLElement>('.abyss-comment-text');
    if (row?.querySelector('.abyss-comment-edit-input') === null) text?.click();
    return row?.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input') ?? null;
  }

  private clickElement_abyssPrivate(selector: string): void {
    this.el_abyssPrivate.querySelector<HTMLElement>(selector)?.click();
  }

  detachDraftState(bundle: RightPanelDraftBundle | undefined): void {
    for (const draft of bundle?.entries ?? []) {
      if (isDirtyDraft(draft)) this.appendDetachedDraft_abyssPrivate(draft, bundle?.origin);
    }
  }

  private appendDetachedDraft_abyssPrivate(
    draft: RightPanelDraftState,
    origin?: RightPanelDraftBundle['origin'],
  ): void {
    const key = draftIdentity(draft);
    const index = this.detachedDrafts_abyssPrivate.findIndex((entry) => entry.key === key);
    let id: number;
    if (index >= 0) {
      const existing = this.detachedDrafts_abyssPrivate[index];
      if (existing == null) return;
      id = existing.id;
      this.detachedDrafts_abyssPrivate[index] = {
        id,
        key,
        draft,
        origin: origin ?? existing.origin,
      };
    } else {
      id = ++this.nextDetachedDraftId_abyssPrivate;
      this.detachedDrafts_abyssPrivate.push({ id, key, draft, origin });
    }
    this.detachedAnnouncement_abyssPrivate = `Draft preserved for ${this.detachedDraftLabel_abyssPrivate(draft, origin)}.`;
    this.renderDetachedDraftTray_abyssPrivate();
    if (draft.hadFocus) {
      if (this.detachedFocusTimer_abyssPrivate !== undefined)
        window.clearTimeout(this.detachedFocusTimer_abyssPrivate);
      this.detachedFocusTimer_abyssPrivate =
        this.el_abyssPrivate.ownerDocument.defaultView?.setTimeout(() => {
          this.detachedFocusTimer_abyssPrivate = undefined;
          this.el_abyssPrivate
            .querySelector<HTMLButtonElement>(
              `[data-abyss-detached-draft="${id}"] .abyss-detached-draft-copy`,
            )
            ?.focus();
        }, 0);
    }
  }

  private detachedDraftLabel_abyssPrivate(
    draft: RightPanelDraftState,
    origin?: RightPanelDraftBundle['origin'],
  ): string {
    const field = draft.kind.replace(/-/gu, ' ');
    return origin != null ? `${origin.taskTitle}, ${field}` : field;
  }

  private renderDetachedDraftTray_abyssPrivate(): void {
    this.el_abyssPrivate.querySelector('.abyss-detached-drafts')?.remove();
    if (this.detachedDrafts_abyssPrivate.length === 0) return;
    const tray = this.el_abyssPrivate.createDiv({ cls: 'abyss-detached-drafts' });
    tray.createDiv({ cls: 'abyss-detached-drafts-title', text: 'Unsaved drafts' });
    tray.createDiv({
      cls: 'abyss-detached-drafts-status',
      text: this.detachedAnnouncement_abyssPrivate,
      attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    });
    for (const entry of this.detachedDrafts_abyssPrivate) {
      const label = this.detachedDraftLabel_abyssPrivate(entry.draft, entry.origin);
      const detached = tray.createDiv({
        cls: 'abyss-detached-draft',
        attr: {
          role: 'group',
          'aria-label': `Unsaved draft for ${label}`,
          'data-abyss-detached-draft': String(entry.id),
        },
      });
      detached.createDiv({
        cls: 'abyss-detached-draft-label',
        text: label,
      });
      detached.createEl('pre', { text: draftPlainText(entry.draft) });
      const status = detached.createDiv({ attr: { 'aria-live': 'polite' } });
      const copy = detached.createEl('button', {
        cls: 'abyss-detached-draft-copy',
        text: 'Copy',
        attr: { 'aria-label': `Copy unsaved draft for ${label}` },
      });
      copy.addEventListener('click', () => {
        if (this.detachedFocusTimer_abyssPrivate !== undefined) {
          window.clearTimeout(this.detachedFocusTimer_abyssPrivate);
          this.detachedFocusTimer_abyssPrivate = undefined;
        }
        runAsyncAction(
          (async () => {
            try {
              const clipboard = this.el_abyssPrivate.ownerDocument.defaultView?.navigator.clipboard;
              if (clipboard == null) throw new Error('clipboard-unavailable');
              await clipboard.writeText(draftPlainText(entry.draft));
              status.textContent = 'Copied.';
            } catch {
              status.textContent = 'Could not copy. The draft is still available.';
            }
            copy.focus();
          })(),
        );
      });
      const discard = detached.createEl('button', {
        cls: 'abyss-detached-draft-discard',
        text: 'Discard',
        attr: { 'aria-label': `Discard unsaved draft for ${label}` },
      });
      discard.addEventListener('click', () => {
        this.detachedDrafts_abyssPrivate = this.detachedDrafts_abyssPrivate.filter(
          (candidate) => candidate.id !== entry.id,
        );
        this.renderDetachedDraftTray_abyssPrivate();
      });
    }
    this.el_abyssPrivate.prepend(tray);
  }

  private invalidateDeferredPlanningRender_abyssPrivate(): void {
    const scheduled = this.queuedPlanningRender_abyssPrivate;
    if (scheduled !== undefined) scheduled.ownerWindow.clearTimeout(scheduled.timer);
    this.pendingPlanningRender_abyssPrivate = false;
    this.pendingPlanningMetadata_abyssPrivate = false;
    this.queuedPlanningRender_abyssPrivate = undefined;
    this.planningRenderGeneration_abyssPrivate++;
  }

  private scheduleDeferredPlanningRender_abyssPrivate(): void {
    if (
      !this.pendingPlanningRender_abyssPrivate ||
      this.queuedPlanningRender_abyssPrivate !== undefined ||
      !this.mounted_abyssPrivate
    )
      return;
    const ownerWindow = this.el_abyssPrivate.ownerDocument.defaultView;
    if (ownerWindow === null) return;
    const scheduled = {
      ownerWindow,
      timer: 0,
      generation: this.planningRenderGeneration_abyssPrivate,
    };
    scheduled.timer = ownerWindow.setTimeout(() => {
      if (
        this.queuedPlanningRender_abyssPrivate !== scheduled ||
        scheduled.generation !== this.planningRenderGeneration_abyssPrivate ||
        !this.mounted_abyssPrivate
      )
        return;
      this.queuedPlanningRender_abyssPrivate = undefined;
      const stack = this.state_abyssPrivate.get('taskStack');
      const task = stack[stack.length - 1];
      if (
        task !== undefined &&
        this.planningSurfaces_abyssPrivate.hasFocusedTypedInputFor(taskNodeRef(task))
      )
        return;
      if (this.pendingPlanningMetadata_abyssPrivate && task !== undefined) {
        this.pendingPlanningRender_abyssPrivate = false;
        this.pendingPlanningMetadata_abyssPrivate = false;
        this.refreshTaskMetadata_abyssPrivate(task);
      } else
        this.render_abyssPrivate(undefined, this.planningSurfaces_abyssPrivate.planningFocusKeys());
    }, 0);
    this.queuedPlanningRender_abyssPrivate = scheduled;
  }

  private render_abyssPrivate(
    statusFocus?: TaskNodeRef,
    controls?: readonly PlanningControlKey[],
  ): void {
    const stack = this.state_abyssPrivate.get('taskStack');
    const task = stack[stack.length - 1];
    if (task !== undefined && this.refreshRetainedInspector_abyssPrivate(task, stack)) {
      this.planningSurfaces_abyssPrivate.restoreRenderFocus(statusFocus, controls);
      return;
    }
    if (
      task !== undefined &&
      this.planningSurfaces_abyssPrivate.hasFocusedTypedInputFor(taskNodeRef(task))
    ) {
      this.pendingPlanningRender_abyssPrivate = true;
      return;
    }
    this.invalidateDeferredPlanningRender_abyssPrivate();
    clearOptionalTimer(
      this.el_abyssPrivate.ownerDocument.defaultView,
      this.restoredFocusTimer_abyssPrivate,
    );
    this.restoredFocusTimer_abyssPrivate = undefined;
    this.undo_abyssPrivate.detach();
    this.planningSurfaces_abyssPrivate.resetRenderedControls();
    this.dependencies_abyssPrivate.detachSearchForRender();
    this.retireTaskOwners_abyssPrivate();
    this.md_abyssPrivate.unload();
    this.md_abyssPrivate = new Component();
    this.md_abyssPrivate.load();
    this.planningSurfaces_abyssPrivate.clearAnchoredSurfaces();
    this.el_abyssPrivate.empty();
    if (task === undefined) {
      // Nothing is selected, so the badge is not re-placed and the popover it owns would otherwise
      // outlive the selection it was opened from, listeners and all.
      this.timeBadge_abyssPrivate?.closePopover();
      this.renderEmpty_abyssPrivate();
      this.renderDetachedDraftTray_abyssPrivate();
      return;
    }
    this.renderTask_abyssPrivate(task, stack, this.commentTimeContext_abyssPrivate?.());
    this.renderDetachedDraftTray_abyssPrivate();
    this.dependencies_abyssPrivate.reattachSearchAfterRender();
    this.planningSurfaces_abyssPrivate.restoreRenderFocus(statusFocus, controls);
  }

  private refreshRetainedInspector_abyssPrivate(
    next: TaskLike,
    stack: readonly TaskLike[],
  ): boolean {
    const previous = this.retainedStack_abyssPrivate[this.retainedStack_abyssPrivate.length - 1];
    const proof = this.retainedProof_abyssPrivate;
    this.retainedProof_abyssPrivate = undefined;
    if (
      previous === undefined ||
      this.retainedDocument_abyssPrivate !== this.el_abyssPrivate.ownerDocument
    )
      return false;
    const successor = proof?.successor(previous);
    if (
      successor === undefined ||
      !sameTaskNodeRef(taskNodeRef(successor), taskNodeRef(next)) ||
      proof === undefined
    )
      return false;
    this.advanceTaskOwners_abyssPrivate(proof);
    this.retainedStack_abyssPrivate = stack;
    this.updateBreadcrumbTitles_abyssPrivate();
    this.sections_abyssPrivate.update(next, this.commentTimeContext_abyssPrivate?.(), proof);
    this.refreshTaskMetadata_abyssPrivate(next);
    this.planningSurfaces_abyssPrivate.updateTaskOwners();
    this.dependencies_abyssPrivate.refresh();
    this.timeBadge_abyssPrivate?.update();
    this.undo_abyssPrivate.render(this.el_abyssPrivate);
    return true;
  }

  private advanceTaskOwners_abyssPrivate(proof: OwnedTaskSelectionProof): void {
    const owners = [...this.taskOwners_abyssPrivate.values()];
    this.taskOwners_abyssPrivate.clear();
    for (const owner of owners) {
      owner.current = owner.current === undefined ? undefined : proof.successor(owner.current);
      if (owner.current !== undefined)
        this.taskOwners_abyssPrivate.set(JSON.stringify(taskNodeRef(owner.current)), owner);
    }
  }

  private async executeLinkEdit_abyssPrivate(
    target: TaskTextTarget,
    occurrence: number,
    replacement: string,
  ): Promise<void> {
    const node = target.type === 'comment' ? target.ref.parent : target.target;
    await this.executeOwnedCommand_abyssPrivate(
      { type: 'edit-link', target, occurrence, replacement },
      node,
    );
  }

  /** Description block: rendered markdown (clickable links) that becomes a textarea on click. */
  private renderEmpty_abyssPrivate(): void {
    const empty = this.el_abyssPrivate.createDiv({ cls: 'abyss-right-empty' });
    const icon = empty.createDiv({ cls: 'abyss-right-empty-icon' });
    setIcon(icon, 'mouse-pointer-click');
    empty.createEl('p', { cls: 'abyss-right-empty-title', text: 'No task selected' });
    empty.createEl('p', {
      cls: 'abyss-right-empty-hint',
      text: 'Click a task to view and edit details',
    });
  }

  private renderTask_abyssPrivate(
    task: TaskLike,
    stack: TaskLike[],
    commentTimeContext?: CommentTimeContext,
  ): void {
    this.retainedStack_abyssPrivate = stack;
    this.retainedDocument_abyssPrivate = this.el_abyssPrivate.ownerDocument;
    this.renderBreadcrumb_abyssPrivate(stack);
    this.renderTaskHeader_abyssPrivate(task);
    this.renderTaskMetadata_abyssPrivate(task);
    this.sections_abyssPrivate.renderDescriptionSection(task);
    this.dependencies_abyssPrivate.renderSections();
    this.sections_abyssPrivate.renderSubtaskSection(task);
    this.sections_abyssPrivate.renderCommentSection(task, commentTimeContext);
    this.undo_abyssPrivate.render(this.el_abyssPrivate);
  }

  private renderBreadcrumb_abyssPrivate(stack: InspectorHistoryFrame['taskStack']): void {
    const hasHistory = this.state_abyssPrivate.get('inspectorBackStack').length > 0;
    if (stack.length <= 1 && !hasHistory) return;
    const breadcrumb = this.el_abyssPrivate.createDiv({ cls: 'abyss-breadcrumb' });
    if (hasHistory) {
      const back = breadcrumb.createEl('button', {
        cls: 'abyss-right-action-btn abyss-inspector-back',
        attr: {
          type: 'button',
          'aria-label': 'Back to previous task',
        },
      });
      setIcon(back, 'arrow-left');
      back.createSpan({ text: 'Back' });
      back.addEventListener('click', (event) => {
        event.stopPropagation();
        this.restoreDependencyFrame_abyssPrivate();
        this.el_abyssPrivate
          .querySelector<HTMLElement>('.abyss-inspector-back, .abyss-dep-badge-body')
          ?.focus();
      });
    }
    for (const [index, item] of stack.slice(0, -1).entries()) {
      if (index > 0) breadcrumb.createSpan({ cls: 'abyss-breadcrumb-sep', text: ' › ' });
      const owner = this.taskOwner_abyssPrivate(item);
      const crumb = breadcrumb.createSpan({ cls: 'abyss-breadcrumb-item' });
      this.breadcrumbTitles_abyssPrivate.push({
        element: crumb,
        owner,
        task: item,
        component: this.renderBreadcrumbTitle_abyssPrivate(crumb, item, owner),
      });
      crumb.addEventListener('click', () => {
        if (owner.current === undefined) return;
        this.state_abyssPrivate.navigateInspectorSelection(
          this.retainedStack_abyssPrivate.slice(0, index + 1),
        );
      });
    }
  }

  private updateBreadcrumbTitles_abyssPrivate(): void {
    for (const title of this.breadcrumbTitles_abyssPrivate) {
      const current = title.owner.current;
      if (current === undefined || current.markdownTitle === title.task.markdownTitle) continue;
      this.md_abyssPrivate.removeChild(title.component);
      title.task = current;
      title.component = this.renderBreadcrumbTitle_abyssPrivate(
        title.element,
        current,
        title.owner,
      );
    }
  }

  private renderBreadcrumbTitle_abyssPrivate(
    element: HTMLElement,
    task: TaskLike,
    owner: InspectorTaskOwner,
  ): Component {
    const component = this.md_abyssPrivate.addChild(new Component());
    renderTaskText(element, task.markdownTitle, {
      presentation: 'title',
      app: this.app_abyssPrivate,
      sourcePath: rootTaskRef(task).filePath,
      component,
      linkEventOwner: component,
      onEditLink: (occurrence, token) => {
        const current = owner.current;
        if (current !== undefined) this.sections_abyssPrivate.editLink(current, occurrence, token);
      },
    });
    return component;
  }

  private restoreDependencyFrame_abyssPrivate(): void {
    const frames = this.state_abyssPrivate.get('inspectorBackStack');
    const previous = frames[frames.length - 1];
    if (previous === undefined) return;
    const selected = this.liveHistorySelection_abyssPrivate(previous);
    if (selected === undefined) {
      new Notice(
        'Could not return to the previous task: it is unavailable or no longer uniquely identifiable. History was kept.',
      );
      return;
    }
    this.state_abyssPrivate.backInspectorDependency(selected);
  }

  /** Points every history frame the index can prove at its task's current reference. */
  refreshInspectorHistory(): void {
    const frames = this.state_abyssPrivate.get('inspectorBackStack');
    this.state_abyssPrivate.updateInspectorHistoryFrames(
      frames.map((frame) => {
        const taskStack = this.liveHistorySelection_abyssPrivate(frame);
        return taskStack === undefined ? frame : { taskStack };
      }),
    );
  }

  private liveHistorySelection_abyssPrivate(frame: InspectorHistoryFrame): TaskLike[] | undefined {
    const root = frame.taskStack[0];
    if (root === undefined) return undefined;
    if (this.tasks_abyssPrivate === undefined) return [...frame.taskStack];
    const resolution = this.tasks_abyssPrivate.queries.resolve(rootTaskRef(root));
    if (resolution.type !== 'exact' && resolution.type !== 'rebased') return undefined;
    const current = resolution.type === 'exact' ? resolution.task : resolution.current;
    const authorityRef =
      resolution.type === 'rebased' &&
      resolution.evidence === 'authority-transition' &&
      sameTaskRef(rootTaskRef(root), resolution.previous.ref)
        ? resolution.previous.ref
        : undefined;
    const selected = this.rebuildHistorySelection_abyssPrivate(current, frame, authorityRef);
    return selected.length === frame.taskStack.length ? selected : undefined;
  }

  private rebuildHistorySelection_abyssPrivate(
    current: TaskSnapshot,
    frame: InspectorHistoryFrame,
    authorityRef: TaskRef | undefined,
  ): TaskLike[] {
    const submitted =
      authorityRef === undefined
        ? undefined
        : [...this.submittedDrafts_abyssPrivate.values()].find(
            (candidate) => !candidate.consumed && sameTaskRef(candidate.ref, authorityRef),
          );
    return (
      (submitted?.command === undefined
        ? undefined
        : rebuildOwnedTaskSelection(
            current,
            frame.taskStack,
            submitted.command,
            submitted.creationPolicy,
          )) ??
      rebuildTaskSelection(current, frame.taskStack, {
        preserveDependencyChanges: authorityRef !== undefined,
      })
    );
  }

  private renderTaskHeader_abyssPrivate(task: TaskLike): void {
    const owner = this.taskOwner_abyssPrivate(task);
    const header = this.el_abyssPrivate.createDiv({ cls: 'abyss-right-header' });
    this.renderTaskStatusMarker_abyssPrivate(header, task);
    this.sections_abyssPrivate.renderTitleBlock(header, task);
    const headerActions = header.createDiv({ cls: 'abyss-right-header-actions' });
    const menuBtn = headerActions.createEl('button', {
      cls: 'clickable-icon abyss-right-action-btn',
      attr: {
        'aria-label': 'More actions',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
      },
    });
    setIcon(menuBtn, 'ellipsis');
    this.planningSurfaces_abyssPrivate.registerPlanningControl('more-actions', menuBtn);
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const current = owner.current;
      if (current !== undefined)
        this.planningSurfaces_abyssPrivate.renderContextMenu(current, menuBtn);
    });
    this.onRenderHeaderActions_abyssPrivate?.(headerActions);
    this.bindHierarchyDrop_abyssPrivate(header, task);
  }

  private bindHierarchyDrop_abyssPrivate(surface: HTMLElement, task: TaskLike): void {
    const owner = this.taskOwner_abyssPrivate(task);
    if (this.tasks_abyssPrivate !== undefined) {
      const tasks = this.tasks_abyssPrivate;
      this.md_abyssPrivate.register(
        bindTaskHierarchyDrop(surface, {
          state: this.state_abyssPrivate,
          tasks,
          parent: () => {
            const stack = this.state_abyssPrivate.get('taskStack');
            const current = stack[stack.length - 1];
            return current !== undefined &&
              owner.current !== undefined &&
              sameTaskNodeRef(taskNodeRef(current), taskNodeRef(owner.current))
              ? taskNodeRef(current)
              : undefined;
          },
          execute: (command) => this.executeHierarchyCommand_abyssPrivate(command),
        }),
      );
    }
  }

  private async executeHierarchyCommand_abyssPrivate(
    command: Extract<TaskCommand, { type: 'reparent-task' | 'promote-subtask' }>,
  ): Promise<void> {
    if (this.tasks_abyssPrivate === undefined) return;
    const source =
      command.type === 'reparent-task'
        ? command.source
        : { type: 'subtask' as const, ref: command.subtask };
    const ref = rootRefForPlanningTarget(source);
    const token = {};
    this.onMutationLifecycle_abyssPrivate?.({
      phase: 'started',
      ref,
      token,
      operation: 'hierarchy',
    });
    try {
      await executeTaskHierarchy(
        this.state_abyssPrivate,
        this.tasks_abyssPrivate,
        command,
        () => this.mounted_abyssPrivate,
      );
    } finally {
      this.onMutationLifecycle_abyssPrivate?.({
        phase: 'settled',
        ref,
        token,
        operation: 'hierarchy',
      });
    }
  }

  private async promoteSubtask_abyssPrivate(task: TaskLike): Promise<void> {
    const target = taskNodeRef(task);
    if (target.type !== 'subtask' || this.tasks_abyssPrivate === undefined) return;
    await this.executeHierarchyCommand_abyssPrivate({
      type: 'promote-subtask',
      subtask: target.ref,
    });
  }

  /** A submitted draft as recovery restores it: without its focus once a control holds focus. */
  private recoverableDraft_abyssPrivate(draft: RightPanelDraftState): RightPanelDraftState {
    return this.planningSurfaces_abyssPrivate.focusIsNeutral() ? draft : unfocusedDraft(draft);
  }

  private renderTaskStatusMarker_abyssPrivate(parent: HTMLElement, task: TaskLike): void {
    const owner = this.taskOwner_abyssPrivate(task);
    const marker = renderStatusMarker(parent, {
      task,
      registry: this.statusRegistry_abyssPrivate,
      completionBlocked: this.isDependencyBlocked_abyssPrivate(task),
      onLeftClick: () => {
        const current = owner.current;
        if (current === undefined) return;
        runAsyncAction(
          'source' in current
            ? this.toggleTaskLike_abyssPrivate(current)
            : this.toggleSubTask_abyssPrivate(current),
        );
      },
      onContextMenu: (event) => {
        const current = owner.current;
        if (current !== undefined)
          this.planningSurfaces_abyssPrivate.openStatusMenu(event, current);
      },
    });
    this.planningSurfaces_abyssPrivate.registerStatusMarker(marker, task);
  }

  private isDependencyBlocked_abyssPrivate(task: TaskLike): boolean {
    return dependencyCompletionBlocked(
      this.tasks_abyssPrivate?.queries.dependencies(taskNodeRef(task)),
    );
  }

  private refreshTaskMetadata_abyssPrivate(task: TaskLike): void {
    const fields = (node: TaskLike | undefined): unknown =>
      node === undefined ? undefined : [node.planning, node.priority, node.tags, node.recurrence];
    if (JSON.stringify(fields(this.metadataTask_abyssPrivate)) === JSON.stringify(fields(task)))
      return;
    const previous = this.metadataTask_abyssPrivate;
    if (
      previous !== undefined &&
      this.planningSurfaces_abyssPrivate.hasFocusedTypedInputFor(taskNodeRef(previous))
    ) {
      this.pendingPlanningRender_abyssPrivate = true;
      this.pendingPlanningMetadata_abyssPrivate = true;
      return;
    }
    const old = this.el_abyssPrivate.querySelector('.abyss-chips-row');
    this.planningSurfaces_abyssPrivate.resetMetadataControls();
    this.renderTaskMetadata_abyssPrivate(task);
    const next = this.el_abyssPrivate.querySelector('.abyss-chips-row:last-child');
    if (next !== null && old !== null) old.replaceWith(next);
  }

  private renderTaskMetadata_abyssPrivate(task: TaskLike): void {
    const owner = this.taskOwner_abyssPrivate(task);
    this.metadataTask_abyssPrivate = task;
    const chips = this.el_abyssPrivate.createDiv({ cls: 'abyss-chips-row' });
    this.planningSurfaces_abyssPrivate.renderDateChip(chips, task);
    this.planningSurfaces_abyssPrivate.renderTimeChip(chips, task);
    if (this.tasks_abyssPrivate !== undefined) {
      // Tracked time reads with the chips that plan the task, so it leads the dependency badge.
      // Both are placed by the order of these calls, which is the order they keep in the row.
      this.timeBadge_abyssPrivate?.render(chips);
      this.planningSurfaces_abyssPrivate.registerTrackingControls();
      chips.createSpan({ cls: 'abyss-chip abyss-dep-badge' });
      this.dependencies_abyssPrivate.updateBadge();
    }
    this.planningSurfaces_abyssPrivate.renderPriorityChip(chips, task);
    this.planningSurfaces_abyssPrivate.renderRecurrenceChip(chips, task);
    if (task.planning.scheduled != null)
      this.planningSurfaces_abyssPrivate.renderScheduledChip(chips, task);
    if (task.planning.start != null)
      this.planningSurfaces_abyssPrivate.renderStartChip(chips, task);
    this.planningSurfaces_abyssPrivate.renderAddDateMenu(chips, task);
    for (const tag of task.tags) this.planningSurfaces_abyssPrivate.renderTagChip(chips, task, tag);
    const addTagBtn = chips.createEl('button', {
      cls: 'abyss-chip abyss-chip-add',
      text: '+ tag',
      attr: {
        'aria-label': 'Add tag',
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
      },
    });
    this.planningSurfaces_abyssPrivate.registerPlanningControl('add-tag', addTagBtn);
    addTagBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const current = owner.current;
      if (current !== undefined)
        this.planningSurfaces_abyssPrivate.showTagInput(chips, current, addTagBtn);
    });
  }

  private dependencyTask_abyssPrivate(
    stack: readonly TaskLike[] = this.state_abyssPrivate.get('taskStack'),
  ): TaskLike | undefined {
    const root = stack[0];
    if (root === undefined) return undefined;
    const resolution = this.tasks_abyssPrivate?.queries.resolve(rootTaskRef(root));
    let currentStack = stack;
    if (resolution?.type === 'exact') currentStack = rebuildTaskSelection(resolution.task, stack);
    if (resolution?.type === 'rebased')
      currentStack = rebuildTaskSelection(resolution.current, stack, {
        preserveDependencyChanges: resolution.evidence === 'authority-transition',
      });
    return currentStack.length === stack.length ? currentStack[currentStack.length - 1] : undefined;
  }

  private async createDependencySubtask_abyssPrivate(
    text: string,
    direction: DependencyDirection,
  ): Promise<DependencyPickerCommitResult> {
    const current = this.dependencyTask_abyssPrivate();
    if (current === undefined || this.tasks_abyssPrivate === undefined)
      return { type: 'validation-error', message: 'The current task is no longer available.' };
    const command: CreateDependencySubtaskCommand = {
      type: 'create-dependency-subtask',
      current: taskNodeRef(current),
      direction,
      text,
    };
    const submission = this.beginDraftSubmission_abyssPrivate(command.current, undefined, command);
    if (submission === undefined) {
      presentTaskCommandResult(PENDING_TASK_EDIT_RESULT);
      return { type: 'failed' };
    }
    let result: TaskCommandResult;
    try {
      result = await this.tasks_abyssPrivate.execute(command);
    } catch {
      console.error('[abyss-tasks] Dependency action failed', {
        operation: command.type,
        cause: 'repository-error',
      });
      result = { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
    }
    this.applyCreatedDependency_abyssPrivate(result, command.current, submission);
    this.settleDraftSubmission_abyssPrivate(submission, result);
    if (result.type === 'invalid')
      return {
        type: 'validation-error',
        message: 'The new task is invalid. Check its text and omit dependency IDs.',
      };
    presentTaskCommandResult(result);
    return { type: result.type === 'ok' ? 'committed' : 'failed' };
  }

  private applyCreatedDependency_abyssPrivate(
    result: TaskCommandResult,
    current: TaskNodeRef,
    submission: object,
  ): void {
    if (result.type !== 'ok' || result.outcome.type !== 'dependency-subtask') return;
    const root = result.outcome.current.root;
    const ref = rootRefForPlanningTarget(current);
    const selection = this.selectionForOwnedTransition(
      ref,
      root,
      this.state_abyssPrivate.get('taskStack'),
    );
    if (selection !== undefined) {
      const draft = this.captureDraftStateForOwnedTransition(ref, root.ref, submission);
      this.state_abyssPrivate.updateInspectorSelection(selection);
      this.restoreDraftState(draft, root);
    }
    if (result.changed) this.onSuccessfulMutation_abyssPrivate?.(root.ref);
  }

  private async executeDependencyCommand_abyssPrivate(
    command: Extract<
      TaskCommand,
      { type: 'add-dependency' | 'remove-dependency' | 'reverse-dependency' }
    >,
    position?: InlineUndoPosition,
  ): Promise<boolean> {
    if (this.tasks_abyssPrivate === undefined) return false;
    const epoch = this.selectionEpoch_abyssPrivate;
    let result: TaskCommandResult;
    try {
      result = await this.tasks_abyssPrivate.execute(command);
    } catch (error) {
      console.error('[abyss-tasks] Dependency action failed', error);
      result = { type: 'io-error', cause: 'dependency-error', contentState: 'unknown' };
    }
    presentTaskCommandResult(result);
    if (epoch === this.selectionEpoch_abyssPrivate)
      this.presentRemovalUndo_abyssPrivate(result, position);
    return result.type === 'ok';
  }

  private dismissEntrySubmission_abyssPrivate(
    kind: 'new-subtask' | 'new-comment',
    target: TaskNodeRef,
  ): void {
    for (const submitted of this.submittedDrafts_abyssPrivate.values()) {
      const draft = submitted.draft;
      if (draft?.kind !== kind) continue;
      const successor = this.successorDraftParent_abyssPrivate(draft.parent, submitted);
      if (
        sameTaskNodeRef(draft.parent, target) ||
        (successor !== undefined && sameTaskNodeRef(successor, target))
      )
        submitted.dismissed = true;
    }
  }

  private finishTaskDrag_abyssPrivate(): void {
    this.endTaskDrag_abyssPrivate?.();
  }

  private setTaskDragCleanup_abyssPrivate(cleanup: () => void): void {
    this.endTaskDrag_abyssPrivate = cleanup;
  }

  // ---- Write-back helpers ----

  /** @internal Retained as the title-edit command seam used by focused integration tests. */
  async updateTaskTitle(task: TaskLike, newText: string): Promise<void> {
    await this.saveTaskTitle_abyssPrivate(task, newText);
  }

  private async saveTaskTitle_abyssPrivate(task: TaskLike, newText: string): Promise<boolean> {
    const target = taskNodeRef(task);
    const result = await this.executeOwnedCommand_abyssPrivate(
      {
        type: 'patch',
        target,
        patch: { markdownTitle: { type: 'set', value: newText } },
      } as TaskCommand,
      target,
      (draft) => draft.kind === 'title' && sameTaskNodeRef(draft.target.target, target),
    );
    return result?.type === 'ok';
  }

  private async appendToTitle_abyssPrivate(task: TaskLike, text: string): Promise<void> {
    const target = taskNodeRef(task);
    if (this.tasks_abyssPrivate == null) return;
    const result = await this.tasks_abyssPrivate.execute({
      type: 'append-title',
      target,
      markdown: text,
    });
    this.applyPlanningResult_abyssPrivate(result, target);
  }

  private updateDescription_abyssPrivate(task: TaskLike, newDesc: string): Promise<boolean> {
    const target = taskNodeRef(task);
    return this.executeBlockCommand_abyssPrivate(
      {
        type: 'set-description',
        target,
        text: newDesc.trim().length > 0 ? newDesc.replace(/\r\n/gu, '\n') : null,
      },
      target,
    );
  }

  private addSubTask_abyssPrivate(task: TaskLike, text: string): Promise<boolean> {
    const parent = taskNodeRef(task);
    return this.executeBlockCommand_abyssPrivate({ type: 'add-subtask', parent, text }, parent);
  }

  private toggleSubTask_abyssPrivate(sub: SubtaskSnapshot): Promise<void> {
    return this.toggleTaskLike_abyssPrivate(sub);
  }

  private toggleTaskLike_abyssPrivate(task: TaskLike): Promise<void> {
    return requestTaskStatusChange(
      task,
      undefined,
      this.statusRegistry_abyssPrivate,
      () => this.commitTaskToggle_abyssPrivate(task),
      this.interactionOwnership_abyssPrivate,
      this.completionConfirmationAbortController_abyssPrivate.signal,
    );
  }

  private commitTaskToggle_abyssPrivate(task: TaskLike): Promise<void> {
    const target = taskNodeRef(task);
    return this.executeOwnedStatus_abyssPrivate({ type: 'toggle-completion', target });
  }

  private async addComment_abyssPrivate(
    task: TaskLike,
    text: string,
    _commentList: HTMLElement,
    _inputEl: HTMLTextAreaElement,
  ): Promise<boolean> {
    const parent = taskNodeRef(task);
    const committed = await this.executeBlockCommand_abyssPrivate(
      { type: 'add-comment', parent, text },
      parent,
    );
    return committed;
  }

  private updateComment_abyssPrivate(
    _task: TaskLike,
    comment: TaskCommentSnapshot,
    newText: string,
  ): Promise<boolean> {
    const ref = commentRefOf(comment);
    return this.executeBlockCommand_abyssPrivate(
      { type: 'update-comment', comment: ref, text: newText },
      ref.parent,
    );
  }

  private deleteComment_abyssPrivate(
    _task: TaskLike,
    comment: TaskCommentSnapshot,
  ): Promise<boolean> {
    const ref = commentRefOf(comment);
    return this.executeBlockCommand_abyssPrivate(
      { type: 'delete-comment', comment: ref },
      ref.parent,
    );
  }

  private async executeBlockCommand_abyssPrivate(
    command: Extract<
      TaskCommand,
      {
        readonly type:
          | 'set-description'
          | 'add-subtask'
          | 'delete-subtask'
          | 'reorder-subtask'
          | 'add-comment'
          | 'update-comment'
          | 'delete-comment';
      }
    >,
    target: PlanningTarget,
  ): Promise<boolean> {
    const result = await this.executeOwnedCommand_abyssPrivate(
      command,
      target,
      (draft) => this.matchesBlockCommandDraft_abyssPrivate(draft, command),
      this.state_abyssPrivate.get('taskStack'),
    );
    return result?.type === 'ok';
  }

  private async executeOwnedCommand_abyssPrivate(
    command: TaskCommand,
    target: PlanningTarget,
    matchesDraft?: (draft: RightPanelDraftState) => boolean,
    initiatingStack?: readonly TaskLike[],
  ): Promise<TaskCommandResult | undefined> {
    if (this.tasks_abyssPrivate === undefined) return undefined;
    const submission = this.beginDraftSubmission_abyssPrivate(target, matchesDraft, command);
    if (submission === undefined) {
      presentTaskCommandResult(PENDING_TASK_EDIT_RESULT);
      return undefined;
    }
    const owner = this.submittedDrafts_abyssPrivate.get(submission);
    const result = await executeTaskCommand(this.tasks_abyssPrivate, command);
    this.applyPlanningResult_abyssPrivate(result, target, initiatingStack, submission);
    if (
      command.type === 'delete-subtask' &&
      initiatingStack !== undefined &&
      owner?.epoch === this.selectionEpoch_abyssPrivate
    )
      this.presentRemovalUndo_abyssPrivate(
        result,
        subtaskUndoPosition(initiatingStack, command.subtask),
      );
    return result;
  }

  private presentRemovalUndo_abyssPrivate(
    result: TaskCommandResult,
    position: InlineUndoPosition | undefined,
  ): void {
    const tasks = this.tasks_abyssPrivate;
    const command = taskRemovalInverse(result);
    const current = this.dependencyTask_abyssPrivate();
    if (
      tasks === undefined ||
      command === undefined ||
      position === undefined ||
      !this.mounted_abyssPrivate ||
      current === undefined ||
      (command.type === 'restore-subtask' && !sameTaskNodeRef(command.parent, taskNodeRef(current)))
    )
      return;
    this.undo_abyssPrivate.show(
      this.el_abyssPrivate,
      position,
      async () => {
        if (command.type !== 'restore-subtask') return tasks.execute(command);
        const initiatingStack = this.state_abyssPrivate.get('taskStack');
        const submission = this.beginDraftSubmission_abyssPrivate(
          command.parent,
          undefined,
          command,
        );
        if (submission === undefined) return PENDING_TASK_EDIT_RESULT;
        const restored = await executeTaskCommand(tasks, command);
        if (restored.type === 'ok')
          this.applyPlanningResult_abyssPrivate(
            restored,
            command.parent,
            initiatingStack,
            submission,
          );
        else this.settleDraftSubmission_abyssPrivate(submission, restored);
        return restored;
      },
      command.type === 'restore-dependency'
        ? {
            validate: () => {
              const matches = tasks.queries
                .listNodes()
                .filter(({ target }) => sameTaskNodeAddress(target, command.dependent));
              const node = matches.length === 1 ? matches[0]?.node : undefined;
              if (node === undefined) return false;
              const source =
                'source' in node
                  ? node.source.originalMarkdown
                  : node.ref.originalBlock.split(/\r?\n/u, 1)[0];
              return command.recovery.source === undefined
                ? JSON.stringify(node.dependsOn) === JSON.stringify(command.recovery.afterIds)
                : source === command.recovery.source.after;
            },
          }
        : undefined,
    );
  }

  private async updateDate_abyssPrivate(
    task: TaskLike,
    field: SchedulingDateField,
    date: LocalDate,
  ): Promise<void> {
    await this.executePlanningPatch_abyssPrivate(task, { [field]: { type: 'set', value: date } });
  }

  private async clearDate_abyssPrivate(task: TaskLike): Promise<void> {
    await this.executePlanningPatch_abyssPrivate(
      task,
      task.planning.due != null || task.planning.scheduled == null
        ? { due: { type: 'clear' } }
        : { scheduled: { type: 'clear' } },
    );
  }

  private async clearPlanningDate_abyssPrivate(task: TaskLike, field: AddDateField): Promise<void> {
    await this.executePlanningPatch_abyssPrivate(task, { [field]: { type: 'clear' } });
  }

  private async executePlanningPatch_abyssPrivate(
    task: TaskLike,
    patch: TaskPatch,
  ): Promise<TaskCommandResult> {
    const target = taskNodeRef(task);
    if (this.tasks_abyssPrivate == null) {
      return { type: 'io-error', cause: 'application-unavailable', contentState: 'unchanged' };
    }
    const command = { type: 'patch', target, patch } as TaskCommand;
    const submission = this.beginDraftSubmission_abyssPrivate(
      target,
      (draft) => {
        if (patch.recurrence === undefined && patch.onCompletion === undefined) return false;
        return draft.kind === 'recurrence-editor' && sameTaskNodeRef(draft.target, target);
      },
      command,
    );
    if (submission == null) {
      presentTaskCommandResult(PENDING_TASK_EDIT_RESULT);
      return PENDING_TASK_EDIT_RESULT;
    }
    let result: TaskCommandResult;
    try {
      if (target.type === 'task') result = await this.tasks_abyssPrivate.execute(command);
      else
        result =
          patch.duration !== undefined
            ? { type: 'io-error', cause: 'unsupported-field', contentState: 'unchanged' }
            : await this.tasks_abyssPrivate.execute(command);
    } catch {
      result = { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
    }
    this.applyPlanningResult_abyssPrivate(result, target, undefined, submission);
    return result;
  }

  private applyPlanningResult_abyssPrivate(
    result: TaskCommandResult,
    target: PlanningTarget,
    initiatingStack?: readonly TaskLike[],
    submission?: object,
  ): void {
    presentTaskCommandResult(result);
    if (result.type === 'ok' && result.outcome.type === 'task') {
      const stack = this.state_abyssPrivate.get('taskStack');
      const initiatingRoot = rootRefForPlanningTarget(target);
      if (this.isSelectedPlanningResult_abyssPrivate(stack, initiatingStack, initiatingRoot)) {
        this.applySelectedPlanningResult_abyssPrivate(
          result.outcome.task,
          target,
          stack,
          planningResultSubmission(submission, result.changed),
        );
      }
      if (result.changed) this.onSuccessfulMutation_abyssPrivate?.(result.outcome.task.ref);
    }
    if (submission !== undefined) this.settleDraftSubmission_abyssPrivate(submission, result);
  }

  private applySelectedPlanningResult_abyssPrivate(
    root: TaskSnapshot,
    target: PlanningTarget,
    stack: readonly TaskLike[],
    submission: PlanningResultSubmission | undefined,
  ): void {
    const owned = submission?.changed === true ? submission.token : undefined;
    const ownedSelection =
      owned === undefined
        ? undefined
        : this.selectionForOwnedTransition(rootRefForPlanningTarget(target), root, stack);
    const draft = this.resultDraftState_abyssPrivate(root, target, submission);
    this.state_abyssPrivate.updateInspectorSelection(
      ownedSelection ?? this.resultSelection_abyssPrivate(root, target, stack, owned),
    );
    this.restoreDraftState(draft, root);
  }

  private resultDraftState_abyssPrivate(
    root: TaskSnapshot,
    target: PlanningTarget,
    submission: PlanningResultSubmission | undefined,
  ): RightPanelDraftBundle | undefined {
    if (submission === undefined) return this.captureDraftState();
    if (!submission.changed)
      return this.captureDraftStateWithoutSubmittedEditor_abyssPrivate(submission.token);
    return this.captureDraftStateForOwnedTransition(
      rootRefForPlanningTarget(target),
      root.ref,
      submission.token,
    );
  }

  /** A save that changed nothing still consumes the editor draft it submitted, so it closes. */
  private captureDraftStateWithoutSubmittedEditor_abyssPrivate(
    token: object,
  ): RightPanelDraftBundle | undefined {
    const bundle = this.captureDraftState();
    const submitted = this.submittedDrafts_abyssPrivate.get(token)?.draft;
    if (bundle === undefined || submitted === undefined || isEntryDraft(submitted)) return bundle;
    const entries = bundle.entries.filter(
      (candidate) => !this.sameDraftPayload_abyssPrivate(candidate, submitted),
    );
    return entries.length > 0 ? { ...bundle, entries } : undefined;
  }

  private resultSelection_abyssPrivate(
    root: TaskSnapshot,
    target: PlanningTarget,
    stack: readonly TaskLike[],
    submission: object | undefined,
  ): TaskLike[] {
    const command =
      submission === undefined
        ? undefined
        : this.submittedDrafts_abyssPrivate.get(submission)?.command;
    if (command?.type === 'add-subtask' || command?.type === 'add-comment')
      return rebuildTaskSelection(root, stack);
    return target.type === 'subtask'
      ? rebuildPlanningTargetStack(root, target)
      : rebuildTaskSelection(root, stack);
  }

  private isSelectedPlanningResult_abyssPrivate(
    stack: readonly TaskLike[],
    initiatingStack: readonly TaskLike[] | undefined,
    initiatingRoot: TaskRef,
  ): boolean {
    const selected = stack[0];
    if (selected == null || !sameTaskRef(rootTaskRef(selected), initiatingRoot)) return false;
    return initiatingStack === undefined || stack === initiatingStack;
  }

  private async updateDuration_abyssPrivate(task: TaskSnapshot, minutes: number): Promise<void> {
    try {
      await this.executePlanningPatch_abyssPrivate(task, {
        duration: { type: 'set', value: durationMinutes(minutes) },
      });
    } catch {
      // Invalid input leaves the existing duration unchanged.
    }
  }

  private async clearDuration_abyssPrivate(task: TaskSnapshot): Promise<void> {
    await this.executePlanningPatch_abyssPrivate(task, { duration: { type: 'clear' } });
  }

  private setStatus_abyssPrivate(task: TaskLike, symbol: string): Promise<void> {
    return requestTaskStatusChange(
      task,
      symbol,
      this.statusRegistry_abyssPrivate,
      () => this.commitStatus_abyssPrivate(task, symbol),
      this.interactionOwnership_abyssPrivate,
      this.completionConfirmationAbortController_abyssPrivate.signal,
    );
  }

  private commitStatus_abyssPrivate(task: TaskLike, symbol: string): Promise<void> {
    const target = taskNodeRef(task);
    return this.executeOwnedStatus_abyssPrivate({ type: 'set-status', target, symbol });
  }

  private async executeOwnedStatus_abyssPrivate(
    command: Extract<TaskCommand, { type: 'set-status' | 'toggle-completion' }>,
  ): Promise<void> {
    await this.executeOwnedCommand_abyssPrivate(command, command.target);
  }

  private updatePriority_abyssPrivate(
    task: TaskLike,
    priority: TaskPriority,
  ): Promise<TaskCommandResult> {
    const patch: SubtaskPatch = { priority: { type: 'set', value: priority } };
    return this.executePlanningPatch_abyssPrivate(task, patch);
  }

  private async removeTag_abyssPrivate(task: TaskLike, tag: string): Promise<void> {
    await this.executePlanningPatch_abyssPrivate(task, { tags: { remove: [tag] } });
  }

  private async addTags_abyssPrivate(
    task: TaskLike,
    tags: readonly string[],
  ): Promise<'committed' | 'failed'> {
    const result = await this.executePlanningPatch_abyssPrivate(task, { tags: { add: tags } });
    return result.type === 'ok' ? 'committed' : 'failed';
  }

  private async updateTime_abyssPrivate(task: TaskLike, time: string): Promise<void> {
    try {
      await this.executePlanningPatch_abyssPrivate(task, {
        time: time === '' ? { type: 'clear' } : { type: 'set', value: localTime(time) },
      });
    } catch {
      // Invalid input leaves the existing time unchanged.
    }
  }

  private async deleteTask_abyssPrivate(task: TaskLike): Promise<void> {
    const target = taskNodeRef(task);
    if (target.type === 'subtask') {
      await this.executeBlockCommand_abyssPrivate(
        { type: 'delete-subtask', subtask: target.ref },
        target.ref.parent,
      );
      return;
    }
    await this.deleteRootTask_abyssPrivate(target.ref);
  }

  private async deleteRootTask_abyssPrivate(ref: TaskRef): Promise<void> {
    const tasks = this.tasks_abyssPrivate;
    if (tasks == null) return;
    const initiatingStack = this.state_abyssPrivate.get('taskStack');
    const result = await whileRemovingRoot(this.state_abyssPrivate, ref, () =>
      executeTaskCommand(tasks, { type: 'delete', ref }),
    );
    presentTaskCommandResult(result);
    const selectedRoot = this.state_abyssPrivate.get('taskStack')[0];
    const selectedRef = selectedRoot != null ? rootTaskRef(selectedRoot) : undefined;
    if (
      result.type === 'ok' &&
      result.outcome.type === 'deleted' &&
      this.state_abyssPrivate.get('taskStack') === initiatingStack &&
      selectedRef != null &&
      sameTaskRef(selectedRef, ref)
    ) {
      this.state_abyssPrivate.set('taskStack', []);
    }
  }

  private async archiveRootTask_abyssPrivate(ref: TaskRef): Promise<void> {
    const tasks = this.tasks_abyssPrivate;
    if (tasks == null) return;
    const initiatingStack = this.state_abyssPrivate.get('taskStack');
    const result = await whileRemovingRoot(this.state_abyssPrivate, ref, async () => {
      const session = await tasks.planArchive?.();
      return session?.type === 'ready'
        ? session.execute(ref)
        : executeTaskCommand(tasks, { type: 'archive', ref });
    });
    presentTaskArchiveResult(this.app_abyssPrivate, tasks, result);
    this.clearArchivedInspector_abyssPrivate(ref, result, initiatingStack);
  }

  private clearArchivedInspector_abyssPrivate(
    ref: TaskRef,
    result: TaskCommandResult,
    initiatingStack: readonly TaskLike[],
  ): void {
    if (result.type !== 'ok' || result.outcome.type !== 'archived') return;
    if (this.state_abyssPrivate.get('taskStack') !== initiatingStack) return;
    const selectedRoot = this.state_abyssPrivate.get('taskStack')[0];
    const selectedRef = selectedRoot != null ? rootTaskRef(selectedRoot) : undefined;
    if (selectedRef != null && sameTaskRef(selectedRef, ref)) {
      this.state_abyssPrivate.set('taskStack', []);
    }
  }

  private async reorderSubTask_abyssPrivate(
    parentTask: TaskLike,
    moved: SubtaskSnapshot,
    target: SubtaskSnapshot,
    position: 'before' | 'after',
  ): Promise<void> {
    const parent = taskNodeRef(parentTask);
    const movedTarget = taskNodeRef(moved);
    const targetNode = taskNodeRef(target);
    if (movedTarget.type !== 'subtask' || targetNode.type !== 'subtask') return;
    await this.executeBlockCommand_abyssPrivate(
      {
        type: 'reorder-subtask',
        subtask: movedTarget.ref,
        target: targetNode.ref,
        placement: position,
      },
      parent,
    );
  }

  private formatDate_abyssPrivate(d: string): string {
    const today = window.moment().format('YYYY-MM-DD');
    const tomorrow = window.moment().add(1, 'day').format('YYYY-MM-DD');
    if (d === today) return 'Today';
    if (d === tomorrow) return 'Tomorrow';
    return window.moment(d, 'YYYY-MM-DD').format('D MMM');
  }
}
