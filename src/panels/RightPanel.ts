import type { App } from 'obsidian';
import { Component, Notice, setIcon } from 'obsidian';
import type { AppState, InspectorHistoryFrame, TaskNodeDragPayload } from '../app/AppState';
import type { LinkToken } from '../markdown/links';
import { formatDurationFromMinutes, parseDurationToMinutes } from '../parser/TaskParser';

import type { CalendarSettings } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import { colorForTag } from '../tags/tagColor';
import {
  cloneTaskSnapshot,
  durationMinutes,
  formatCommentTimeLabel,
  localDate,
  localTime,
  sameTaskNodeRef,
  type CommentRef,
  type CommentTimeContext,
  type CommentTimeContextProvider,
  type CreateDependencySubtaskCommand,
  type DependencyDirection,
  type PlanningTarget,
  type SubtaskPatch,
  type SubtaskRef,
  type SubtaskSnapshot,
  type TaskApplicationApi,
  type TaskCommand,
  type TaskCommandResult,
  type TaskCommentSnapshot,
  type TaskDependencyProjection,
  type TaskDependencyRelation,
  type TaskNodeRef,
  type TaskPatch,
  type TaskPriority,
  type TaskRef,
  type TaskSnapshot,
  type TaskTextTarget,
} from '../tasks';
import { anchoredPlacement, type AnchoredPlacementInput } from '../ui/anchoredPlacement';
import {
  enableAttachmentDrop,
  enableAttachmentPaste,
  insertAtCaret,
  whenPasteSettled,
} from '../ui/attachmentDrop';
import {
  dependencySearchOptions,
  focusWithoutScroll,
  mountDependencySearch,
  type DependencyPickerCommitResult,
  type DependencySearchHandle,
} from '../ui/dependencySearch';
import { createInlineTaskUndo, type InlineUndoPosition } from '../ui/inlineTaskUndo';
import { noInteractionOwnership, type InteractionOwnershipPort } from '../ui/interactionOwnership';
import { LinkEditModal } from '../ui/LinkEditModal';
import { rebuildOwnedTaskSelection } from '../ui/ownedTaskSelection';
import {
  mountRecurrenceEditor,
  type RecurrenceEditorHandle,
} from '../ui/recurrence/RecurrenceEditor';
import {
  recurrenceBadgeInput,
  renderRecurrenceBadge,
} from '../ui/recurrence/renderRecurrenceBadge';
import { renderTaskText } from '../ui/renderTaskText';
import { runAsyncAction } from '../ui/runAsyncAction';
import { renderStatusMarker, setStatusMarkerCompletionBlocked } from '../ui/StatusMarker';
import { showStatusMenuAt } from '../ui/statusMenu';
import { showTagDropdown } from '../ui/tagDropdown';
import { presentTaskCommandResult, requestTaskCompletion } from '../ui/taskCommandResult';
import {
  dependencyCompletionBlocked,
  dependencyCountPresentation,
  dependencyDirectionLabel,
  dependencyRelationPresentation,
} from '../ui/taskDependencyPresentation';
import {
  createRightPanelDraftRebaseContext,
  draftIdentity,
  draftPlainText,
  isDirtyDraft,
  rebaseRightPanelDraft,
  type RightPanelDraftBundle,
  type RightPanelDraftState,
} from '../ui/taskDraftContinuity';
import { openInFile } from '../ui/taskNavigation';
import { startTaskNodeDrag } from '../ui/taskNodeDrag';
import { rebuildTaskSelection, rootTaskRef, taskNodeLine, taskNodeRef } from '../ui/taskSelection';
import { taskRemovalInverse } from '../ui/taskUndoNotice';

type TaskLike = TaskSnapshot | SubtaskSnapshot;

interface DependencyDisclosureState {
  readonly selectionKey: string;
  readonly latched: boolean;
}

type RightPanelDependencies = readonly [
  state: AppState,
  app: App,
  statusRegistry: StatusRegistry,
  settings?: CalendarSettings,
  onSuccessfulMutation?: (ref?: TaskRef) => void,
  tasks?: TaskApplicationApi,
  onRenderHeaderActions?: (actions: HTMLElement) => void,
  onMutationLifecycle?: (event: RightPanelMutationLifecycle) => void,
  commentTimeContext?: CommentTimeContextProvider,
  interactionOwnership?: InteractionOwnershipPort,
];

interface TextDraftSnapshot {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly hadFocus: boolean;
  readonly dirty: boolean;
}

class AsyncEditLifecycle {
  private phase_abyssPrivate: 'idle' | 'saving' | 'closed' = 'idle';

  begin(): boolean {
    if (this.phase_abyssPrivate !== 'idle') return false;
    this.phase_abyssPrivate = 'saving';
    return true;
  }

  retry(): void {
    if (this.phase_abyssPrivate === 'saving') this.phase_abyssPrivate = 'idle';
  }

  close(): void {
    this.phase_abyssPrivate = 'closed';
  }

  isClosed(): boolean {
    return this.phase_abyssPrivate === 'closed';
  }
}

export interface RightPanelMutationLifecycle {
  readonly phase: 'started' | 'settled';
  readonly ref: TaskRef;
  readonly token: object;
}

interface SubmittedDraft {
  readonly ref: TaskRef;
  readonly rootAliases: TaskRef[];
  readonly draft?: RightPanelDraftState;
  readonly origin: RightPanelDraftBundle['origin'];
  readonly command?: TaskCommand;
  readonly selection: readonly TaskLike[];
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

function timeChipPresentation(
  time: string | undefined,
  duration: number | undefined,
): { readonly text: string; readonly label: string } {
  if (time == null) return { text: '⏰ Time', label: 'Set time and duration' };
  if (duration == null) {
    return { text: `⏰ ${time}`, label: `Change time, currently ${time}, no duration` };
  }
  return {
    text: `⏰ ${time} · ${formatDurationFromMinutes(duration)}`,
    label: `Change time, currently ${time}, duration ${String(duration)} minutes`,
  };
}

function dimensionOrFallback(primary: number, secondary: number, fallback: number): number {
  return finiteNonzeroOr(primary, finiteNonzeroOr(secondary, fallback));
}

function finiteNonzeroOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value !== 0 ? value : fallback;
}

function visiblePickerBoundary(panel: DOMRect, overlay: DOMRect, window: Window | null): DOMRect {
  const left = Math.max(0, panel.left, overlay.left);
  const top = Math.max(0, panel.top, overlay.top);
  const right = Math.min(window?.innerWidth ?? Infinity, panel.right, overlay.right);
  const bottom = Math.min(window?.innerHeight ?? Infinity, panel.bottom, overlay.bottom);
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}

function setPopoverLength(popover: HTMLElement, property: string, value: number): void {
  popover.style.setProperty(`--abyss-pop-${property}`, `${value}px`);
}

function constrainDependencyPicker(
  popover: HTMLElement,
  input: Pick<AnchoredPlacementInput, 'anchor' | 'boundary' | 'gap' | 'edgeGap'>,
): DOMRect {
  const { anchor, gap, edgeGap } = input;
  const boundary = visiblePickerBoundary(
    input.boundary,
    popover.closest('.abyss-modal')?.getBoundingClientRect() ?? input.boundary,
    popover.ownerDocument.defaultView,
  );
  setPopoverLength(popover, 'width', Math.max(0, boundary.width - 2 * edgeGap));
  const chrome =
    popover.scrollHeight -
    (popover.querySelector<HTMLElement>('[role="listbox"]')?.offsetHeight ?? 0);
  setPopoverLength(
    popover,
    'height',
    Math.max(
      0,
      Math.min(
        boundary.height - 2 * edgeGap,
        Math.max(
          chrome,
          anchor.top - boundary.top - edgeGap - gap,
          boundary.bottom - edgeGap - anchor.bottom - gap,
        ),
      ),
    ),
  );
  return boundary;
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

export class RightPanel {
  private readonly undo_abyssPrivate = createInlineTaskUndo();
  private selectionEpoch_abyssPrivate = 0;
  private undoConvergence_abyssPrivate: SubmittedDraft | undefined;
  private readonly completionConfirmationAbortController_abyssPrivate = new AbortController();
  private el_abyssPrivate!: HTMLElement;
  private mounted_abyssPrivate = false;
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
  private off_abyssPrivate?: () => void;
  private offDependencyQueries_abyssPrivate: (() => void) | undefined;
  private dependencySearch_abyssPrivate: DependencySearchHandle | undefined;
  private dependencySearchAnchor_abyssPrivate = '.abyss-dep-badge-body';
  private dependencyDisclosure_abyssPrivate: DependencyDisclosureState | undefined;
  private draggingSub_abyssPrivate: SubtaskSnapshot | null = null;
  private endTaskDrag_abyssPrivate: (() => void) | undefined;
  private md_abyssPrivate = new Component();
  private readonly onSuccessfulMutation_abyssPrivate: ((ref?: TaskRef) => void) | undefined;
  private readonly submittedDrafts_abyssPrivate = new Map<object, SubmittedDraft>();
  private readonly anchoredSurfaceCleanups_abyssPrivate = new Map<HTMLElement, () => void>();
  private recurrenceDraftEditor_abyssPrivate:
    | {
        readonly target: TaskNodeRef;
        readonly handle: RecurrenceEditorHandle;
        readonly surface: HTMLElement;
      }
    | undefined;
  private detachedDrafts_abyssPrivate: Array<{
    readonly id: number;
    readonly key: string;
    readonly draft: RightPanelDraftState;
    readonly origin: RightPanelDraftBundle['origin'];
  }> = [];
  private nextDetachedDraftId_abyssPrivate = 0;
  private detachedAnnouncement_abyssPrivate = '';
  private detachedFocusTimer_abyssPrivate: number | undefined;

  constructor(...dependencies: RightPanelDependencies) {
    const [
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
    ] = dependencies;
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
  }

  mount(container: HTMLElement): void {
    this.el_abyssPrivate = container;
    this.mounted_abyssPrivate = true;
    this.updateDependencyDisclosureSelection_abyssPrivate(
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
      this.updateDependencyDisclosureSelection_abyssPrivate(next, sameSelection);
      const statusFocus = sameSelection ? this.statusFocusTarget_abyssPrivate(previous) : undefined;
      if (!sameSelection) {
        this.selectionEpoch_abyssPrivate++;
        if (this.undoConvergence_abyssPrivate?.command?.type !== 'restore-subtask')
          this.undo_abyssPrivate.clear();
        this.dependencySearch_abyssPrivate?.destroy();
        this.dependencySearch_abyssPrivate = undefined;
      }
      if (this.undoConvergence_abyssPrivate !== undefined) {
        this.undoConvergence_abyssPrivate.epoch = this.selectionEpoch_abyssPrivate;
        this.undoConvergence_abyssPrivate = undefined;
      }
      this.render_abyssPrivate(statusFocus);
    });
    const offHistory = this.state_abyssPrivate.onCommit((changed) => {
      if (
        changed.has('inspectorBackStack') &&
        !changed.has('taskStack') &&
        (this.el_abyssPrivate.querySelector('.abyss-inspector-back') !== null) !==
          this.state_abyssPrivate.get('inspectorBackStack').length > 0
      )
        this.render_abyssPrivate();
    });
    const offDrag = this.state_abyssPrivate.on('draggingTaskNode', (next, previous) => {
      if (next?.source === 'center-card' || previous?.source === 'center-card')
        this.refreshDependencies_abyssPrivate();
      else this.clearDependencyDropClasses_abyssPrivate();
    });
    this.off_abyssPrivate = () => {
      offSelection();
      offHistory();
      offDrag();
    };
    this.offDependencyQueries_abyssPrivate = this.tasks_abyssPrivate?.queries.subscribe(() => {
      this.refreshInspectorHistory_abyssPrivate();
      queueMicrotask(() => {
        if (this.mounted_abyssPrivate) this.refreshDependencies_abyssPrivate();
      });
    });
    this.render_abyssPrivate();
  }

  destroy(): void {
    this.undo_abyssPrivate.clear();
    this.undoConvergence_abyssPrivate = undefined;
    this.mounted_abyssPrivate = false;
    this.dependencyStatusMarkers_abyssPrivate.clear();
    this.endTaskDrag_abyssPrivate?.();
    this.completionConfirmationAbortController_abyssPrivate.abort();
    this.off_abyssPrivate?.();
    this.offDependencyQueries_abyssPrivate?.();
    this.dependencySearch_abyssPrivate?.destroy();
    this.dependencySearch_abyssPrivate = undefined;
    this.dependencyDisclosure_abyssPrivate = undefined;
    if (this.detachedFocusTimer_abyssPrivate !== undefined)
      window.clearTimeout(this.detachedFocusTimer_abyssPrivate);
    this.clearAnchoredSurfaces_abyssPrivate();
    this.el_abyssPrivate.empty();
    this.md_abyssPrivate.unload();
  }

  captureDraftState(): RightPanelDraftBundle | undefined {
    if (!this.mounted_abyssPrivate) return undefined;
    const stack = this.state_abyssPrivate.get('taskStack');
    const task = stack[stack.length - 1];
    const active = this.el_abyssPrivate.ownerDocument.activeElement;
    const candidates: RightPanelDraftState[] = [];
    const recurrence = this.captureRecurrenceDraft_abyssPrivate(active);
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

  private captureRecurrenceDraft_abyssPrivate(
    active: Element | null,
  ): RightPanelDraftState | undefined {
    const recurrence = this.recurrenceDraftEditor_abyssPrivate;
    if (recurrence == null) return undefined;
    const editor = recurrence.handle.captureDraftState();
    const hadFocus = active !== null && recurrence.surface.contains(active);
    if (!editor.dirty && !hadFocus) return undefined;
    return { kind: 'recurrence-editor', target: recurrence.target, editor, hadFocus };
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

  selectionForOwnedTransition(
    consumedRef: TaskRef | undefined,
    current: TaskSnapshot,
    stack: readonly TaskLike[],
  ): TaskLike[] | undefined {
    if (consumedRef === undefined) return undefined;
    const submitted = [...this.submittedDrafts_abyssPrivate.values()].find(
      (candidate) => !candidate.consumed && sameTaskRef(candidate.ref, consumedRef),
    );
    if (
      submitted?.command === undefined ||
      stack.length !== submitted.selection.length ||
      !stack.every((node, index) => {
        const previous = submitted.selection[index];
        return previous !== undefined && sameTaskNodeRef(taskNodeRef(node), taskNodeRef(previous));
      })
    )
      return undefined;
    return rebuildOwnedTaskSelection(current, submitted.selection, submitted.command);
  }

  captureDraftStateForOwnedTransition(
    consumedOwnedRef: TaskRef,
    successorRef: TaskRef,
    token?: object,
  ): RightPanelDraftBundle | undefined {
    const bundle = this.captureDraftState();
    const submitted =
      token != null
        ? this.submittedDrafts_abyssPrivate.get(token)
        : [...this.submittedDrafts_abyssPrivate.values()].find(
            (candidate) =>
              !candidate.consumed &&
              candidate.rootAliases.some((alias) => sameTaskRef(alias, consumedOwnedRef)),
          );
    if (
      submitted == null ||
      submitted.consumed ||
      !submitted.rootAliases.some((alias) => sameTaskRef(alias, consumedOwnedRef))
    ) {
      return bundle;
    }
    if (!submitted.rootAliases.some((alias) => sameTaskRef(alias, successorRef))) {
      submitted.rootAliases.push({ ...successorRef });
    }
    submitted.consumed = true;
    this.captureUndoConvergence_abyssPrivate(submitted);
    const submittedDraft = submitted.draft;
    if (submittedDraft == null || bundle == null) return bundle;
    const entries = bundle.entries.filter(
      (candidate) =>
        draftIdentity(candidate) !== draftIdentity(submittedDraft) ||
        !this.sameDraftPayload_abyssPrivate(candidate, submittedDraft),
    );
    return entries.length > 0 ? { ...bundle, entries } : undefined;
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
      consumed: false,
      epoch: this.selectionEpoch_abyssPrivate,
    });
    this.onMutationLifecycle_abyssPrivate?.({ phase: 'started', ref: { ...ref }, token });
    return token;
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
    if (command.type === 'update-comment') {
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

  private recoverSubmittedDraft_abyssPrivate(submitted: SubmittedDraft): void {
    const draft = submitted.draft;
    if (draft == null) return;
    const currentSameKey = this.captureDraftState()?.entries.find(
      (candidate) => draftIdentity(candidate) === draftIdentity(draft),
    );
    if (currentSameKey != null && !this.sameDraftPayload_abyssPrivate(currentSameKey, draft)) {
      this.appendDetachedDraft_abyssPrivate(draft, submitted.origin);
      return;
    }
    if (currentSameKey != null) return;
    const bundle: RightPanelDraftBundle = {
      entries: [draft],
      ...(submitted.origin !== undefined && { origin: submitted.origin }),
    };
    const root = this.state_abyssPrivate.get('taskStack')[0];
    if (root != null && 'source' in root) {
      this.restoreDraftState(bundle, root);
      return;
    }
    this.detachDraftState(bundle);
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
      this.el_abyssPrivate.ownerDocument.defaultView?.setTimeout(() => {
        if (focus.isConnected) focus.focus();
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

  private restoreRecurrenceDraft_abyssPrivate(
    draft: Extract<RightPanelDraftState, { readonly kind: 'recurrence-editor' }>,
    task: TaskLike,
    stack: readonly TaskLike[],
    origin?: RightPanelDraftBundle['origin'],
  ): HTMLElement | undefined {
    const chip = this.el_abyssPrivate.querySelector<HTMLElement>('.abyss-repeat-chip');
    if (chip == null) {
      this.preserveDirtyDraft_abyssPrivate(draft, origin);
      return undefined;
    }
    this.showRecurrencePopover_abyssPrivate(chip, task, stack, false);
    const editor = this.recurrenceDraftEditor_abyssPrivate;
    if (editor == null) return undefined;
    editor.handle.restoreDraftState(draft.editor);
    return draft.hadFocus
      ? (editor.surface.querySelector<HTMLElement>(':focus') ?? undefined)
      : undefined;
  }

  private restoreTextDraftElement_abyssPrivate(
    rebased: Exclude<RightPanelDraftState, { readonly kind: 'recurrence-editor' }>,
    task: TaskLike,
  ): HTMLInputElement | HTMLTextAreaElement | null {
    if (rebased.kind === 'title') {
      this.clickElement_abyssPrivate('.abyss-right-title-view');
      return this.el_abyssPrivate.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit');
    }
    if (rebased.kind === 'description') {
      this.clickElement_abyssPrivate('.abyss-right-desc-view');
      return this.el_abyssPrivate.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit');
    }
    if (rebased.kind === 'existing-comment') {
      return this.restoreCommentDraftElement_abyssPrivate(rebased, task);
    }
    if (rebased.kind === 'new-subtask') {
      this.clickElement_abyssPrivate('.abyss-subtask-add-row');
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
    text?.click();
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

  private render_abyssPrivate(statusFocus?: TaskNodeRef): void {
    this.undo_abyssPrivate.detach();
    this.dependencyStatusMarkers_abyssPrivate.clear();
    const search = this.dependencySearch_abyssPrivate;
    const focused = this.el_abyssPrivate.ownerDocument.activeElement as HTMLElement | null;
    const searchFocus = search?.element.contains(focused) === true ? focused : null;
    if (search !== undefined) {
      this.anchoredSurfaceCleanups_abyssPrivate.get(search.element)?.();
      search.element.remove();
    }
    this.md_abyssPrivate.unload();
    this.md_abyssPrivate = new Component();
    this.md_abyssPrivate.load();
    this.clearAnchoredSurfaces_abyssPrivate();
    this.el_abyssPrivate.empty();
    const stack = this.state_abyssPrivate.get('taskStack');
    const task = stack[stack.length - 1];
    if (task === undefined) {
      this.renderEmpty_abyssPrivate();
      this.renderDetachedDraftTray_abyssPrivate();
      return;
    }
    this.renderTask_abyssPrivate(task, stack, this.commentTimeContext_abyssPrivate?.());
    this.renderDetachedDraftTray_abyssPrivate();
    if (search !== undefined) {
      this.el_abyssPrivate.append(search.element);
      search.refresh();
      this.positionDependencySearch_abyssPrivate(search.element, searchFocus);
    }
    this.restoreStatusFocus_abyssPrivate(statusFocus);
  }

  /** Wire clipboard paste-to-attach onto an editable textarea, inserting links at the caret. */
  private enablePaste_abyssPrivate(el: HTMLTextAreaElement, task: TaskLike): void {
    enableAttachmentPaste(el, {
      app: this.app_abyssPrivate,
      sourcePath: rootTaskRef(task).filePath,
      onInsert: (links) => {
        insertAtCaret(el, links);
      },
    });
  }

  private editLink_abyssPrivate(task: TaskLike, occ: number, token: LinkToken): void {
    const target = taskNodeRef(task);
    new LinkEditModal(
      this.app_abyssPrivate,
      token,
      (newRaw) => {
        runAsyncAction(this.executeLinkEdit_abyssPrivate({ type: 'title', target }, occ, newRaw));
      },
      rootTaskRef(task).filePath,
      this.interactionOwnership_abyssPrivate,
    ).open();
  }

  /** Edit a target-scoped link through the same revision-confirming task API as title edits. */
  private editLinkInString_abyssPrivate(
    target: TaskTextTarget,
    occ: number,
    token: LinkToken,
    sourcePath: string,
  ): void {
    new LinkEditModal(
      this.app_abyssPrivate,
      token,
      (newRaw) => {
        runAsyncAction(this.executeLinkEdit_abyssPrivate(target, occ, newRaw));
      },
      sourcePath,
      this.interactionOwnership_abyssPrivate,
    ).open();
  }

  private async executeLinkEdit_abyssPrivate(
    target: TaskTextTarget,
    occurrence: number,
    replacement: string,
  ): Promise<void> {
    if (this.tasks_abyssPrivate == null) return;
    const result = await this.tasks_abyssPrivate.execute({
      type: 'edit-link',
      target,
      occurrence,
      replacement,
    });
    const node = target.type === 'comment' ? target.ref.parent : target.target;
    this.applyPlanningResult_abyssPrivate(result, node);
  }

  /** Description block: rendered markdown (clickable links) that becomes a textarea on click. */
  private renderDescriptionBlock_abyssPrivate(section: HTMLElement, task: TaskLike): void {
    const view = section.createDiv({ cls: 'abyss-right-desc abyss-right-desc-view' });
    enableAttachmentDrop(view, {
      app: this.app_abyssPrivate,
      sourcePath: rootTaskRef(task).filePath,
      onLinks: (links) => {
        // The closure carries the observed revision; a concurrent edit is surfaced as a
        // structured conflict instead of overwriting the changed block.
        const current = task.description ?? '';
        runAsyncAction(
          this.updateDescription_abyssPrivate(
            task,
            current.trim().length > 0 ? `${current} ${links}` : links,
          ),
        );
      },
    });
    const showView = (): void => {
      this.showDescription_abyssPrivate(view, task);
    };
    view.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a') != null) return; // let links navigate
      this.enterDescriptionEdit_abyssPrivate(section, view, task, showView);
    });
    showView();
  }

  private enterDescriptionEdit_abyssPrivate(
    section: HTMLElement,
    view: HTMLElement,
    task: TaskLike,
    showView: () => void,
  ): void {
    const start = view.offsetHeight;
    view.hide();
    const textarea = section.createEl('textarea', {
      cls: 'abyss-right-desc abyss-right-desc-edit',
    });
    view.insertAdjacentElement('afterend', textarea);
    textarea.value = task.description ?? '';
    this.enablePaste_abyssPrivate(textarea, task);
    textarea.setCssStyles({ height: `${Math.max(start, 60)}px` });
    window.setTimeout(() => {
      textarea.focus();
    }, 0);
    const lifecycle = new AsyncEditLifecycle();
    const finish = async (save: boolean): Promise<void> => {
      if (!lifecycle.begin()) return;
      await whenPasteSettled(textarea);
      const changed = textarea.value !== (task.description ?? '');
      if (save && changed && !(await this.updateDescription_abyssPrivate(task, textarea.value))) {
        lifecycle.retry();
        textarea.focus();
        return;
      }
      lifecycle.close();
      textarea.remove();
      view.show();
      showView();
    };
    textarea.addEventListener('blur', () => {
      runAsyncAction(finish(true));
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      runAsyncAction(finish(false));
    });
  }

  private showDescription_abyssPrivate(view: HTMLElement, task: TaskLike): void {
    const description = task.description ?? '';
    if (description.trim().length === 0) {
      view.empty();
      view.addClass('abyss-right-desc-empty');
      view.setText('Add a description…');
      return;
    }
    view.removeClass('abyss-right-desc-empty');
    renderTaskText(view, description, {
      app: this.app_abyssPrivate,
      sourcePath: rootTaskRef(task).filePath,
      component: this.md_abyssPrivate,
      onEditLink: (occurrence, token) => {
        const target = taskNodeRef(task);
        this.editLinkInString_abyssPrivate(
          { type: 'description', target },
          occurrence,
          token,
          rootTaskRef(task).filePath,
        );
      },
    });
  }

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
    this.renderBreadcrumb_abyssPrivate(stack);
    this.renderTaskHeader_abyssPrivate(task);
    this.renderTaskMetadata_abyssPrivate(task, stack);
    this.renderDescriptionSection_abyssPrivate(task);
    this.renderDependencySections_abyssPrivate();
    this.renderSubtaskSection_abyssPrivate(task);
    this.renderCommentSection_abyssPrivate(task, commentTimeContext);
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
          title: 'Back to previous task',
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
      const crumb = breadcrumb.createSpan({ cls: 'abyss-breadcrumb-item' });
      renderTaskText(crumb, item.markdownTitle, {
        app: this.app_abyssPrivate,
        sourcePath: rootTaskRef(item).filePath,
        component: this.md_abyssPrivate,
        onEditLink: (occurrence, token) => {
          this.editLink_abyssPrivate(item, occurrence, token);
        },
      });
      crumb.addEventListener('click', () => {
        this.state_abyssPrivate.updateInspectorSelection(stack.slice(0, index + 1));
      });
    }
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

  private refreshInspectorHistory_abyssPrivate(): void {
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
        : rebuildOwnedTaskSelection(current, frame.taskStack, submitted.command)) ??
      rebuildTaskSelection(current, frame.taskStack, {
        preserveDependencyChanges: authorityRef !== undefined,
      })
    );
  }

  private renderTaskHeader_abyssPrivate(task: TaskLike): void {
    const header = this.el_abyssPrivate.createDiv({ cls: 'abyss-right-header' });
    this.renderTaskStatusMarker_abyssPrivate(header, task);
    this.renderTitleBlock_abyssPrivate(header, task);
    const headerActions = header.createDiv({ cls: 'abyss-right-header-actions' });
    const menuBtn = headerActions.createEl('button', {
      cls: 'abyss-right-action-btn',
      text: '⋯',
      attr: {
        title: 'More actions',
        'aria-label': 'More actions',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
      },
    });
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.renderContextMenu_abyssPrivate(task, menuBtn);
    });
    this.onRenderHeaderActions_abyssPrivate?.(headerActions);
  }

  private readonly dependencyStatusMarkers_abyssPrivate = new Map<HTMLElement, TaskLike>();

  private statusFocusTarget_abyssPrivate(stack: readonly TaskLike[]): TaskNodeRef | undefined {
    const focused = this.el_abyssPrivate.ownerDocument.activeElement;
    if (focused === null) return undefined;
    for (const [marker, task] of this.dependencyStatusMarkers_abyssPrivate) {
      if (marker !== focused && marker.closest('.abyss-status-control') !== focused) continue;
      const current = this.dependencyTask_abyssPrivate(
        task === stack[stack.length - 1] ? stack : [...stack, task],
      );
      return current === undefined ? undefined : taskNodeRef(current);
    }
    return undefined;
  }

  private restoreStatusFocus_abyssPrivate(target: TaskNodeRef | undefined): void {
    if (target === undefined) return;
    for (const [marker, task] of this.dependencyStatusMarkers_abyssPrivate) {
      if (!sameTaskNodeRef(taskNodeRef(task), target)) continue;
      (marker.closest<HTMLElement>('.abyss-status-control') ?? marker).focus({
        preventScroll: true,
      });
      return;
    }
  }

  private renderTaskStatusMarker_abyssPrivate(parent: HTMLElement, task: TaskLike): void {
    const marker = renderStatusMarker(parent, {
      task,
      registry: this.statusRegistry_abyssPrivate,
      completionBlocked: this.isDependencyBlocked_abyssPrivate(task),
      onLeftClick: () => {
        runAsyncAction(
          'source' in task
            ? this.toggleTaskLike_abyssPrivate(task)
            : this.toggleSubTask_abyssPrivate(task),
        );
      },
      onContextMenu: (event) => {
        event.stopPropagation();
        this.openStatusMenu_abyssPrivate(event, task);
      },
    });
    this.dependencyStatusMarkers_abyssPrivate.set(marker, task);
  }

  private isDependencyBlocked_abyssPrivate(task: TaskLike): boolean {
    return dependencyCompletionBlocked(
      this.tasks_abyssPrivate?.queries.dependencies(taskNodeRef(task)),
    );
  }

  private renderTaskMetadata_abyssPrivate(task: TaskLike, stack: readonly TaskLike[]): void {
    const chips = this.el_abyssPrivate.createDiv({ cls: 'abyss-chips-row' });
    this.renderDateChip_abyssPrivate(chips, task);
    this.renderTimeChip_abyssPrivate(chips, task);
    this.renderPriorityChip_abyssPrivate(chips, task);
    this.renderRecurrenceChip_abyssPrivate(chips, task, stack);
    if (task.planning.scheduled != null) this.renderScheduledChip_abyssPrivate(chips, task);
    if (task.planning.start != null) this.renderStartChip_abyssPrivate(chips, task);
    this.renderAddDateMenu_abyssPrivate(chips, task);
    if (this.tasks_abyssPrivate !== undefined) {
      chips.createSpan({ cls: 'abyss-chip abyss-dep-badge' });
      this.updateDependencyBadge_abyssPrivate();
    }
    for (const tag of task.tags) this.renderTagChip_abyssPrivate(chips, task, tag);
    const addTagBtn = chips.createEl('button', {
      cls: 'abyss-chip abyss-chip-add',
      text: '+ tag',
      attr: {
        'aria-label': 'Add tag',
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
      },
    });
    addTagBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.showTagInput_abyssPrivate(chips, task, addTagBtn);
    });
  }

  private updateDependencyDisclosureSelection_abyssPrivate(
    stack: readonly TaskLike[],
    preserveLatch: boolean,
  ): void {
    const selected = stack[stack.length - 1];
    if (selected === undefined) {
      this.dependencyDisclosure_abyssPrivate = undefined;
      return;
    }
    this.dependencyDisclosure_abyssPrivate = {
      selectionKey: JSON.stringify(taskNodeRef(selected)),
      latched: preserveLatch && this.dependencyDisclosure_abyssPrivate?.latched === true,
    };
  }

  private latchDependencyDisclosure_abyssPrivate(): void {
    const disclosure = this.dependencyDisclosure_abyssPrivate;
    if (disclosure === undefined || disclosure.latched) return;
    this.dependencyDisclosure_abyssPrivate = { ...disclosure, latched: true };
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

  private dependencyProjection_abyssPrivate(): TaskDependencyProjection | undefined {
    const task = this.dependencyTask_abyssPrivate();
    return task === undefined
      ? undefined
      : this.tasks_abyssPrivate?.queries.dependencies(taskNodeRef(task));
  }

  private updateDependencyBadge_abyssPrivate(): void {
    const badge = this.el_abyssPrivate.querySelector<HTMLElement>('.abyss-dep-badge');
    const projection = this.dependencyProjection_abyssPrivate();
    if (badge === null || projection === undefined) return;
    const body =
      badge.querySelector<HTMLButtonElement>('.abyss-dep-badge-body') ??
      this.createDependencyBadgeBody_abyssPrivate(badge);
    const counts = dependencyCountPresentation(projection);
    body.setAttribute('aria-label', counts.ariaLabel);
    body.title = counts.title;
    body.setAttribute('aria-expanded', String(this.dependencySearch_abyssPrivate !== undefined));
    const lock = body.querySelector('.abyss-dep-lock');
    lock?.setAttribute('class', 'abyss-dep-lock');
    body.querySelector('.abyss-dep-count-blocked-by')?.setText(String(counts.blockedBy));
    body.querySelector('.abyss-dep-count-blocks')?.setText(String(counts.blocks));
    if (lock !== null) {
      if (counts.blockedBy > 0) lock.addClass('abyss-dep-count-blocked-by');
      else if (counts.blocks > 0) lock.addClass('abyss-dep-count-blocks');
    }
    this.updateDependencyBadgeAdd_abyssPrivate(badge, projection);
  }

  private createDependencyBadgeBody_abyssPrivate(badge: HTMLElement): HTMLButtonElement {
    const body = badge.createEl('button', {
      cls: 'abyss-dep-badge-body',
      attr: { type: 'button', 'aria-haspopup': 'dialog' },
    });
    setIcon(body.createSpan({ cls: 'abyss-dep-lock', attr: { 'aria-hidden': 'true' } }), 'lock');
    for (const name of ['count-blocked-by', 'divider', 'count-blocks'])
      body.createSpan({ cls: `abyss-dep-${name}`, attr: { 'aria-hidden': 'true' } });
    body.addEventListener('click', () => {
      this.showDependencySearch_abyssPrivate();
    });
    return body;
  }

  private updateDependencyBadgeAdd_abyssPrivate(
    badge: HTMLElement,
    projection: TaskDependencyProjection,
  ): void {
    const plus = badge.querySelector('.abyss-dep-badge-add');
    const sectionsExist =
      this.dependencySectionsDisclosed_abyssPrivate() ||
      projection.blockedBy.length > 0 ||
      projection.blocks.length > 0;
    if (sectionsExist) plus?.remove();
    else if (plus === null) {
      const add = badge.createEl('button', {
        cls: 'abyss-dep-badge-add',
        text: '+',
        attr: { type: 'button', 'aria-label': 'Add dependency sections', title: 'Add dependency' },
      });
      add.addEventListener('click', () => {
        this.dependencySearch_abyssPrivate?.close(false);
        this.latchDependencyDisclosure_abyssPrivate();
        this.refreshDependencies_abyssPrivate();
        this.el_abyssPrivate.querySelector<HTMLButtonElement>('.abyss-dep-add')?.focus();
      });
    }
  }

  private renderDependencySections_abyssPrivate(): void {
    const task = this.dependencyTask_abyssPrivate();
    const projection = this.dependencyProjection_abyssPrivate();
    if (task === undefined || projection === undefined) return;
    if (projection.blockedBy.length > 0 || projection.blocks.length > 0)
      this.latchDependencyDisclosure_abyssPrivate();
    for (const direction of ['blocked-by', 'blocks'] as const) {
      const relations = direction === 'blocked-by' ? projection.blockedBy : projection.blocks;
      if (relations.length === 0 && !this.dependencySectionsDisclosed_abyssPrivate()) continue;
      this.renderDependencySection_abyssPrivate(direction, relations, taskNodeRef(task));
    }
  }

  private dependencySectionsDisclosed_abyssPrivate(): boolean {
    return (
      this.dependencyDisclosure_abyssPrivate?.latched === true ||
      this.state_abyssPrivate.get('draggingTaskNode')?.source === 'center-card'
    );
  }

  private renderDependencySection_abyssPrivate(
    direction: DependencyDirection,
    relations: readonly TaskDependencyRelation[],
    current: TaskNodeRef,
  ): void {
    const section = this.el_abyssPrivate.createDiv({
      cls: 'abyss-right-section abyss-dep-section',
      attr: { 'data-dependency-direction': direction },
    });
    this.bindDependencyDrop_abyssPrivate(section, direction);
    section
      .createDiv({ cls: 'abyss-right-section-header' })
      .createSpan({ cls: 'abyss-right-section-label', text: dependencyDirectionLabel(direction) });
    const list = section.createDiv({ cls: 'abyss-subtask-list' });
    for (const relation of relations)
      this.renderDependencyRow_abyssPrivate(list, relation, direction, current);
    const add = section.createEl('button', {
      cls: 'abyss-subtask-add-row abyss-dep-add',
      attr: {
        type: 'button',
        'aria-label': `Add dependency: ${dependencyDirectionLabel(direction)}`,
        'aria-haspopup': 'dialog',
      },
    });
    add.createSpan({ cls: 'abyss-subtask-add-icon', text: '+' });
    add.createSpan({ cls: 'abyss-subtask-add-label', text: 'Add dependency' });
    add.addEventListener('click', () => {
      this.showDependencySearch_abyssPrivate(direction);
    });
    const subtasks = this.el_abyssPrivate.querySelector('.abyss-subtask-section');
    if (subtasks !== null) this.el_abyssPrivate.insertBefore(section, subtasks);
  }

  private dependencyDropCommand_abyssPrivate(
    direction: DependencyDirection,
  ): Extract<TaskCommand, { type: 'add-dependency' | 'reverse-dependency' }> | undefined {
    const payload = this.state_abyssPrivate.get('draggingTaskNode');
    const current = this.dependencyTask_abyssPrivate();
    if (payload === null || current === undefined) return undefined;
    if (payload.source === 'inspector-relation') {
      const { relation } = payload;
      if (
        relation.direction === direction ||
        !sameTaskNodeRef(
          taskNodeRef(current),
          relation.direction === 'blocked-by' ? relation.dependent : relation.blocker,
        )
      )
        return undefined;
      return {
        type: 'reverse-dependency',
        blocker: relation.blocker,
        dependent: relation.dependent,
        dependencyId: relation.dependencyId,
      };
    }
    return {
      type: 'add-dependency',
      blocker: direction === 'blocked-by' ? payload.task.target : taskNodeRef(current),
      dependent: direction === 'blocked-by' ? taskNodeRef(current) : payload.task.target,
    };
  }

  private dependencyDropAllowed_abyssPrivate(
    command: ReturnType<RightPanel['dependencyDropCommand_abyssPrivate']>,
  ): boolean {
    if (command === undefined) return false;
    return (
      (command.type === 'reverse-dependency'
        ? this.tasks_abyssPrivate?.queries.dependencyEligibility(
            command.dependent,
            command.blocker,
            { without: command },
          )
        : this.tasks_abyssPrivate?.queries.dependencyEligibility(command.blocker, command.dependent)
      )?.type === 'allowed'
    );
  }

  private clearDependencyDropClasses_abyssPrivate(): void {
    this.el_abyssPrivate.querySelectorAll('.abyss-dep-section').forEach((section) => {
      section.removeClass('is-drop-target', 'is-drop-disabled');
    });
  }

  private bindDependencyDrop_abyssPrivate(
    section: HTMLElement,
    direction: DependencyDirection,
  ): void {
    let checked: TaskNodeDragPayload | null = null;
    let allowed = false;
    const preview = (event: DragEvent): void => {
      this.clearDependencyDropClasses_abyssPrivate();
      const command = this.dependencyDropCommand_abyssPrivate(direction);
      if (command === undefined || this.tasks_abyssPrivate === undefined) return;
      const payload = this.state_abyssPrivate.get('draggingTaskNode');
      if (checked !== payload) {
        checked = payload;
        allowed = this.dependencyDropAllowed_abyssPrivate(command);
      }
      section.addClass(allowed ? 'is-drop-target' : 'is-drop-disabled');
      if (allowed) event.preventDefault();
    };
    section.addEventListener('dragenter', preview);
    section.addEventListener('dragover', preview);
    section.addEventListener('dragleave', (event) => {
      if (!section.contains(event.relatedTarget as Node | null))
        section.removeClass('is-drop-target', 'is-drop-disabled');
    });
    section.addEventListener('drop', (event) => {
      const command = this.dependencyDropCommand_abyssPrivate(direction);
      this.clearDependencyDropClasses_abyssPrivate();
      if (command !== undefined && this.dependencyDropAllowed_abyssPrivate(command)) {
        event.preventDefault();
        event.stopPropagation();
        runAsyncAction(
          this.commitDependencyDrop_abyssPrivate(command),
          'Could not update dependency',
        );
      }
      if (this.state_abyssPrivate.get('draggingTaskNode') !== null)
        this.state_abyssPrivate.set('draggingTaskNode', null);
    });
  }

  private async commitDependencyDrop_abyssPrivate(
    command: Extract<TaskCommand, { type: 'add-dependency' | 'reverse-dependency' }>,
  ): Promise<void> {
    const selection = this.state_abyssPrivate.get('taskStack');
    const committed = await this.executeDependencyCommand_abyssPrivate(command);
    if (!committed || !this.mounted_abyssPrivate) return;
    const submitted = this.dependencyTask_abyssPrivate(selection);
    const current = this.dependencyTask_abyssPrivate();
    if (
      submitted === undefined ||
      current === undefined ||
      !sameTaskNodeRef(taskNodeRef(submitted), taskNodeRef(current))
    )
      return;
    this.refreshDependencies_abyssPrivate();
  }

  private renderDependencyRow_abyssPrivate(
    container: HTMLElement,
    relation: TaskDependencyRelation,
    direction: DependencyDirection,
    current: TaskNodeRef,
  ): void {
    const presentation = dependencyRelationPresentation(relation);
    const row = container.createDiv({
      cls: `abyss-subtask-row abyss-dep-row${presentation.unavailable ? ' is-unavailable' : ''}`,
      attr: { 'data-state': presentation.state },
    });
    if (relation.type === 'resolved') {
      this.bindRelationDrag_abyssPrivate(row, relation, direction, current);
      const marker = renderStatusMarker(row, {
        task: relation.task.node,
        registry: this.statusRegistry_abyssPrivate,
        interactive: false,
        onLeftClick: () => {},
        onContextMenu: () => {},
      });
      marker.addEventListener('click', (event) => {
        event.stopPropagation();
      });
      row.addEventListener('click', (event) => {
        event.stopPropagation();
        const previous = this.state_abyssPrivate.get('taskStack');
        this.state_abyssPrivate.openInspectorDependency(relation.task);
        if (this.state_abyssPrivate.get('taskStack') !== previous)
          this.el_abyssPrivate.querySelector<HTMLElement>('.abyss-inspector-back')?.focus();
      });
    }
    row.createEl(relation.type === 'resolved' ? 'button' : 'span', {
      cls: `abyss-subtask-label abyss-dep-title${presentation.done ? ' is-done' : ''}`,
      text: presentation.title,
      attr: {
        title: presentation.title,
        ...(relation.type === 'resolved' ? { type: 'button' } : {}),
      },
    });
    if (presentation.unavailable)
      row.createSpan({
        cls: 'abyss-dep-id',
        text: relation.dependencyId,
        attr: { title: relation.dependencyId },
      });
    const dependent =
      direction === 'blocks' && relation.type === 'resolved' ? relation.task.target : current;
    this.renderRowRemove_abyssPrivate(
      row,
      'abyss-dep-remove',
      {
        label: presentation.removeLabel,
        title: presentation.removeLabel,
        failure: 'Could not remove dependency',
      },
      () =>
        this.executeDependencyCommand_abyssPrivate(
          {
            type: 'remove-dependency',
            dependent,
            dependencyId: relation.dependencyId,
          },
          {
            list: `[data-dependency-direction="${direction}"] .abyss-subtask-list`,
            index: [...container.querySelectorAll('.abyss-dep-row')].indexOf(row),
            title: relation.type === 'resolved' ? presentation.title : relation.dependencyId,
          },
        ),
    );
  }

  private bindRelationDrag_abyssPrivate(
    row: HTMLElement,
    relation: Extract<TaskDependencyRelation, { type: 'resolved' }>,
    direction: DependencyDirection,
    current: TaskNodeRef,
  ): void {
    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      event.stopPropagation();
      this.endTaskDrag_abyssPrivate?.();
      row.addClass('is-dragging');
      this.endTaskDrag_abyssPrivate = startTaskNodeDrag(
        this.state_abyssPrivate,
        this.el_abyssPrivate,
        row,
        {
          payload: {
            source: 'inspector-relation',
            task: relation.task,
            relation: {
              direction,
              dependencyId: relation.dependencyId,
              blocker: direction === 'blocked-by' ? relation.task.target : current,
              dependent: direction === 'blocked-by' ? current : relation.task.target,
            },
          },
          onEnd: () => {
            row.removeClass('is-dragging');
          },
        },
      );
    });
  }

  private refreshDependencies_abyssPrivate(): void {
    this.undo_abyssPrivate.detach();
    for (const [marker, task] of this.dependencyStatusMarkers_abyssPrivate) {
      setStatusMarkerCompletionBlocked(marker, this.isDependencyBlocked_abyssPrivate(task));
    }
    this.updateDependencyBadge_abyssPrivate();
    this.el_abyssPrivate.querySelectorAll('.abyss-dep-section').forEach((section) => {
      section.remove();
    });
    this.renderDependencySections_abyssPrivate();
    this.dependencySearch_abyssPrivate?.refresh();
    this.undo_abyssPrivate.render(this.el_abyssPrivate);
    this.positionDependencySearch_abyssPrivate();
  }

  private showDependencySearch_abyssPrivate(direction?: DependencyDirection): void {
    this.clearPopovers_abyssPrivate();
    this.dependencySearchAnchor_abyssPrivate =
      direction === undefined
        ? '.abyss-dep-badge-body'
        : `[data-dependency-direction="${direction}"] .abyss-dep-add`;
    this.dependencySearch_abyssPrivate = mountDependencySearch(this.el_abyssPrivate, {
      direction: direction ?? 'blocked-by',
      canChangeDirection: direction === undefined,
      options: (query, chosen) => {
        const current = this.dependencyTask_abyssPrivate();
        const tasks = this.tasks_abyssPrivate;
        if (tasks === undefined || current === undefined) return [];
        return dependencySearchOptions({
          current: taskNodeRef(current),
          direction: chosen,
          query,
          tasks: tasks.queries.listNodes(),
          eligibility: (blocker, dependent) =>
            tasks.queries.dependencyEligibility(blocker, dependent),
        });
      },
      selectExisting: async (option, chosen) => {
        const current = this.dependencyTask_abyssPrivate();
        if (current === undefined)
          return { type: 'validation-error', message: 'The current task is no longer available.' };
        const committed = await this.executeDependencyCommand_abyssPrivate({
          type: 'add-dependency',
          blocker: chosen === 'blocked-by' ? option.task.target : taskNodeRef(current),
          dependent: chosen === 'blocked-by' ? taskNodeRef(current) : option.task.target,
        });
        return { type: committed ? 'committed' : 'failed' };
      },
      createNew: (text, chosen) => this.createDependencySubtask_abyssPrivate(text, chosen),
      onClose: (restoreFocus) => {
        const surface = this.dependencySearch_abyssPrivate?.element;
        if (surface !== undefined) this.anchoredSurfaceCleanups_abyssPrivate.get(surface)?.();
        this.dependencySearch_abyssPrivate = undefined;
        this.updateDependencyBadge_abyssPrivate();
        if (restoreFocus) focusWithoutScroll(this.dependencyAnchor_abyssPrivate());
      },
      ownership: this.interactionOwnership_abyssPrivate,
      position: (element) => {
        this.positionDependencySearch_abyssPrivate(element);
      },
    });
    this.updateDependencyBadge_abyssPrivate();
  }

  private dependencyAnchor_abyssPrivate(): HTMLElement | null {
    return (
      this.el_abyssPrivate.querySelector<HTMLElement>(this.dependencySearchAnchor_abyssPrivate) ??
      this.el_abyssPrivate.querySelector<HTMLElement>('.abyss-dep-badge-body')
    );
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
    if (submission === undefined) return { type: 'failed' };
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

  private positionDependencySearch_abyssPrivate(
    element = this.dependencySearch_abyssPrivate?.element,
    focused?: HTMLElement | null,
  ): void {
    if (element === undefined) return;
    const anchor = this.dependencyAnchor_abyssPrivate();
    if (anchor !== null) this.positionAnchoredSurface_abyssPrivate(element, anchor, 'below-start');
    if (focused != null) {
      focusWithoutScroll(
        element.contains(focused) && !focused.matches(':disabled,[hidden]')
          ? focused
          : element.querySelector<HTMLElement>('input'),
      );
    }
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

  private renderTimeChip_abyssPrivate(container: HTMLElement, task: TaskLike): void {
    const duration = 'source' in task ? task.planning.duration : undefined;
    const time = task.planning.time;
    const presentation = timeChipPresentation(time, duration);
    const chip = container.createEl('button', {
      cls: `abyss-chip abyss-chip-time${time == null ? ' abyss-chip-empty' : ''}`,
      text: presentation.text,
      attr: {
        title: time == null ? 'Set time and duration' : 'Change time and duration',
        'aria-label': presentation.label,
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
      },
    });
    chip.addEventListener('click', (event) => {
      event.stopPropagation();
      this.showTimePopover_abyssPrivate(chip, task);
    });
  }

  private renderDescriptionSection_abyssPrivate(task: TaskLike): void {
    const descSection = this.el_abyssPrivate.createDiv({ cls: 'abyss-right-section' });
    const descHeader = descSection.createDiv({ cls: 'abyss-right-section-header' });
    descHeader.createSpan({ cls: 'abyss-right-section-label', text: 'Description' });
    this.renderDescriptionBlock_abyssPrivate(descSection, task);
  }

  private renderSubtaskSection_abyssPrivate(task: TaskLike): void {
    const subSection = this.el_abyssPrivate.createDiv({
      cls: 'abyss-right-section abyss-subtask-section',
    });
    const subHeader = subSection.createDiv({ cls: 'abyss-right-section-header' });
    subHeader.createSpan({ cls: 'abyss-right-section-label', text: 'Sub-tasks' });
    const totalSubs = task.subtasks.length;
    if (totalSubs > 0) {
      const doneSubs = task.subtasks.filter((s) => s.status === 'done').length;
      subHeader.createSpan({
        cls: 'abyss-right-section-count',
        text: `${doneSubs}/${totalSubs}`,
      });
    }
    const subList = subSection.createDiv({ cls: 'abyss-subtask-list' });
    for (const sub of task.subtasks) this.renderSubTask_abyssPrivate(subList, sub, task);
    this.renderAddSubtaskControl_abyssPrivate(subSection, task);
  }

  private renderAddSubtaskControl_abyssPrivate(subSection: HTMLElement, task: TaskLike): void {
    const addSubRow = subSection.createDiv({ cls: 'abyss-subtask-add-row' });
    addSubRow.createSpan({ cls: 'abyss-subtask-add-icon', text: '+' });
    addSubRow.createSpan({ cls: 'abyss-subtask-add-label', text: 'Add sub-task' });
    addSubRow.addEventListener('click', () => {
      this.openSubtaskInput_abyssPrivate(subSection, addSubRow, task);
    });
  }

  private openSubtaskInput_abyssPrivate(
    section: HTMLElement,
    trigger: HTMLElement,
    task: TaskLike,
  ): void {
    trigger.addClass('abyss-subtask-add-row--hidden');
    const input = section.createEl('input', {
      cls: 'abyss-subtask-new-input',
      attr: { type: 'text', placeholder: 'New sub-task…' },
    });
    const lifecycle = new AsyncEditLifecycle();
    const close = (): void => {
      if (lifecycle.isClosed()) return;
      lifecycle.close();
      input.remove();
      trigger.removeClass('abyss-subtask-add-row--hidden');
    };
    const commit = async (): Promise<void> => {
      if (!lifecycle.begin()) return;
      const text = input.value.trim();
      if (text === '') {
        close();
        return;
      }
      const succeeded = await this.addSubTask_abyssPrivate(task, text);
      if (lifecycle.isClosed()) return;
      if (succeeded) close();
      else {
        lifecycle.retry();
        input.focus();
      }
    };
    input.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') runAsyncAction(commit());
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });
    input.addEventListener('blur', () => {
      window.setTimeout(() => {
        runAsyncAction(commit());
      }, 150);
    });
    input.focus();
  }

  private renderCommentSection_abyssPrivate(
    task: TaskLike,
    commentTimeContext?: CommentTimeContext,
  ): void {
    const commentSection = this.el_abyssPrivate.createDiv({ cls: 'abyss-right-section' });
    const commentHeader = commentSection.createDiv({ cls: 'abyss-right-section-header' });
    commentHeader.createSpan({ cls: 'abyss-right-section-label', text: 'Comments' });
    const commentCount = task.comments.length;
    if (commentCount > 0) {
      commentHeader.createSpan({
        cls: 'abyss-right-section-count',
        text: String(commentCount),
      });
    }
    const commentList = commentSection.createDiv({ cls: 'abyss-comment-list' });
    for (const comment of task.comments) {
      this.renderComment_abyssPrivate(commentList, comment, task, commentTimeContext);
    }
    const commentInput = commentSection.createEl('textarea', {
      cls: 'abyss-comment-input',
      attr: { placeholder: 'Write a comment…', rows: '2' },
    });
    enableAttachmentDrop(commentInput, {
      app: this.app_abyssPrivate,
      sourcePath: rootTaskRef(task).filePath,
      onLinks: (links) => {
        commentInput.value = commentInput.value === '' ? links : `${commentInput.value} ${links}`;
        commentInput.focus();
      },
    });
    this.enablePaste_abyssPrivate(commentInput, task);
    commentInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = commentInput.value.trim();
        if (text !== '') {
          runAsyncAction(this.addComment_abyssPrivate(task, text, commentList, commentInput));
        }
      }
    });
  }

  private renderTitleBlock_abyssPrivate(header: HTMLElement, task: TaskLike): void {
    const view = header.createDiv({ cls: 'abyss-right-title abyss-right-title-view' });
    enableAttachmentDrop(view, {
      app: this.app_abyssPrivate,
      sourcePath: rootTaskRef(task).filePath,
      onLinks: (links) => {
        runAsyncAction(this.appendToTitle_abyssPrivate(task, links));
      },
    });
    const renderView = (): void => {
      renderTaskText(view, task.markdownTitle, {
        app: this.app_abyssPrivate,
        sourcePath: rootTaskRef(task).filePath,
        component: this.md_abyssPrivate,
        onEditLink: (occ, token) => {
          this.editLink_abyssPrivate(task, occ, token);
        },
      });
    };
    renderView();

    // Click on empty space / non-link text enters edit mode.
    view.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a') != null) return; // let links navigate
      this.enterTitleEdit_abyssPrivate(header, view, task, renderView);
    });
  }

  private enterTitleEdit_abyssPrivate(
    header: HTMLElement,
    view: HTMLElement,
    task: TaskLike,
    renderView: () => void,
  ): void {
    // Preserve the height the user stretched the read-mode block to (measure first).
    const startHeight = view.offsetHeight;
    view.hide();
    const ta = header.createEl('textarea', { cls: 'abyss-right-title abyss-right-title-edit' });
    // Keep the textarea in the title's slot so the ⋯/× action buttons stay on the right.
    view.insertAdjacentElement('afterend', ta);
    ta.value = task.markdownTitle;
    this.enablePaste_abyssPrivate(ta, task);
    // Auto-grow to content, but never below the stretched height.
    const grow = (): void => {
      ta.setCssStyles({ height: 'auto' });
      ta.setCssStyles({ height: `${Math.max(ta.scrollHeight, startHeight)}px` });
    };
    ta.addEventListener('input', grow);
    window.setTimeout(() => {
      ta.focus();
      grow();
    }, 0);

    const lifecycle = new AsyncEditLifecycle();
    const finish = async (save: boolean): Promise<void> => {
      if (!lifecycle.begin()) return;
      // Let any in-flight paste insert its link into the value before we save/remove.
      await whenPasteSettled(ta);
      // Carry the current height back to the read-mode block so the stretch persists.
      view.setCssStyles({ height: `${ta.offsetHeight}px` });
      if (save && ta.value !== task.markdownTitle) {
        const saved = await this.saveTaskTitle_abyssPrivate(task, ta.value.trim());
        if (!saved) {
          lifecycle.retry();
          ta.focus();
          return;
        }
      }
      lifecycle.close();
      ta.remove();
      view.show();
      renderView();
    };
    ta.addEventListener('blur', () => {
      runAsyncAction(finish(true));
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runAsyncAction(finish(true));
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        runAsyncAction(finish(false));
      }
    });
  }

  private renderSubTask_abyssPrivate(
    container: HTMLElement,
    sub: SubtaskSnapshot,
    parentTask: TaskLike,
  ): void {
    const row = container.createDiv({
      cls: 'abyss-subtask-row',
      attr: { draggable: 'true', tabindex: '-1' },
    });
    this.bindSubtaskDragAndDrop_abyssPrivate(row, container, sub, parentTask);
    this.renderTaskStatusMarker_abyssPrivate(row, sub);
    this.renderSubtaskContent_abyssPrivate(row, sub);
  }

  private renderRowRemove_abyssPrivate(
    container: HTMLElement,
    cls: string,
    { label, title, failure }: { label: string; title?: string; failure: string },
    action: () => Promise<unknown>,
  ): void {
    const remove = container.createEl('button', {
      cls,
      attr: { type: 'button', 'aria-label': label, ...(title === undefined ? {} : { title }) },
    });
    setIcon(remove, 'x');
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      if (remove.disabled) return;
      remove.disabled = true;
      runAsyncAction(
        action().finally(() => {
          remove.disabled = false;
        }),
        failure,
      );
    });
  }

  private bindSubtaskDragAndDrop_abyssPrivate(
    row: HTMLElement,
    container: HTMLElement,
    sub: SubtaskSnapshot,
    parentTask: TaskLike,
  ): void {
    row.addEventListener('dragstart', (e) => {
      this.startSubtaskDrag_abyssPrivate(row, container, sub, e);
    });

    row.addEventListener('dragover', (e) => {
      if (
        this.draggingSub_abyssPrivate == null ||
        this.draggingSub_abyssPrivate.ref.relativeLine === sub.ref.relativeLine
      )
        return;
      e.preventDefault();
      const rect = row.getBoundingClientRect();
      const isAbove = e.clientY < rect.top + rect.height / 2;
      // Clear indicators on all siblings first
      container.querySelectorAll('.drop-above,.drop-below').forEach((el) => {
        el.removeClass('drop-above', 'drop-below');
      });
      row.addClass(isAbove ? 'drop-above' : 'drop-below');
    });

    row.addEventListener('dragleave', (e) => {
      if (!row.contains(e.relatedTarget as Node)) {
        row.removeClass('drop-above', 'drop-below');
      }
    });

    row.addEventListener('drop', (e) => {
      const dragged = this.draggingSub_abyssPrivate;
      if (dragged == null || dragged.ref.relativeLine === sub.ref.relativeLine) return;
      e.preventDefault();
      const position = row.hasClass('drop-above') ? 'before' : 'after';
      row.removeClass('drop-above', 'drop-below');
      runAsyncAction(this.reorderSubTask_abyssPrivate(parentTask, dragged, sub, position));
    });
  }

  private startSubtaskDrag_abyssPrivate(
    row: HTMLElement,
    container: HTMLElement,
    sub: SubtaskSnapshot,
    event: DragEvent,
  ): void {
    this.endTaskDrag_abyssPrivate?.();
    this.draggingSub_abyssPrivate = sub;
    row.addClass('is-dragging');
    event.dataTransfer?.setData('text/plain', String(sub.ref.relativeLine));
    const stack = this.state_abyssPrivate.get('taskStack');
    const root = stack[0];
    if (root !== undefined && 'source' in root) {
      this.endTaskDrag_abyssPrivate = startTaskNodeDrag(
        this.state_abyssPrivate,
        this.el_abyssPrivate,
        row,
        {
          payload: {
            source: 'inspector-subtask',
            task: {
              root,
              path: [...stack.filter((node): node is SubtaskSnapshot => !('source' in node)), sub],
              node: sub,
              target: taskNodeRef(sub),
            },
          },
          onEnd: () => {
            this.draggingSub_abyssPrivate = null;
            row.removeClass('is-dragging');
            container.querySelectorAll('.drop-above,.drop-below').forEach((element) => {
              element.removeClass('drop-above', 'drop-below');
            });
          },
        },
      );
    }
  }

  private renderSubtaskContent_abyssPrivate(row: HTMLElement, sub: SubtaskSnapshot): void {
    const content = row.createDiv({ cls: 'abyss-subtask-content' });
    const titleRow = content.createDiv({ cls: 'abyss-subtask-title-row' });
    const label = titleRow.createSpan({
      cls: `abyss-subtask-label${sub.status === 'done' ? ' is-done' : ''}`,
    });
    renderTaskText(label, sub.markdownTitle, {
      app: this.app_abyssPrivate,
      sourcePath: rootTaskRef(sub).filePath,
      component: this.md_abyssPrivate,
      onEditLink: (occ, token) => {
        this.editLink_abyssPrivate(sub, occ, token);
      },
    });
    label.addEventListener('click', () => {
      const stack = this.state_abyssPrivate.get('taskStack');
      this.state_abyssPrivate.updateInspectorSelection([...stack, sub]);
    });
    this.renderRowRemove_abyssPrivate(
      titleRow,
      'abyss-subtask-remove',
      { label: 'Delete sub-task', failure: 'Could not delete sub-task' },
      () => this.deleteTask_abyssPrivate(sub),
    );

    // Progress + comment count indicators
    const subCount = sub.subtasks.length;
    const commentCount = sub.comments.length;
    if (subCount > 0 || commentCount > 0) {
      const subMeta = content.createDiv({ cls: 'abyss-subtask-meta' });
      if (subCount > 0) {
        const done = sub.subtasks.filter((s) => s.status === 'done').length;
        subMeta.createSpan({ cls: 'abyss-subtask-progress', text: `${done}/${subCount}` });
      }
      if (commentCount > 0) {
        subMeta.createSpan({
          cls: 'abyss-subtask-comment-count',
          text: `💬 ${commentCount}`,
        });
      }
    }
  }

  private renderComment_abyssPrivate(
    container: HTMLElement,
    comment: TaskCommentSnapshot,
    task: TaskLike,
    commentTimeContext?: CommentTimeContext,
  ): void {
    const row = container.createDiv({ cls: 'abyss-comment-row' });
    enableAttachmentDrop(row, {
      app: this.app_abyssPrivate,
      sourcePath: rootTaskRef(task).filePath,
      onLinks: (links) => {
        runAsyncAction(
          this.updateComment_abyssPrivate(task, comment, `${comment.text} ${links}`.trim()),
        );
      },
    });
    if (comment.timestamp != null && commentTimeContext != null) {
      row.createSpan({
        cls: 'abyss-comment-date',
        text: formatCommentTimeLabel({ timestamp: comment.timestamp, ...commentTimeContext }),
      });
    }
    const showText = (): void => {
      this.renderCommentText_abyssPrivate(row, comment, task, showText);
    };
    showText();
  }

  private renderCommentText_abyssPrivate(
    row: HTMLElement,
    comment: TaskCommentSnapshot,
    task: TaskLike,
    showText: () => void,
  ): void {
    const textEl = row.createEl('p', { cls: 'abyss-comment-text' });
    renderTaskText(textEl, comment.text, {
      app: this.app_abyssPrivate,
      sourcePath: rootTaskRef(task).filePath,
      component: this.md_abyssPrivate,
      onEditLink: (occurrence, token) => {
        this.editLinkInString_abyssPrivate(
          { type: 'comment', ref: commentRefOf(comment) },
          occurrence,
          token,
          rootTaskRef(task).filePath,
        );
      },
    });
    textEl.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('a') != null) return;
      this.openCommentEditor_abyssPrivate(row, comment, task, showText);
    });
  }

  private openCommentEditor_abyssPrivate(
    row: HTMLElement,
    comment: TaskCommentSnapshot,
    task: TaskLike,
    showText: () => void,
  ): void {
    row.querySelector('.abyss-comment-text')?.remove();
    const textarea = row.createEl('textarea', { cls: 'abyss-comment-edit-input' });
    textarea.value = comment.text;
    this.enablePaste_abyssPrivate(textarea, task);
    const lifecycle = new AsyncEditLifecycle();
    const finish = async (): Promise<void> => {
      if (!lifecycle.begin()) return;
      await whenPasteSettled(textarea);
      const value = textarea.value.trim();
      if (value === comment.text) {
        lifecycle.close();
        textarea.remove();
        showText();
        return;
      }
      const committed =
        value === ''
          ? await this.deleteComment_abyssPrivate(task, comment)
          : await this.updateComment_abyssPrivate(task, comment, value);
      if (!committed) {
        lifecycle.retry();
        textarea.focus();
        return;
      }
      lifecycle.close();
      textarea.remove();
    };
    textarea.addEventListener('blur', () => {
      window.setTimeout(() => {
        runAsyncAction(finish());
      }, 150);
    });
    textarea.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        textarea.blur();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        lifecycle.close();
        textarea.remove();
        showText();
      }
    });
    textarea.focus();
    textarea.select();
  }

  private renderDateChip_abyssPrivate(container: HTMLElement, task: TaskLike): void {
    const d = task.planning.due ?? task.planning.scheduled;
    let field: 'due' | 'scheduled' = 'due';
    if (task.planning.due == null && task.planning.scheduled != null) field = 'scheduled';
    const chip = container.createEl('button', {
      cls: `abyss-chip${d != null ? '' : ' abyss-chip-empty'}`,
      text: d != null ? `📅 ${this.formatDate_abyssPrivate(d)}` : '📅 Date',
    });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showDatePopover_abyssPrivate(chip, task, field);
    });
  }

  /** "Plan" (⏳/`scheduled`) chip — same round-pill/popover pattern as the due-date chip. */
  private renderScheduledChip_abyssPrivate(container: HTMLElement, task: TaskLike): void {
    const value = task.planning.scheduled;
    const chip = container.createEl('button', {
      cls: `abyss-chip abyss-chip-scheduled${value != null ? '' : ' abyss-chip-empty'}`,
      text: value != null ? `⏳ ${this.formatDate_abyssPrivate(value)}` : '⏳ Plan',
      attr: { title: 'Set plan date' },
    });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showDatePopover_abyssPrivate(chip, task, 'scheduled');
    });
  }

  /** "Start" (🛫/`start`) chip — same round-pill/popover pattern as the due-date chip. */
  private renderStartChip_abyssPrivate(container: HTMLElement, task: TaskLike): void {
    const value = task.planning.start;
    const chip = container.createEl('button', {
      cls: `abyss-chip abyss-chip-start${value != null ? '' : ' abyss-chip-empty'}`,
      text: value != null ? `🛫 ${this.formatDate_abyssPrivate(value)}` : '🛫 Start',
      attr: { title: 'Set start date' },
    });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showDatePopover_abyssPrivate(chip, task, 'start');
    });
  }

  /**
   * Compact "+"-style control offering to add whichever of Start/Plan are currently unset —
   * mirrors the "+ tag" button's pattern (small affordance that reveals a chooser) rather than
   * an always-visible placeholder pill. Renders nothing once both are already set (nothing left
   * to offer), and remains extensible for future addable properties (e.g. recurrence).
   */
  private renderAddDateMenu_abyssPrivate(container: HTMLElement, task: TaskLike): void {
    const options: Array<{ field: 'start' | 'scheduled'; label: string }> = [];
    if (task.planning.start == null) options.push({ field: 'start', label: '🛫 Start' });
    if (task.planning.scheduled == null) options.push({ field: 'scheduled', label: '⏳ Plan' });
    if (options.length === 0) return;

    const addBtn = container.createEl('button', {
      cls: 'abyss-chip abyss-chip-add abyss-chip-add-date',
      text: '+ date',
      attr: {
        title: 'Add start or plan date',
        'aria-label': 'Add start or plan date',
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
      },
    });
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showAddDateMenu_abyssPrivate(addBtn, task, options);
    });
  }

  /** Small menu anchored to the "+ date" button — clicking an option opens showDatePopover. */
  private showAddDateMenu_abyssPrivate(
    anchor: HTMLElement,
    task: TaskLike,
    options: Array<{ field: 'start' | 'scheduled'; label: string }>,
  ): void {
    const existing = this.el_abyssPrivate.querySelector('.abyss-add-date-menu');
    if (existing != null) {
      this.removeAnchoredSurface_abyssPrivate(existing as HTMLElement);
      return;
    }
    this.el_abyssPrivate
      .querySelectorAll<HTMLElement>('.abyss-add-date-menu')
      .forEach((element) => {
        this.removeAnchoredSurface_abyssPrivate(element);
      });
    this.el_abyssPrivate.querySelectorAll<HTMLElement>('.abyss-context-menu').forEach((element) => {
      this.removeAnchoredSurface_abyssPrivate(element);
    });

    const menu = this.el_abyssPrivate.createDiv({
      cls: 'abyss-context-menu abyss-add-date-menu abyss-add-date-menu--compact abyss-popover-anchored',
      attr: { role: 'menu', 'aria-label': 'Add date' },
    });
    for (const opt of options) {
      this.createContextMenuItem_abyssPrivate(
        menu,
        'abyss-context-item abyss-add-date-menu-item',
        opt.label,
        () => {
          this.removeAnchoredSurface_abyssPrivate(menu);
          this.showDatePopover_abyssPrivate(anchor, task, opt.field);
        },
      );
    }

    this.positionAnchoredSurface_abyssPrivate(menu, anchor, 'below-start');
    this.dismissMenuOnOutsideClick_abyssPrivate(menu, anchor);
    menu.querySelector<HTMLElement>('.abyss-context-item')?.focus({ preventScroll: true });
  }

  private createContextMenuItem_abyssPrivate(
    menu: HTMLElement,
    className: string,
    text: string,
    action: () => void,
  ): HTMLElement {
    const item = menu.createDiv({
      cls: className,
      text,
      attr: { role: 'menuitem', tabindex: '0' },
    });
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      action();
    });
    item.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      action();
    });
    return item;
  }

  private renderPriorityChip_abyssPrivate(container: HTMLElement, task: TaskLike): void {
    const labels: Record<string, string> = {
      A: '🚩 Highest',
      B: '🚩 High',
      C: '🚩 Medium',
      D: 'Priority',
      E: '🚩 Low',
      F: '🚩 Lowest',
    };
    const chip = container.createEl('button', {
      cls: `abyss-chip abyss-priority-chip abyss-priority-chip--${task.priority}${task.priority === 'D' ? ' abyss-chip-empty' : ''}`,
      text: labels[task.priority] ?? 'Priority',
      attr: {
        'data-priority': task.priority,
        'aria-haspopup': 'listbox',
        'aria-expanded': 'false',
      },
    });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showPriorityPopover_abyssPrivate(chip, task);
    });
  }

  private renderRecurrenceChip_abyssPrivate(
    container: HTMLElement,
    task: TaskLike,
    stack: readonly TaskLike[],
  ): void {
    const recurrence = task.recurrence;
    const hasRecurrence = recurrence !== undefined && recurrence !== '';
    const chip = container.createEl('button', {
      cls: `abyss-chip abyss-repeat-chip${hasRecurrence ? '' : ' abyss-chip-add abyss-chip-empty'}`,
      attr: { title: hasRecurrence ? 'Edit repeat' : 'Add repeat' },
    });
    if (hasRecurrence) {
      renderRecurrenceBadge(chip, recurrenceBadgeInput(recurrence));
      chip.createSpan({ cls: 'abyss-repeat-chip-label', text: recurrence });
    } else {
      chip.setText('+ repeat');
    }
    chip.addEventListener('click', (event) => {
      event.stopPropagation();
      this.showRecurrencePopover_abyssPrivate(chip, task, stack);
    });
  }

  private showRecurrencePopover_abyssPrivate(
    anchor: HTMLElement,
    task: TaskLike,
    stack: readonly TaskLike[],
    autofocus = true,
  ): void {
    const existing = this.el_abyssPrivate.querySelector<HTMLElement>('.abyss-recurrence-popover');
    this.clearPopovers_abyssPrivate();
    if (existing != null) return;
    anchor.focus();
    const root = stack[0];
    const target = taskNodeRef(task);
    if (root == null || !('source' in root)) return;

    const popover = this.el_abyssPrivate.createDiv({
      cls: 'abyss-popover abyss-recurrence-popover abyss-popover-anchored',
      attr: { role: 'dialog', 'aria-modal': 'false' },
    });
    const handle = mountRecurrenceEditor({
      container: popover,
      source: { root, target },
      policy: {
        removeScheduledDate: this.settings_abyssPrivate?.recurrence.removeScheduledDate === true,
      },
      ownershipConflict: this.hasRecurrenceOwnershipConflict_abyssPrivate(task, stack),
      onSubmit: (patch) => this.executePlanningPatch_abyssPrivate(task, patch),
      onClose: () => {
        this.removeAnchoredSurface_abyssPrivate(popover);
      },
    });
    this.recurrenceDraftEditor_abyssPrivate = { target, handle, surface: popover };
    const title = popover.querySelector<HTMLElement>('.abyss-recurrence-title');
    if (title !== null && title.id !== '') popover.setAttribute('aria-labelledby', title.id);
    this.positionAnchoredSurface_abyssPrivate(popover, anchor, 'below-start');
    const placementCleanup = this.anchoredSurfaceCleanups_abyssPrivate.get(popover);
    const editorCleanup = (): void => {
      handle.destroy();
      if (this.recurrenceDraftEditor_abyssPrivate?.surface === popover)
        this.recurrenceDraftEditor_abyssPrivate = undefined;
      placementCleanup?.();
      if (this.anchoredSurfaceCleanups_abyssPrivate.get(popover) === editorCleanup) {
        this.anchoredSurfaceCleanups_abyssPrivate.delete(popover);
      }
    };
    this.anchoredSurfaceCleanups_abyssPrivate.set(popover, editorCleanup);
    this.dismissMenuOnOutsideClick_abyssPrivate(popover, anchor, () => {
      handle.dismiss();
    });
    if (autofocus) this.deferRecurrenceFocus_abyssPrivate(handle);
  }

  private deferRecurrenceFocus_abyssPrivate(handle: RecurrenceEditorHandle): void {
    this.el_abyssPrivate.ownerDocument.defaultView?.setTimeout(() => {
      handle.focus();
    }, 0);
  }

  private hasRecurrenceOwnershipConflict_abyssPrivate(
    task: TaskLike,
    stack: readonly TaskLike[],
  ): boolean {
    if (stack.slice(0, -1).some((ancestor) => ancestor.recurrence !== undefined)) return true;
    const queue = [...task.subtasks];
    for (let index = 0; index < queue.length; index++) {
      const descendant = queue[index];
      if (descendant === undefined) break;
      if (descendant.recurrence !== undefined) return true;
      queue.push(...descendant.subtasks);
    }
    return false;
  }

  private renderTagChip_abyssPrivate(container: HTMLElement, task: TaskLike, tag: string): void {
    const chip = container.createSpan({ cls: 'abyss-chip abyss-chip-tag' });
    const color = this.getTagColor_abyssPrivate(tag);
    if (color !== undefined && color !== '') {
      chip.setCssProps({ '--abyss-chip-tag-color': color });
    }
    chip.createSpan({ text: tag });
    const x = chip.createEl('button', { cls: 'abyss-chip-remove', text: '×' });
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      runAsyncAction(this.removeTag_abyssPrivate(task, tag));
    });
  }

  private getTagColor_abyssPrivate(tag: string): string | undefined {
    if (this.settings_abyssPrivate == null) return undefined;
    return colorForTag(tag, this.settings_abyssPrivate.tagGroups);
  }

  private clearPopovers_abyssPrivate(): void {
    this.el_abyssPrivate.querySelectorAll<HTMLElement>('.abyss-popover').forEach((element) => {
      this.removeAnchoredSurface_abyssPrivate(element);
    });
  }

  private removeAnchoredSurface_abyssPrivate(surface: HTMLElement): void {
    if (surface === this.dependencySearch_abyssPrivate?.element)
      this.dependencySearch_abyssPrivate.close(false);
    this.anchoredSurfaceCleanups_abyssPrivate.get(surface)?.();
    surface.remove();
  }

  private clearAnchoredSurfaces_abyssPrivate(): void {
    if (this.dependencySearch_abyssPrivate?.element.parentElement != null)
      this.dependencySearch_abyssPrivate.close(false);
    for (const [surface, cleanup] of this.anchoredSurfaceCleanups_abyssPrivate) {
      cleanup();
      surface.remove();
    }
    this.anchoredSurfaceCleanups_abyssPrivate.clear();
    this.recurrenceDraftEditor_abyssPrivate = undefined;
  }

  private openStatusMenu_abyssPrivate(event: MouseEvent, task: TaskLike): void {
    this.clearAnchoredSurfaces_abyssPrivate();
    showStatusMenuAt(event, {
      task,
      registry: this.statusRegistry_abyssPrivate,
      owner: this.md_abyssPrivate,
      onPickStatus: (symbol) => {
        runAsyncAction(this.setStatus_abyssPrivate(task, symbol));
      },
      onPickPriority: (priority) => {
        runAsyncAction(this.updatePriority_abyssPrivate(task, priority));
      },
      interactionOwnership: this.interactionOwnership_abyssPrivate,
    });
  }

  /**
   * Small date-picker popover shared by the due/plan/start chips. `field` selects which
   * metadata date is being edited — the popover markup, positioning, and clear-button
   * behavior are identical for all three; only the read/write pair differs.
   */
  private showDatePopover_abyssPrivate(
    anchor: HTMLElement,
    task: TaskLike,
    field: 'due' | 'scheduled' | 'start' = 'due',
  ): void {
    const already = this.el_abyssPrivate.querySelector('.abyss-date-popover');
    this.clearPopovers_abyssPrivate();
    if (already != null) return;

    const previousPopupRole = anchor.getAttribute('aria-haspopup');
    anchor.setAttribute('aria-haspopup', 'dialog');
    const pop = this.el_abyssPrivate.createDiv({
      cls: 'abyss-popover abyss-date-popover abyss-popover-anchored',
      attr: { role: 'dialog', 'aria-label': `Set ${field === 'scheduled' ? 'plan' : field} date` },
    });

    let currentValue: string | undefined;
    if (field === 'due') currentValue = task.planning.due ?? task.planning.scheduled;
    else if (field === 'scheduled') currentValue = task.planning.scheduled;
    else currentValue = task.planning.start;

    const inputRow = pop.createDiv({ cls: 'abyss-popover-input-row' });
    const input = inputRow.createEl('input', {
      cls: 'abyss-date-input',
      attr: { type: 'date', value: currentValue ?? '' },
    });
    input.addEventListener('change', () => {
      runAsyncAction(this.updateDate_abyssPrivate(task, field, input.value));
      this.removeAnchoredSurface_abyssPrivate(pop);
    });
    this.el_abyssPrivate.ownerDocument.defaultView?.setTimeout(() => {
      input.focus();
    }, 0);

    this.renderPopoverClear_abyssPrivate(inputRow, 'Clear date', () => {
      if (field === 'due') runAsyncAction(this.clearDate_abyssPrivate(task));
      else runAsyncAction(this.clearPlanningDate_abyssPrivate(task, field));
      this.removeAnchoredSurface_abyssPrivate(pop);
    });
    this.positionAnchoredSurface_abyssPrivate(pop, anchor, 'below-start');
    this.dismissMenuOnOutsideClick_abyssPrivate(pop, anchor, undefined, {
      focusLeaveDelay: 200,
      onCleanup: () => {
        if (previousPopupRole !== null && previousPopupRole !== '') {
          anchor.setAttribute('aria-haspopup', previousPopupRole);
        } else anchor.removeAttribute('aria-haspopup');
      },
    });
  }

  private showPriorityPopover_abyssPrivate(anchor: HTMLElement, task: TaskLike): void {
    const already = this.el_abyssPrivate.querySelector('.abyss-priority-popover');
    this.clearPopovers_abyssPrivate();
    if (already != null) return;

    const pop = this.el_abyssPrivate.createDiv({
      cls: 'abyss-popover abyss-priority-popover abyss-popover-anchored',
      attr: { role: 'listbox', 'aria-label': 'Priority' },
    });

    const currentPriority = anchor.getAttribute('data-priority') ?? task.priority;
    const options: Array<{ value: string; label: string }> = [
      { value: 'A', label: 'Highest' },
      { value: 'B', label: 'High' },
      { value: 'C', label: 'Medium' },
      { value: 'D', label: 'None' },
      { value: 'E', label: 'Low' },
      { value: 'F', label: 'Lowest' },
    ];
    let selectedOption: HTMLButtonElement | undefined;
    for (const opt of options) {
      const isActive = currentPriority === opt.value;
      const btn = pop.createEl('button', {
        cls: `abyss-priority-option${isActive ? ' is-active' : ''}`,
        attr: {
          'data-priority': opt.value,
          role: 'option',
          'aria-selected': String(isActive),
        },
      });
      if (isActive) selectedOption = btn;
      const checkEl = btn.createSpan({ cls: 'abyss-priority-option-check' });
      if (isActive) setIcon(checkEl, 'check');
      const flagEl = btn.createSpan({ cls: 'abyss-priority-option-flag' });
      setIcon(flagEl, 'flag');
      btn.createSpan({ cls: 'abyss-priority-option-label', text: opt.label });
      btn.addEventListener('click', () => {
        // Optimistic update on the chip
        const chipLabels: Record<string, string> = {
          A: '🚩 Highest',
          B: '🚩 High',
          C: '🚩 Medium',
          D: 'Priority',
          E: '🚩 Low',
          F: '🚩 Lowest',
        };
        anchor.textContent = chipLabels[opt.value] ?? 'Priority';
        anchor.setAttribute('data-priority', opt.value);
        anchor.className = `abyss-chip abyss-priority-chip abyss-priority-chip--${opt.value}${opt.value === 'D' ? ' abyss-chip-empty' : ''}`;
        this.removeAnchoredSurface_abyssPrivate(pop);
        anchor.focus({ preventScroll: true });
        runAsyncAction(this.updatePriority_abyssPrivate(task, opt.value));
      });
    }
    this.positionAnchoredSurface_abyssPrivate(pop, anchor, 'below-start');
    this.dismissMenuOnOutsideClick_abyssPrivate(pop, anchor);
    selectedOption?.focus({ preventScroll: true });
  }

  private positionAnchoredSurface_abyssPrivate(
    popover: HTMLElement,
    anchor: HTMLElement,
    preferred: 'below-start' | 'below-end',
  ): void {
    this.anchoredSurfaceCleanups_abyssPrivate.get(popover)?.();
    const ownerDocument = this.el_abyssPrivate.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const dependency = popover.matches('.abyss-dep-search');
    const overlay = anchor.closest('.abyss-modal');
    let disposed = false;
    const position = (): void => {
      if (!disposed) this.placeAnchoredSurface_abyssPrivate(popover, anchor, preferred);
    };
    position();
    const listen = (method: 'addEventListener' | 'removeEventListener'): void => {
      ownerWindow?.[method]('resize', position);
      ownerWindow?.[method]('scroll', position);
      ownerDocument[method]('scroll', position, true);
    };
    listen('addEventListener');
    const ResizeObserver = ownerWindow?.ResizeObserver;
    const observer =
      dependency && typeof ResizeObserver === 'function' ? new ResizeObserver(position) : undefined;
    for (const element of new Set([
      popover,
      anchor,
      this.el_abyssPrivate,
      overlay,
      popover.offsetParent,
      ...popover.children,
    ])) {
      if (element !== null) observer?.observe(element);
    }
    const cleanup = (): void => {
      if (disposed) return;
      disposed = true;
      observer?.disconnect();
      listen('removeEventListener');
      if (this.anchoredSurfaceCleanups_abyssPrivate.get(popover) === cleanup) {
        this.anchoredSurfaceCleanups_abyssPrivate.delete(popover);
      }
    };
    this.anchoredSurfaceCleanups_abyssPrivate.set(popover, cleanup);
  }

  private placeAnchoredSurface_abyssPrivate(
    popover: HTMLElement,
    anchor: HTMLElement,
    preferred: 'below-start' | 'below-end',
  ): void {
    const computed = popover.ownerDocument.defaultView?.getComputedStyle(popover);
    const geometry = {
      boundary: this.el_abyssPrivate.getBoundingClientRect(),
      anchor: anchor.getBoundingClientRect(),
      edgeGap: this.cssLengthToPx_abyssPrivate(
        computed?.getPropertyValue('--abyss-popover-edge-gap') ?? '',
        popover,
        8,
      ),
      gap: this.cssLengthToPx_abyssPrivate(
        computed?.getPropertyValue('--abyss-popover-anchor-gap') ?? '',
        popover,
        4,
      ),
    };
    if (popover.matches('.abyss-dep-search'))
      geometry.boundary = constrainDependencyPicker(popover, geometry);
    const floating = popover.getBoundingClientRect();
    const placement = anchoredPlacement({
      ...geometry,
      preferred,
      floating: {
        width: dimensionOrFallback(
          floating.width,
          popover.offsetWidth,
          finiteNonzeroOr(parseFloat(computed?.minWidth ?? ''), 160),
        ),
        height: dimensionOrFallback(floating.height, popover.offsetHeight, 0),
      },
    });
    // Convert viewport placement into the actual offset parent's padding box,
    // independently of the visible panel/modal boundary used to contain it.
    const block = popover.offsetParent ?? this.el_abyssPrivate;
    const rect = block.getBoundingClientRect();
    setPopoverLength(popover, 'top', placement.top - rect.top - block.clientTop + block.scrollTop);
    setPopoverLength(
      popover,
      'left',
      placement.left - rect.left - block.clientLeft + block.scrollLeft,
    );
    popover.dataset['side'] = placement.side;
  }

  private cssLengthToPx_abyssPrivate(
    value: string,
    relativeTo: HTMLElement,
    fallback: number,
  ): number {
    const trimmed = value.trim();
    if (trimmed === '') return fallback;
    if (trimmed.endsWith('px')) return parseFloat(trimmed);
    if (trimmed.endsWith('em')) {
      const parsedFontSize = parseFloat(
        relativeTo.ownerDocument.defaultView?.getComputedStyle(
          trimmed.endsWith('rem') ? relativeTo.ownerDocument.documentElement : relativeTo,
        ).fontSize ?? '',
      );
      const fontSize = finiteNonzeroOr(parsedFontSize, 16);
      return parseFloat(trimmed) * fontSize;
    }
    const numeric = parseFloat(trimmed);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  private showTagInput_abyssPrivate(
    container: HTMLElement,
    task: TaskLike,
    anchor: HTMLElement,
  ): void {
    const existing = this.el_abyssPrivate.querySelector<HTMLElement>('.abyss-tag-dropdown-wrap');
    if (existing != null) {
      this.removeAnchoredSurface_abyssPrivate(existing);
      return;
    }
    const surface = showTagDropdown(
      container,
      this.app_abyssPrivate,
      (tag) => this.getTagColor_abyssPrivate(tag),
      (tag) => {
        runAsyncAction(this.addTag_abyssPrivate(task, tag));
      },
      () => {
        this.removeAnchoredSurface_abyssPrivate(surface);
      },
    );
    anchor.addClass('abyss-chip-add--hidden');
    this.dismissMenuOnOutsideClick_abyssPrivate(
      surface,
      anchor,
      () => {
        this.removeAnchoredSurface_abyssPrivate(surface);
      },
      {
        focusLeaveDelay: 200,
        onCleanup: () => {
          anchor.removeClass('abyss-chip-add--hidden');
        },
      },
    );
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
    return requestTaskCompletion(
      task,
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
    inputEl: HTMLTextAreaElement,
  ): Promise<boolean> {
    const parent = taskNodeRef(task);
    const committed = await this.executeBlockCommand_abyssPrivate(
      { type: 'add-comment', parent, text },
      parent,
    );
    if (committed) {
      inputEl.value = '';
      inputEl.focus();
    }
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
    if (submission === undefined) return undefined;
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
        if (submission === undefined)
          return { type: 'io-error', cause: 'pending-task-edit', contentState: 'unchanged' };
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
        ? () => {
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
          }
        : undefined,
    );
  }

  private async updateDate_abyssPrivate(
    task: TaskLike,
    field: 'due' | 'scheduled' | 'start',
    date: string,
  ): Promise<void> {
    await this.executePlanningPatch_abyssPrivate(task, {
      [field]: { type: 'set', value: localDate(date) },
    });
  }

  private async clearDate_abyssPrivate(task: TaskLike): Promise<void> {
    await this.executePlanningPatch_abyssPrivate(
      task,
      task.planning.due != null || task.planning.scheduled == null
        ? { due: { type: 'clear' } }
        : { scheduled: { type: 'clear' } },
    );
  }

  private async clearPlanningDate_abyssPrivate(
    task: TaskLike,
    field: 'scheduled' | 'start',
  ): Promise<void> {
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
      return { type: 'io-error', cause: 'repository-error', contentState: 'unchanged' };
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
          result.changed ? submission : undefined,
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
    submission: object | undefined,
  ): void {
    const draft =
      submission === undefined
        ? this.captureDraftState()
        : this.captureDraftStateForOwnedTransition(
            rootRefForPlanningTarget(target),
            root.ref,
            submission,
          );
    this.state_abyssPrivate.updateInspectorSelection(
      target.type === 'subtask'
        ? rebuildPlanningTargetStack(root, target)
        : rebuildTaskSelection(root, stack),
    );
    this.restoreDraftState(draft, root);
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
    if (this.statusRegistry_abyssPrivate.bySymbol(symbol)?.type === 'done') {
      return requestTaskCompletion(
        task,
        () => this.commitStatus_abyssPrivate(task, symbol),
        this.interactionOwnership_abyssPrivate,
        this.completionConfirmationAbortController_abyssPrivate.signal,
      );
    }
    return this.commitStatus_abyssPrivate(task, symbol);
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

  private async updatePriority_abyssPrivate(task: TaskLike, priority: string): Promise<void> {
    if (!['A', 'B', 'C', 'D', 'E', 'F'].includes(priority)) return;
    const patch: SubtaskPatch = {
      priority: { type: 'set', value: priority as TaskPriority },
    };
    await this.executePlanningPatch_abyssPrivate(task, patch);
  }

  private async removeTag_abyssPrivate(task: TaskLike, tag: string): Promise<void> {
    await this.executePlanningPatch_abyssPrivate(task, { tags: { remove: [tag] } });
  }

  private async addTag_abyssPrivate(task: TaskLike, tag: string): Promise<void> {
    await this.executePlanningPatch_abyssPrivate(task, { tags: { add: [tag] } });
  }

  private showTimePopover_abyssPrivate(anchor: HTMLElement, task: TaskLike): void {
    const already = this.el_abyssPrivate.querySelector('.abyss-time-popover');
    this.clearPopovers_abyssPrivate();
    if (already != null) return;

    const pop = this.el_abyssPrivate.createDiv({
      cls: 'abyss-popover abyss-time-popover abyss-popover-anchored',
      attr: { role: 'dialog', 'aria-label': 'Set time and duration' },
    });

    const inputRow = pop.createDiv({ cls: 'abyss-popover-input-row' });
    const input = inputRow.createEl('input', {
      cls: 'abyss-time-input',
      attr: { type: 'time', value: task.planning.time ?? '' },
    });
    this.el_abyssPrivate.ownerDocument.defaultView?.setTimeout(() => {
      input.focus();
    }, 0);
    input.addEventListener('change', () => {
      this.finishPopoverUpdate_abyssPrivate(pop, this.updateTime_abyssPrivate(task, input.value));
    });

    this.renderPopoverClear_abyssPrivate(inputRow, 'Clear time', () => {
      this.finishPopoverUpdate_abyssPrivate(pop, this.updateTime_abyssPrivate(task, ''));
    });

    if ('source' in task) this.renderDurationInputs_abyssPrivate(pop, task);

    this.positionAnchoredSurface_abyssPrivate(pop, anchor, 'below-start');
    this.dismissMenuOnOutsideClick_abyssPrivate(pop, anchor, undefined, { focusLeaveDelay: 200 });
  }

  private renderDurationInputs_abyssPrivate(popover: HTMLElement, task: TaskSnapshot): void {
    const row = popover.createDiv({ cls: 'abyss-popover-input-row' });
    const input = row.createEl('input', {
      cls: 'abyss-duration-input',
      attr: {
        type: 'text',
        placeholder: 'Duration (for example, 1h30m)',
        value:
          task.planning.duration == null ? '' : formatDurationFromMinutes(task.planning.duration),
      },
    });
    input.addEventListener('change', () => {
      const minutes = parseDurationToMinutes(input.value);
      const update =
        minutes === undefined || minutes === 0
          ? this.clearDuration_abyssPrivate(task)
          : this.updateDuration_abyssPrivate(task, minutes);
      this.finishPopoverUpdate_abyssPrivate(popover, update);
    });
    this.renderPopoverClear_abyssPrivate(row, 'Clear duration', () => {
      this.finishPopoverUpdate_abyssPrivate(popover, this.clearDuration_abyssPrivate(task));
    });
  }

  private finishPopoverUpdate_abyssPrivate(popover: HTMLElement, update: Promise<void>): void {
    runAsyncAction(
      update.then(() => {
        this.removeAnchoredSurface_abyssPrivate(popover);
      }),
    );
  }

  private renderPopoverClear_abyssPrivate(
    row: HTMLElement,
    label: string,
    action: () => void,
  ): void {
    const button = row.createEl('button', {
      cls: 'abyss-popover-clear-icon-btn',
      attr: { title: label, 'aria-label': label },
    });
    setIcon(button, 'x');
    button.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });
    button.addEventListener('click', action);
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

  private renderContextMenu_abyssPrivate(task: TaskLike, anchor: HTMLElement): void {
    const existing = this.el_abyssPrivate.querySelector<HTMLElement>('.abyss-task-context-menu');
    if (existing != null) {
      this.removeAnchoredSurface_abyssPrivate(existing);
      return;
    }
    // Close any other open context menus
    this.el_abyssPrivate.querySelectorAll<HTMLElement>('.abyss-context-menu').forEach((element) => {
      this.removeAnchoredSurface_abyssPrivate(element);
    });

    const menu = this.el_abyssPrivate.createDiv({
      cls: 'abyss-context-menu abyss-task-context-menu abyss-popover-anchored',
      attr: { role: 'menu', 'aria-label': 'Task actions' },
    });

    const editRepeat = this.createContextMenuItem_abyssPrivate(
      menu,
      'abyss-context-item',
      'Edit repeat…',
      () => {
        this.removeAnchoredSurface_abyssPrivate(menu);
        this.showRecurrencePopover_abyssPrivate(
          anchor,
          task,
          this.recurrenceStackFor_abyssPrivate(task),
        );
      },
    );

    this.createContextMenuItem_abyssPrivate(
      menu,
      'abyss-context-item abyss-context-danger',
      taskNodeRef(task).type === 'subtask' ? 'Delete sub-task' : 'Delete task',
      () => {
        this.removeAnchoredSurface_abyssPrivate(menu);
        runAsyncAction(this.deleteTask_abyssPrivate(task));
      },
    );

    this.createContextMenuItem_abyssPrivate(menu, 'abyss-context-item', 'Open in file', () => {
      this.removeAnchoredSurface_abyssPrivate(menu);
      const root = this.state_abyssPrivate.get('taskStack')[0];
      if (root != null && 'source' in root)
        runAsyncAction(openInFile(this.app_abyssPrivate, root, taskNodeLine(root, task)));
    });

    this.positionAnchoredSurface_abyssPrivate(menu, anchor, 'below-end');
    this.dismissMenuOnOutsideClick_abyssPrivate(menu, anchor);
    editRepeat.focus({ preventScroll: true });
  }

  private recurrenceStackFor_abyssPrivate(task: TaskLike): readonly TaskLike[] {
    const root = this.state_abyssPrivate.get('taskStack')[0];
    const target = taskNodeRef(task);
    if (root == null || !('source' in root)) return [];
    return rebuildPlanningTargetStack(root, target);
  }

  /** Shared outside-click dismissal for small anchored menus (context menu, add-date menu). */
  private dismissMenuOnOutsideClick_abyssPrivate(
    menu: HTMLElement,
    anchor: HTMLElement,
    dismissSurface: () => void = () => {
      this.removeAnchoredSurface_abyssPrivate(menu);
    },
    options: { focusLeaveDelay?: number; onCleanup?: () => void } = {},
  ): void {
    const ownerDocument = this.el_abyssPrivate.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const placementCleanup = this.anchoredSurfaceCleanups_abyssPrivate.get(menu);
    const ownershipToken = this.interactionOwnership_abyssPrivate.acquire({
      blocksShortcuts: true,
    });
    let listening = false;
    let cleaned = false;
    let focusLeaveTimer: number | undefined;
    anchor.setAttribute('aria-expanded', 'true');
    const dismiss = (e: MouseEvent): void => {
      if (!menu.contains(e.target as Node) && e.target !== anchor) {
        dismissSurface();
      }
    };
    const dismissOnEscape = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      dismissSurface();
      anchor.focus({ preventScroll: true });
    };
    const dismissAfterFocusLeaves = (): void => {
      if (options.focusLeaveDelay === undefined) return;
      if (focusLeaveTimer !== undefined) ownerWindow?.clearTimeout(focusLeaveTimer);
      focusLeaveTimer = ownerWindow?.setTimeout(() => {
        focusLeaveTimer = undefined;
        const activeElement = ownerDocument.activeElement;
        if (!menu.contains(activeElement) && activeElement !== anchor) dismissSurface();
      }, options.focusLeaveDelay);
    };
    ownerDocument.addEventListener('keydown', dismissOnEscape, true);
    if (options.focusLeaveDelay !== undefined) {
      menu.addEventListener('focusout', dismissAfterFocusLeaves);
    }
    let registrationTimer = ownerWindow?.setTimeout(() => {
      registrationTimer = undefined;
      ownerDocument.addEventListener('click', dismiss, true);
      listening = true;
    }, 0);
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      placementCleanup?.();
      clearOptionalTimer(ownerWindow, registrationTimer);
      clearOptionalTimer(ownerWindow, focusLeaveTimer);
      if (listening) ownerDocument.removeEventListener('click', dismiss, true);
      ownerDocument.removeEventListener('keydown', dismissOnEscape, true);
      if (options.focusLeaveDelay !== undefined) {
        menu.removeEventListener('focusout', dismissAfterFocusLeaves);
      }
      anchor.setAttribute('aria-expanded', 'false');
      ownershipToken.release();
      options.onCleanup?.();
      if (this.anchoredSurfaceCleanups_abyssPrivate.get(menu) === cleanup) {
        this.anchoredSurfaceCleanups_abyssPrivate.delete(menu);
      }
    };
    this.anchoredSurfaceCleanups_abyssPrivate.set(menu, cleanup);
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
    if (this.tasks_abyssPrivate == null) return;
    const initiatingStack = this.state_abyssPrivate.get('taskStack');
    const result = await executeTaskCommand(this.tasks_abyssPrivate, { type: 'delete', ref });
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
