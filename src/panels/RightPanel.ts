import type { App } from 'obsidian';
import { Component, setIcon } from 'obsidian';
import type { AppState } from '../app/AppState';
import type { LinkToken } from '../markdown/links';
import { formatDurationFromMinutes, parseDurationToMinutes } from '../parser/TaskParser';

import type { CalendarSettings } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import { colorForTag } from '../tags/tagColor';
import {
  durationMinutes,
  formatCommentTimeLabel,
  localDate,
  localTime,
  sameTaskNodeRef,
  type CommentRef,
  type CommentTimeContext,
  type CommentTimeContextProvider,
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
import { anchoredPlacement } from '../ui/anchoredPlacement';
import {
  enableAttachmentDrop,
  enableAttachmentPaste,
  insertAtCaret,
  whenPasteSettled,
} from '../ui/attachmentDrop';
import {
  dependencySearchOptions,
  mountDependencySearch,
  type DependencySearchHandle,
} from '../ui/dependencySearch';
import { noInteractionOwnership, type InteractionOwnershipPort } from '../ui/interactionOwnership';
import { LinkEditModal } from '../ui/LinkEditModal';
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
import { renderStatusMarker } from '../ui/StatusMarker';
import { showStatusMenuAt } from '../ui/statusMenu';
import { showTagDropdown } from '../ui/tagDropdown';
import { presentTaskCommandResult, requestTaskCompletion } from '../ui/taskCommandResult';
import {
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
import { rebuildTaskSelection, rootTaskRef, taskNodeLine, taskNodeRef } from '../ui/taskSelection';
import { presentTaskMutationResult } from '../ui/taskUndoNotice';

type TaskLike = TaskSnapshot | SubtaskSnapshot;

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

interface SelectedPlanningResult {
  readonly root: TaskSnapshot;
  readonly changed: boolean;
  readonly target: PlanningTarget;
  readonly initiatingRoot: TaskRef;
  readonly stack: readonly TaskLike[];
  readonly submission: object | undefined;
}

class AsyncEditLifecycle {
  private phase: 'idle' | 'saving' | 'closed' = 'idle';

  begin(): boolean {
    if (this.phase !== 'idle') return false;
    this.phase = 'saving';
    return true;
  }

  retry(): void {
    if (this.phase === 'saving') this.phase = 'idle';
  }

  close(): void {
    this.phase = 'closed';
  }

  isClosed(): boolean {
    return this.phase === 'closed';
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

function sameNodeRef(left: TaskNodeRef, right: TaskNodeRef): boolean {
  if (left.type !== right.type) return false;
  if (left.type === 'task' && right.type === 'task') return sameTaskRef(left.ref, right.ref);
  if (left.type === 'subtask' && right.type === 'subtask') {
    return (
      left.ref.relativeLine === right.ref.relativeLine &&
      left.ref.originalBlock === right.ref.originalBlock &&
      sameNodeRef(left.ref.parent, right.ref.parent)
    );
  }
  return false;
}

function sameCommentRef(left: CommentRef, right: CommentRef): boolean {
  return (
    left.relativeLine === right.relativeLine &&
    left.originalMarkdown === right.originalMarkdown &&
    sameNodeRef(left.parent, right.parent)
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
  if (Number.isFinite(primary) && primary !== 0) return primary;
  if (Number.isFinite(secondary) && secondary !== 0) return secondary;
  return fallback;
}

function finiteNonzeroOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value !== 0 ? value : fallback;
}

function clearOptionalTimer(ownerWindow: Window | null, timer: number | undefined): void {
  if (timer !== undefined) ownerWindow?.clearTimeout(timer);
}

export class RightPanel {
  private readonly completionConfirmationAbortController = new AbortController();
  private el!: HTMLElement;
  private mounted = false;
  private readonly state: AppState;
  private readonly app: App;
  private readonly statusRegistry: StatusRegistry;
  private readonly settings: CalendarSettings | undefined;
  private readonly tasks: TaskApplicationApi | undefined;
  private readonly onRenderHeaderActions: ((actions: HTMLElement) => void) | undefined;
  private readonly onMutationLifecycle: ((event: RightPanelMutationLifecycle) => void) | undefined;
  private readonly commentTimeContext: CommentTimeContextProvider | undefined;
  private readonly interactionOwnership: InteractionOwnershipPort;
  private off?: () => void;
  private offDependencyQueries: (() => void) | undefined;
  private dependencySearch: DependencySearchHandle | undefined;
  private dependencySearchAnchor = '.abyss-dependency-badge-body';
  private dependencyAdding = false;
  private draggingSub: SubtaskSnapshot | null = null;
  private md = new Component();
  private readonly onSuccessfulMutation: ((ref?: TaskRef) => void) | undefined;
  private readonly submittedDrafts = new Map<object, SubmittedDraft>();
  private readonly anchoredSurfaceCleanups = new Map<HTMLElement, () => void>();
  private recurrenceDraftEditor:
    | {
        readonly target: TaskNodeRef;
        readonly handle: RecurrenceEditorHandle;
        readonly surface: HTMLElement;
      }
    | undefined;
  private detachedDrafts: Array<{
    readonly id: number;
    readonly key: string;
    readonly draft: RightPanelDraftState;
    readonly origin: RightPanelDraftBundle['origin'];
  }> = [];
  private nextDetachedDraftId = 0;
  private detachedAnnouncement = '';
  private detachedFocusTimer: number | undefined;

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
    this.state = state;
    this.app = app;
    this.statusRegistry = statusRegistry;
    this.settings = settings;
    this.onSuccessfulMutation = onSuccessfulMutation;
    this.tasks = tasks;
    this.onRenderHeaderActions = onRenderHeaderActions;
    this.onMutationLifecycle = onMutationLifecycle;
    this.commentTimeContext = commentTimeContext;
    this.interactionOwnership = interactionOwnership;
  }

  mount(container: HTMLElement): void {
    this.el = container;
    this.mounted = true;
    this.off = this.state.on('taskStack', (next, previous) => {
      const prior = this.dependencyTask(previous);
      const selected = next[next.length - 1];
      if (
        prior === undefined ||
        selected === undefined ||
        !sameTaskNodeRef(taskNodeRef(prior), taskNodeRef(selected))
      ) {
        this.dependencySearch?.destroy();
        this.dependencySearch = undefined;
        this.dependencyAdding = false;
      }
      this.render();
    });
    this.offDependencyQueries = this.tasks?.queries.subscribe(() => {
      queueMicrotask(() => {
        if (this.mounted) this.refreshDependencies();
      });
    });
    this.el.addEventListener('keydown', this.onDependencyEscape);
    this.el.ownerDocument.addEventListener('focusin', this.onDependencyFocus);
    this.render();
  }

  destroy(): void {
    this.mounted = false;
    this.completionConfirmationAbortController.abort();
    this.off?.();
    this.offDependencyQueries?.();
    this.dependencySearch?.destroy();
    this.dependencySearch = undefined;
    this.el.removeEventListener('keydown', this.onDependencyEscape);
    this.el.ownerDocument.removeEventListener('focusin', this.onDependencyFocus);
    if (this.detachedFocusTimer !== undefined) window.clearTimeout(this.detachedFocusTimer);
    this.clearAnchoredSurfaces();
    this.el.empty();
    this.md.unload();
  }

  captureDraftState(): RightPanelDraftBundle | undefined {
    if (!this.mounted) return undefined;
    const stack = this.state.get('taskStack');
    const task = stack[stack.length - 1];
    const active = this.el.ownerDocument.activeElement;
    const candidates: RightPanelDraftState[] = [];
    const recurrence = this.captureRecurrenceDraft(active);
    if (recurrence != null) candidates.push(recurrence);
    const target = task != null ? this.planningTarget(task) : undefined;
    if (task == null || target == null)
      return candidates.length > 0 ? { entries: candidates } : undefined;
    candidates.push(...this.captureTextDrafts(task, target, active));
    const entries = candidates.filter((candidate) => candidate.hadFocus || isDirtyDraft(candidate));
    if (entries.length === 0) return undefined;
    const origin = this.draftOrigin(stack, task);
    return { entries, ...(origin != null && { origin }) };
  }

  private captureRecurrenceDraft(active: Element | null): RightPanelDraftState | undefined {
    const recurrence = this.recurrenceDraftEditor;
    if (recurrence == null) return undefined;
    const editor = recurrence.handle.captureDraftState();
    const hadFocus = active !== null && recurrence.surface.contains(active);
    if (!editor.dirty && !hadFocus) return undefined;
    return { kind: 'recurrence-editor', target: recurrence.target, editor, hadFocus };
  }

  private captureTextDrafts(
    task: TaskLike,
    target: PlanningTarget,
    active: Element | null,
  ): RightPanelDraftState[] {
    const candidates: RightPanelDraftState[] = [];
    const title = this.el.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit');
    if (title != null) {
      candidates.push({
        kind: 'title',
        target: { type: 'title', target },
        ...textDraftSnapshot(title, task.markdownTitle, active),
      });
    }
    const description = this.el.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit');
    if (description != null) {
      candidates.push({
        kind: 'description',
        target: { type: 'description', target },
        ...textDraftSnapshot(description, task.description ?? '', active),
      });
    }
    const rows = [...this.el.querySelectorAll<HTMLElement>('.abyss-comment-row')];
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
    const newSubtask = this.el.querySelector<HTMLInputElement>('.abyss-subtask-new-input');
    if (newSubtask != null) {
      candidates.push({
        kind: 'new-subtask',
        parent: target,
        ...textDraftSnapshot(newSubtask, '', active),
      });
    }
    const newComment = this.el.querySelector<HTMLTextAreaElement>('.abyss-comment-input');
    if (newComment != null) {
      candidates.push({
        kind: 'new-comment',
        parent: target,
        ...textDraftSnapshot(newComment, '', active),
      });
    }
    return candidates;
  }

  private draftOrigin(stack: readonly TaskLike[], task: TaskLike): RightPanelDraftBundle['origin'] {
    const root = stack[0];
    if (root == null || !('source' in root)) return undefined;
    return {
      taskTitle: task.title,
      filePath: root.source.filePath,
      line: taskNodeLine(root, task),
    };
  }

  captureDraftStateForOwnedTransition(
    consumedOwnedRef: TaskRef,
    successorRef: TaskRef,
    token?: object,
  ): RightPanelDraftBundle | undefined {
    const bundle = this.captureDraftState();
    const submitted =
      token != null
        ? this.submittedDrafts.get(token)
        : [...this.submittedDrafts.values()].find(
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
    const submittedDraft = submitted.draft;
    if (submittedDraft == null || bundle == null) return bundle;
    const entries = bundle.entries.filter(
      (candidate) =>
        draftIdentity(candidate) !== draftIdentity(submittedDraft) ||
        !this.sameDraftPayload(candidate, submittedDraft),
    );
    return entries.length > 0 ? { ...bundle, entries } : undefined;
  }

  private snapshotDraft(draft: RightPanelDraftState): RightPanelDraftState {
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

  private sameDraftPayload(left: RightPanelDraftState, right: RightPanelDraftState): boolean {
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

  private beginDraftSubmission(
    target: PlanningTarget,
    matchesDraft?: (draft: RightPanelDraftState) => boolean,
  ): object | undefined {
    const ref = rootRefForPlanningTarget(target);
    if (
      [...this.submittedDrafts.values()].some((submitted) =>
        submitted.rootAliases.some((alias) => sameTaskRef(alias, ref)),
      )
    ) {
      return undefined;
    }
    const bundle = this.captureDraftState();
    const candidate = matchesDraft != null ? bundle?.entries.find(matchesDraft) : undefined;
    const token = Object.freeze({});
    this.submittedDrafts.set(token, {
      ref: { ...ref },
      rootAliases: [{ ...ref }],
      ...(candidate != null && { draft: this.snapshotDraft(candidate) }),
      origin: bundle?.origin,
      consumed: false,
    });
    this.onMutationLifecycle?.({ phase: 'started', ref: { ...ref }, token });
    return token;
  }

  private matchesBlockCommandDraft(draft: RightPanelDraftState, command: TaskCommand): boolean {
    if (command.type === 'set-description') {
      return draft.kind === 'description' && sameNodeRef(draft.target.target, command.target);
    }
    if (command.type === 'add-subtask') {
      return draft.kind === 'new-subtask' && sameNodeRef(draft.parent, command.parent);
    }
    if (command.type === 'add-comment') {
      return draft.kind === 'new-comment' && sameNodeRef(draft.parent, command.parent);
    }
    if (command.type === 'update-comment') {
      return draft.kind === 'existing-comment' && sameCommentRef(draft.target.ref, command.comment);
    }
    return false;
  }

  private settleDraftSubmission(token: object, result: TaskCommandResult): void {
    const submitted = this.submittedDrafts.get(token);
    if (submitted == null) return;
    this.submittedDrafts.delete(token);
    if (result.type !== 'ok' && submitted.consumed && submitted.draft != null) {
      this.recoverSubmittedDraft(submitted);
    }
    this.onMutationLifecycle?.({ phase: 'settled', ref: { ...submitted.ref }, token });
  }

  private recoverSubmittedDraft(submitted: SubmittedDraft): void {
    const draft = submitted.draft;
    if (draft == null) return;
    const currentSameKey = this.captureDraftState()?.entries.find(
      (candidate) => draftIdentity(candidate) === draftIdentity(draft),
    );
    if (currentSameKey != null && !this.sameDraftPayload(currentSameKey, draft)) {
      this.appendDetachedDraft(draft, submitted.origin);
      return;
    }
    if (currentSameKey != null) return;
    const bundle: RightPanelDraftBundle = {
      entries: [draft],
      ...(submitted.origin !== undefined && { origin: submitted.origin }),
    };
    const root = this.state.get('taskStack')[0];
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
      const restoredFocus = this.restoreDraftEntry(draft, currentRoot, bundle.origin, context);
      if (restoredFocus != null) focusTarget = restoredFocus;
    }
    if (focusTarget != null) {
      const focus = focusTarget;
      focus.focus();
      this.el.ownerDocument.defaultView?.setTimeout(() => {
        if (focus.isConnected) focus.focus();
      }, 0);
    }
  }

  private restoreDraftEntry(
    draft: RightPanelDraftState,
    currentRoot: TaskSnapshot,
    origin?: RightPanelDraftBundle['origin'],
    context = createRightPanelDraftRebaseContext(),
  ): HTMLElement | undefined {
    const rebased = rebaseRightPanelDraft(draft, currentRoot, context);
    if (rebased == null) {
      this.preserveDirtyDraft(draft, origin);
      return undefined;
    }
    const stack = this.state.get('taskStack');
    const task = stack[stack.length - 1];
    if (task == null) {
      this.preserveDirtyDraft(rebased, origin);
      return undefined;
    }
    if (rebased.kind === 'recurrence-editor') {
      return this.restoreRecurrenceDraft(rebased, task, stack, origin);
    }
    const edit = this.restoreTextDraftElement(rebased, task);
    if (edit == null) {
      if (rebased.dirty) this.appendDetachedDraft(rebased, origin);
      return undefined;
    }
    edit.value = rebased.value;
    edit.setSelectionRange(rebased.selectionStart, rebased.selectionEnd);
    return rebased.hadFocus ? edit : undefined;
  }

  private preserveDirtyDraft(
    draft: RightPanelDraftState,
    origin?: RightPanelDraftBundle['origin'],
  ): void {
    if (isDirtyDraft(draft)) this.appendDetachedDraft(draft, origin);
  }

  private restoreRecurrenceDraft(
    draft: Extract<RightPanelDraftState, { readonly kind: 'recurrence-editor' }>,
    task: TaskLike,
    stack: readonly TaskLike[],
    origin?: RightPanelDraftBundle['origin'],
  ): HTMLElement | undefined {
    const chip = this.el.querySelector<HTMLElement>('.abyss-repeat-chip');
    if (chip == null) {
      this.preserveDirtyDraft(draft, origin);
      return undefined;
    }
    this.showRecurrencePopover(chip, task, stack, false);
    const editor = this.recurrenceDraftEditor;
    if (editor == null) return undefined;
    editor.handle.restoreDraftState(draft.editor);
    return draft.hadFocus
      ? (editor.surface.querySelector<HTMLElement>(':focus') ?? undefined)
      : undefined;
  }

  private restoreTextDraftElement(
    rebased: Exclude<RightPanelDraftState, { readonly kind: 'recurrence-editor' }>,
    task: TaskLike,
  ): HTMLInputElement | HTMLTextAreaElement | null {
    if (rebased.kind === 'title') {
      this.clickElement('.abyss-right-title-view');
      return this.el.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit');
    }
    if (rebased.kind === 'description') {
      this.clickElement('.abyss-right-desc-view');
      return this.el.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit');
    }
    if (rebased.kind === 'existing-comment') {
      return this.restoreCommentDraftElement(rebased, task);
    }
    if (rebased.kind === 'new-subtask') {
      this.clickElement('.abyss-subtask-add-row');
      return this.el.querySelector<HTMLInputElement>('.abyss-subtask-new-input');
    }
    return this.el.querySelector<HTMLTextAreaElement>('.abyss-comment-input');
  }

  private restoreCommentDraftElement(
    draft: Extract<RightPanelDraftState, { readonly kind: 'existing-comment' }>,
    task: TaskLike,
  ): HTMLTextAreaElement | null {
    const index = task.comments.findIndex(
      (comment) =>
        comment.ref.relativeLine === draft.target.ref.relativeLine &&
        comment.ref.originalMarkdown === draft.target.ref.originalMarkdown,
    );
    const row = this.el.querySelectorAll<HTMLElement>('.abyss-comment-row')[index];
    const text = row?.querySelector<HTMLElement>('.abyss-comment-text');
    text?.click();
    return row?.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input') ?? null;
  }

  private clickElement(selector: string): void {
    this.el.querySelector<HTMLElement>(selector)?.click();
  }

  detachDraftState(bundle: RightPanelDraftBundle | undefined): void {
    for (const draft of bundle?.entries ?? []) {
      if (isDirtyDraft(draft)) this.appendDetachedDraft(draft, bundle?.origin);
    }
  }

  private appendDetachedDraft(
    draft: RightPanelDraftState,
    origin?: RightPanelDraftBundle['origin'],
  ): void {
    const key = draftIdentity(draft);
    const index = this.detachedDrafts.findIndex((entry) => entry.key === key);
    let id: number;
    if (index >= 0) {
      const existing = this.detachedDrafts[index];
      if (existing == null) return;
      id = existing.id;
      this.detachedDrafts[index] = { id, key, draft, origin: origin ?? existing.origin };
    } else {
      id = ++this.nextDetachedDraftId;
      this.detachedDrafts.push({ id, key, draft, origin });
    }
    this.detachedAnnouncement = `Draft preserved for ${this.detachedDraftLabel(draft, origin)}.`;
    this.renderDetachedDraftTray();
    if (draft.hadFocus) {
      if (this.detachedFocusTimer !== undefined) window.clearTimeout(this.detachedFocusTimer);
      this.detachedFocusTimer = this.el.ownerDocument.defaultView?.setTimeout(() => {
        this.detachedFocusTimer = undefined;
        this.el
          .querySelector<HTMLButtonElement>(
            `[data-abyss-detached-draft="${id}"] .abyss-detached-draft-copy`,
          )
          ?.focus();
      }, 0);
    }
  }

  private detachedDraftLabel(
    draft: RightPanelDraftState,
    origin?: RightPanelDraftBundle['origin'],
  ): string {
    const field = draft.kind.replace(/-/gu, ' ');
    return origin != null ? `${origin.taskTitle}, ${field}` : field;
  }

  private renderDetachedDraftTray(): void {
    this.el.querySelector('.abyss-detached-drafts')?.remove();
    if (this.detachedDrafts.length === 0) return;
    const tray = this.el.createDiv({ cls: 'abyss-detached-drafts' });
    tray.createDiv({ cls: 'abyss-detached-drafts-title', text: 'Unsaved drafts' });
    tray.createDiv({
      cls: 'abyss-detached-drafts-status',
      text: this.detachedAnnouncement,
      attr: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
    });
    for (const entry of this.detachedDrafts) {
      const label = this.detachedDraftLabel(entry.draft, entry.origin);
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
        if (this.detachedFocusTimer !== undefined) {
          window.clearTimeout(this.detachedFocusTimer);
          this.detachedFocusTimer = undefined;
        }
        runAsyncAction(
          (async () => {
            try {
              const clipboard = this.el.ownerDocument.defaultView?.navigator.clipboard;
              if (clipboard == null) throw new Error('clipboard-unavailable');
              await clipboard.writeText(draftPlainText(entry.draft));
              status.textContent = 'Copied.';
            } catch {
              status.textContent = 'Could not copy. The draft is still available.';
            }
            copy.focus();
          })(),
          'Could not complete UI action',
        );
      });
      const discard = detached.createEl('button', {
        cls: 'abyss-detached-draft-discard',
        text: 'Discard',
        attr: { 'aria-label': `Discard unsaved draft for ${label}` },
      });
      discard.addEventListener('click', () => {
        this.detachedDrafts = this.detachedDrafts.filter((candidate) => candidate.id !== entry.id);
        this.renderDetachedDraftTray();
      });
    }
    this.el.prepend(tray);
  }

  private render(): void {
    const search = this.dependencySearch;
    const focused = this.el.ownerDocument.activeElement;
    const searchFocus =
      search?.element.contains(focused) === true
        ? search.element.querySelector<HTMLInputElement>('input')
        : undefined;
    if (search !== undefined) {
      this.anchoredSurfaceCleanups.get(search.element)?.();
      search.element.remove();
    }
    this.md.unload();
    this.md = new Component();
    this.md.load();
    this.clearAnchoredSurfaces();
    this.el.empty();
    const stack = this.state.get('taskStack');
    if (stack.length === 0) {
      this.renderEmpty();
      this.renderDetachedDraftTray();
      return;
    }
    const task = stack[stack.length - 1];
    if (task == null) return;
    this.renderTask(task, stack, this.commentTimeContext?.());
    this.renderDetachedDraftTray();
    if (search !== undefined) {
      this.el.append(search.element);
      search.refresh();
      this.positionDependencySearch();
      searchFocus?.focus({ preventScroll: true });
    }
  }

  /** Wire clipboard paste-to-attach onto an editable textarea, inserting links at the caret. */
  private enablePaste(el: HTMLTextAreaElement, task: TaskLike): void {
    enableAttachmentPaste(el, {
      app: this.app,
      sourcePath: rootTaskRef(task).filePath,
      onInsert: (links) => {
        insertAtCaret(el, links);
      },
    });
  }

  private editLink(task: TaskLike, occ: number, token: LinkToken): void {
    const target = this.planningTarget(task);
    if (target == null) return;
    new LinkEditModal(
      this.app,
      token,
      (newRaw) => {
        runAsyncAction(
          this.executeLinkEdit({ type: 'title', target }, occ, newRaw),
          'Could not complete UI action',
        );
      },
      rootTaskRef(task).filePath,
      this.interactionOwnership,
    ).open();
  }

  /** Edit a target-scoped link through the same revision-confirming task API as title edits. */
  private editLinkInString(
    target: TaskTextTarget,
    occ: number,
    token: LinkToken,
    sourcePath: string,
  ): void {
    new LinkEditModal(
      this.app,
      token,
      (newRaw) => {
        runAsyncAction(this.executeLinkEdit(target, occ, newRaw), 'Could not complete UI action');
      },
      sourcePath,
      this.interactionOwnership,
    ).open();
  }

  private async executeLinkEdit(
    target: TaskTextTarget,
    occurrence: number,
    replacement: string,
  ): Promise<void> {
    if (this.tasks == null) return;
    const result = await this.tasks.execute({ type: 'edit-link', target, occurrence, replacement });
    const node = target.type === 'comment' ? target.ref.parent : target.target;
    this.applyPlanningResult(result, node);
  }

  /** Description block: rendered markdown (clickable links) that becomes a textarea on click. */
  private renderDescriptionBlock(section: HTMLElement, task: TaskLike): void {
    const view = section.createDiv({ cls: 'abyss-right-desc abyss-right-desc-view' });
    enableAttachmentDrop(view, {
      app: this.app,
      sourcePath: rootTaskRef(task).filePath,
      onLinks: (links) => {
        // The closure carries the observed revision; a concurrent edit is surfaced as a
        // structured conflict instead of overwriting the changed block.
        const current = task.description ?? '';
        runAsyncAction(
          this.updateDescription(task, current.trim().length > 0 ? `${current} ${links}` : links),
          'Could not complete UI action',
        );
      },
    });
    const showView = (): void => {
      this.showDescription(view, task);
    };
    view.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a') != null) return; // let links navigate
      this.enterDescriptionEdit(section, view, task, showView);
    });
    showView();
  }

  private enterDescriptionEdit(
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
    this.enablePaste(textarea, task);
    textarea.setCssStyles({ height: `${Math.max(start, 60)}px` });
    window.setTimeout(() => {
      textarea.focus();
    }, 0);
    const lifecycle = new AsyncEditLifecycle();
    const finish = async (save: boolean): Promise<void> => {
      if (!lifecycle.begin()) return;
      await whenPasteSettled(textarea);
      const changed = textarea.value !== (task.description ?? '');
      if (save && changed && !(await this.updateDescription(task, textarea.value))) {
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
      runAsyncAction(finish(true), 'Could not complete UI action');
    });
    textarea.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      runAsyncAction(finish(false), 'Could not complete UI action');
    });
  }

  private showDescription(view: HTMLElement, task: TaskLike): void {
    const description = task.description ?? '';
    if (description.trim().length === 0) {
      view.empty();
      view.addClass('abyss-right-desc-empty');
      view.setText('Add a description…');
      return;
    }
    view.removeClass('abyss-right-desc-empty');
    renderTaskText(view, description, {
      app: this.app,
      sourcePath: rootTaskRef(task).filePath,
      component: this.md,
      onEditLink: (occurrence, token) => {
        const target = this.planningTarget(task);
        if (target != null) {
          this.editLinkInString(
            { type: 'description', target },
            occurrence,
            token,
            rootTaskRef(task).filePath,
          );
        }
      },
    });
  }

  private renderEmpty(): void {
    const empty = this.el.createDiv({ cls: 'abyss-right-empty' });
    const icon = empty.createDiv({ cls: 'abyss-right-empty-icon' });
    setIcon(icon, 'mouse-pointer-click');
    empty.createEl('p', { cls: 'abyss-right-empty-title', text: 'No task selected' });
    empty.createEl('p', {
      cls: 'abyss-right-empty-hint',
      text: 'Click a task to view and edit details',
    });
  }

  private renderTask(
    task: TaskLike,
    stack: TaskLike[],
    commentTimeContext?: CommentTimeContext,
  ): void {
    this.renderBreadcrumb(stack);
    this.renderTaskHeader(task);
    this.renderTaskMetadata(task, stack);
    this.renderDescriptionSection(task);
    this.renderDependencySections();
    this.renderSubtaskSection(task);
    this.renderCommentSection(task, commentTimeContext);
  }

  private renderBreadcrumb(stack: readonly TaskLike[]): void {
    if (stack.length <= 1) return;
    const breadcrumb = this.el.createDiv({ cls: 'abyss-breadcrumb' });
    for (const [index, item] of stack.slice(0, -1).entries()) {
      if (index > 0) breadcrumb.createSpan({ cls: 'abyss-breadcrumb-sep', text: ' › ' });
      const crumb = breadcrumb.createSpan({ cls: 'abyss-breadcrumb-item' });
      renderTaskText(crumb, item.markdownTitle, {
        app: this.app,
        sourcePath: rootTaskRef(item).filePath,
        component: this.md,
        onEditLink: (occurrence, token) => {
          this.editLink(item, occurrence, token);
        },
      });
      crumb.addEventListener('click', () => {
        this.state.set('taskStack', stack.slice(0, index + 1));
      });
    }
  }

  private renderTaskHeader(task: TaskLike): void {
    const header = this.el.createDiv({ cls: 'abyss-right-header' });
    renderStatusMarker(header, {
      task,
      registry: this.statusRegistry,
      onLeftClick: () => {
        runAsyncAction(this.toggleTaskLike(task), 'Could not complete UI action');
      },
      onContextMenu: (event) => {
        event.stopPropagation();
        this.openStatusMenu(event, task);
      },
    });
    this.renderTitleBlock(header, task);
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
      this.renderContextMenu(task, menuBtn);
    });
    this.onRenderHeaderActions?.(headerActions);
  }

  private renderTaskMetadata(task: TaskLike, stack: readonly TaskLike[]): void {
    const chips = this.el.createDiv({ cls: 'abyss-chips-row' });
    this.renderDateChip(chips, task);
    this.renderTimeChip(chips, task);
    this.renderPriorityChip(chips, task);
    this.renderRecurrenceChip(chips, task, stack);
    if (task.planning.scheduled != null) this.renderScheduledChip(chips, task);
    if (task.planning.start != null) this.renderStartChip(chips, task);
    this.renderAddDateMenu(chips, task);
    for (const tag of task.tags) this.renderTagChip(chips, task, tag);
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
      this.showTagInput(chips, task, addTagBtn);
    });
    if (this.tasks !== undefined) {
      chips.createSpan({ cls: 'abyss-chip abyss-dependency-badge' });
      this.updateDependencyBadge();
    }
  }

  private dependencyTask(
    stack: readonly TaskLike[] = this.state.get('taskStack'),
  ): TaskLike | undefined {
    const root = stack[0];
    if (root === undefined) return undefined;
    const resolution = this.tasks?.queries.resolve(rootTaskRef(root));
    let currentStack = stack;
    if (resolution?.type === 'exact') currentStack = rebuildTaskSelection(resolution.task, stack);
    if (resolution?.type === 'rebased')
      currentStack = rebuildTaskSelection(resolution.current, stack, {
        preserveDependencyChanges: resolution.evidence === 'authority-transition',
      });
    return currentStack.length === stack.length ? currentStack[currentStack.length - 1] : undefined;
  }

  private dependencyProjection(): TaskDependencyProjection | undefined {
    const task = this.dependencyTask();
    return task === undefined ? undefined : this.tasks?.queries.dependencies(taskNodeRef(task));
  }

  private updateDependencyBadge(): void {
    const badge = this.el.querySelector<HTMLElement>('.abyss-dependency-badge');
    const projection = this.dependencyProjection();
    if (badge === null || projection === undefined) return;
    const body =
      badge.querySelector<HTMLButtonElement>('.abyss-dependency-badge-body') ??
      this.createDependencyBadgeBody(badge);
    const counts = dependencyCountPresentation(projection);
    body.setAttribute('aria-label', counts.ariaLabel);
    body.title = counts.title;
    body.setAttribute('aria-expanded', String(this.dependencySearch !== undefined));
    body.querySelector('.abyss-dependency-count-blocked-by')?.setText(String(counts.blockedBy));
    body.querySelector('.abyss-dependency-count-blocks')?.setText(String(counts.blocks));
    this.updateDependencyBadgeAdd(badge, projection);
  }

  private createDependencyBadgeBody(badge: HTMLElement): HTMLButtonElement {
    const body = badge.createEl('button', {
      cls: 'abyss-dependency-badge-body',
      attr: { type: 'button', 'aria-haspopup': 'dialog' },
    });
    body.createSpan({ text: 'Dependencies' });
    setIcon(
      body.createSpan({ cls: 'abyss-dependency-lock', attr: { 'aria-hidden': 'true' } }),
      'lock',
    );
    body.createSpan({ cls: 'abyss-dependency-count-blocked-by', attr: { 'aria-hidden': 'true' } });
    body.createSpan({ cls: 'abyss-dependency-divider', attr: { 'aria-hidden': 'true' } });
    body.createSpan({ cls: 'abyss-dependency-count-blocks', attr: { 'aria-hidden': 'true' } });
    body.addEventListener('click', () => {
      this.showDependencySearch();
    });
    return body;
  }

  private updateDependencyBadgeAdd(badge: HTMLElement, projection: TaskDependencyProjection): void {
    const plus = badge.querySelector('.abyss-dependency-badge-add');
    const sectionsExist =
      this.dependencyAdding || projection.blockedBy.length > 0 || projection.blocks.length > 0;
    if (sectionsExist) plus?.remove();
    else if (plus === null) {
      const add = badge.createEl('button', {
        cls: 'abyss-dependency-badge-add',
        text: '+',
        attr: { type: 'button', 'aria-label': 'Add dependency sections', title: 'Add dependency' },
      });
      add.addEventListener('click', () => {
        this.dependencySearch?.close(false);
        this.dependencyAdding = true;
        this.refreshDependencies();
        this.el.querySelector<HTMLButtonElement>('.abyss-dependency-add')?.focus();
      });
    }
  }

  private renderDependencySections(): void {
    const task = this.dependencyTask();
    const projection = this.dependencyProjection();
    if (task === undefined || projection === undefined) return;
    for (const direction of ['blocked-by', 'blocks'] as const) {
      const relations = direction === 'blocked-by' ? projection.blockedBy : projection.blocks;
      if (relations.length === 0 && !this.dependencyAdding) continue;
      this.renderDependencySection(direction, relations, taskNodeRef(task));
    }
  }

  private renderDependencySection(
    direction: DependencyDirection,
    relations: readonly TaskDependencyRelation[],
    current: TaskNodeRef,
  ): void {
    const section = this.el.createDiv({
      cls: 'abyss-right-section abyss-dependency-section',
      attr: { 'data-dependency-direction': direction },
    });
    section
      .createDiv({ cls: 'abyss-right-section-header' })
      .createSpan({ cls: 'abyss-right-section-label', text: dependencyDirectionLabel(direction) });
    const list = section.createDiv({ cls: 'abyss-subtask-list' });
    for (const relation of relations) this.renderDependencyRow(list, relation, direction, current);
    const add = section.createEl('button', {
      cls: 'abyss-subtask-add-row abyss-dependency-add',
      attr: {
        type: 'button',
        'aria-label': `Add dependency: ${dependencyDirectionLabel(direction)}`,
        'aria-haspopup': 'dialog',
      },
    });
    add.createSpan({ cls: 'abyss-subtask-add-icon', text: '+' });
    add.createSpan({ cls: 'abyss-subtask-add-label', text: 'Add dependency' });
    add.addEventListener('click', () => {
      this.showDependencySearch(direction);
    });
    const subtasks = this.el.querySelector('.abyss-subtask-section');
    if (subtasks !== null) this.el.insertBefore(section, subtasks);
  }

  private renderDependencyRow(
    container: HTMLElement,
    relation: TaskDependencyRelation,
    direction: DependencyDirection,
    current: TaskNodeRef,
  ): void {
    const presentation = dependencyRelationPresentation(relation);
    const row = container.createDiv({
      cls: `abyss-subtask-row abyss-dependency-row${presentation.unavailable ? ' is-unavailable' : ''}`,
      attr: { 'data-state': presentation.state },
    });
    if (relation.type === 'resolved')
      renderStatusMarker(row, {
        task: relation.task.node,
        registry: this.statusRegistry,
        interactive: false,
        onLeftClick: () => {},
        onContextMenu: () => {},
      });
    row.createSpan({
      cls: `abyss-subtask-label abyss-dependency-title${presentation.done ? ' is-done' : ''}`,
      text: presentation.title,
      attr: { title: presentation.title },
    });
    if (presentation.unavailable)
      row.createSpan({
        cls: 'abyss-dependency-id',
        text: relation.dependencyId,
        attr: { title: relation.dependencyId },
      });
    const remove = row.createEl('button', {
      cls: 'abyss-dependency-remove',
      attr: {
        type: 'button',
        'aria-label': presentation.removeLabel,
        title: presentation.removeLabel,
      },
    });
    setIcon(remove, 'x');
    const dependent =
      direction === 'blocks' && relation.type === 'resolved' ? relation.task.target : current;
    remove.addEventListener('click', () => {
      if (remove.disabled) return;
      remove.disabled = true;
      runAsyncAction(
        this.executeDependencyCommand({
          type: 'remove-dependency',
          dependent,
          dependencyId: relation.dependencyId,
        }).finally(() => {
          remove.disabled = false;
        }),
        'Could not remove dependency',
      );
    });
  }

  private refreshDependencies(): void {
    this.updateDependencyBadge();
    this.el.querySelectorAll('.abyss-dependency-section').forEach((section) => {
      section.remove();
    });
    this.renderDependencySections();
    this.dependencySearch?.refresh();
    this.positionDependencySearch();
  }

  private showDependencySearch(direction?: DependencyDirection): void {
    this.clearPopovers();
    this.dependencySearchAnchor =
      direction === undefined
        ? '.abyss-dependency-badge-body'
        : `[data-dependency-direction="${direction}"] .abyss-dependency-add`;
    this.dependencySearch = mountDependencySearch(this.el, {
      options: (query) => {
        const current = this.dependencyTask();
        const tasks = this.tasks;
        if (tasks === undefined || current === undefined) return [];
        return dependencySearchOptions({
          current: taskNodeRef(current),
          ...(direction !== undefined && { direction }),
          query,
          tasks: tasks.queries.listNodes(),
          eligibility: (blocker, dependent) =>
            tasks.queries.dependencyEligibility(blocker, dependent),
        });
      },
      select: async (option, chosen) => {
        const current = this.dependencyTask();
        if (current === undefined) return false;
        return this.executeDependencyCommand({
          type: 'add-dependency',
          blocker: chosen === 'blocked-by' ? option.task.target : taskNodeRef(current),
          dependent: chosen === 'blocked-by' ? taskNodeRef(current) : option.task.target,
        });
      },
      onClose: (restoreFocus) => {
        const surface = this.dependencySearch?.element;
        if (surface !== undefined) this.anchoredSurfaceCleanups.get(surface)?.();
        this.dependencySearch = undefined;
        if (this.dependencyAdding) {
          this.dependencyAdding = false;
          this.refreshDependencies();
        }
        this.updateDependencyBadge();
        if (restoreFocus) this.dependencyAnchor()?.focus({ preventScroll: true });
      },
      ownership: this.interactionOwnership,
    });
    this.positionDependencySearch();
    this.updateDependencyBadge();
  }

  private dependencyAnchor(): HTMLElement | null {
    return (
      this.el.querySelector<HTMLElement>(this.dependencySearchAnchor) ??
      this.el.querySelector<HTMLElement>('.abyss-dependency-badge-body')
    );
  }

  private positionDependencySearch(): void {
    const anchor = this.dependencyAnchor();
    if (this.dependencySearch !== undefined && anchor !== null)
      this.positionAnchoredSurface(this.dependencySearch.element, anchor, 'below-start');
  }

  private async executeDependencyCommand(
    command: Extract<TaskCommand, { type: 'add-dependency' | 'remove-dependency' }>,
  ): Promise<boolean> {
    if (this.tasks === undefined) return false;
    let result: TaskCommandResult;
    try {
      result = await this.tasks.execute(command);
    } catch (error) {
      console.error('[abyss-tasks] Dependency action failed', error);
      result = { type: 'io-error', cause: 'dependency-error', contentState: 'unknown' };
    }
    presentTaskMutationResult(this.tasks, result);
    return result.type === 'ok';
  }

  private readonly onDependencyEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.dependencyAdding) return;
    event.preventDefault();
    event.stopPropagation();
    this.dependencyAdding = false;
    this.refreshDependencies();
    this.el.querySelector<HTMLButtonElement>('.abyss-dependency-badge-add')?.focus();
  };

  private readonly onDependencyFocus = (event: FocusEvent): void => {
    if (!this.dependencyAdding || this.dependencySearch !== undefined) return;
    const target = event.target as HTMLElement;
    if (
      target.closest(
        '.abyss-dependency-section, .abyss-dependency-badge, .abyss-dependency-search',
      ) !== null
    )
      return;
    this.dependencyAdding = false;
    this.refreshDependencies();
  };

  private renderTimeChip(container: HTMLElement, task: TaskLike): void {
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
      this.showTimePopover(chip, task);
    });
  }

  private renderDescriptionSection(task: TaskLike): void {
    const descSection = this.el.createDiv({ cls: 'abyss-right-section' });
    const descHeader = descSection.createDiv({ cls: 'abyss-right-section-header' });
    descHeader.createSpan({ cls: 'abyss-right-section-label', text: 'Description' });
    this.renderDescriptionBlock(descSection, task);
  }

  private renderSubtaskSection(task: TaskLike): void {
    const subSection = this.el.createDiv({ cls: 'abyss-right-section abyss-subtask-section' });
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
    for (const sub of task.subtasks) this.renderSubTask(subList, sub, task);
    this.renderAddSubtaskControl(subSection, task);
  }

  private renderAddSubtaskControl(subSection: HTMLElement, task: TaskLike): void {
    const addSubRow = subSection.createDiv({ cls: 'abyss-subtask-add-row' });
    addSubRow.createSpan({ cls: 'abyss-subtask-add-icon', text: '+' });
    addSubRow.createSpan({ cls: 'abyss-subtask-add-label', text: 'Add sub-task' });
    addSubRow.addEventListener('click', () => {
      this.openSubtaskInput(subSection, addSubRow, task);
    });
  }

  private openSubtaskInput(section: HTMLElement, trigger: HTMLElement, task: TaskLike): void {
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
      const succeeded = await this.addSubTask(task, text);
      if (lifecycle.isClosed()) return;
      if (succeeded) close();
      else {
        lifecycle.retry();
        input.focus();
      }
    };
    input.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') runAsyncAction(commit(), 'Could not complete UI action');
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    });
    input.addEventListener('blur', () => {
      window.setTimeout(() => {
        runAsyncAction(commit(), 'Could not complete UI action');
      }, 150);
    });
    input.focus();
  }

  private renderCommentSection(task: TaskLike, commentTimeContext?: CommentTimeContext): void {
    const commentSection = this.el.createDiv({ cls: 'abyss-right-section' });
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
      this.renderComment(commentList, comment, task, commentTimeContext);
    }
    const commentInput = commentSection.createEl('textarea', {
      cls: 'abyss-comment-input',
      attr: { placeholder: 'Write a comment…', rows: '2' },
    });
    enableAttachmentDrop(commentInput, {
      app: this.app,
      sourcePath: rootTaskRef(task).filePath,
      onLinks: (links) => {
        commentInput.value = commentInput.value === '' ? links : `${commentInput.value} ${links}`;
        commentInput.focus();
      },
    });
    this.enablePaste(commentInput, task);
    commentInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = commentInput.value.trim();
        if (text !== '') {
          runAsyncAction(
            this.addComment(task, text, commentList, commentInput),
            'Could not complete UI action',
          );
        }
      }
    });
  }

  private renderTitleBlock(header: HTMLElement, task: TaskLike): void {
    const view = header.createDiv({ cls: 'abyss-right-title abyss-right-title-view' });
    enableAttachmentDrop(view, {
      app: this.app,
      sourcePath: rootTaskRef(task).filePath,
      onLinks: (links) => {
        runAsyncAction(this.appendToTitle(task, links), 'Could not complete UI action');
      },
    });
    const renderView = (): void => {
      renderTaskText(view, task.markdownTitle, {
        app: this.app,
        sourcePath: rootTaskRef(task).filePath,
        component: this.md,
        onEditLink: (occ, token) => {
          this.editLink(task, occ, token);
        },
      });
    };
    renderView();

    // Click on empty space / non-link text enters edit mode.
    view.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a') != null) return; // let links navigate
      this.enterTitleEdit(header, view, task, renderView);
    });
  }

  private enterTitleEdit(
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
    this.enablePaste(ta, task);
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
        const saved = await this.saveTaskTitle(task, ta.value.trim());
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
      runAsyncAction(finish(true), 'Could not complete UI action');
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        runAsyncAction(finish(true), 'Could not complete UI action');
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        runAsyncAction(finish(false), 'Could not complete UI action');
      }
    });
  }

  private renderSubTask(container: HTMLElement, sub: SubtaskSnapshot, parentTask: TaskLike): void {
    const row = container.createDiv({ cls: 'abyss-subtask-row', attr: { draggable: 'true' } });
    this.bindSubtaskDragAndDrop(row, container, sub, parentTask);
    renderStatusMarker(row, {
      task: sub,
      registry: this.statusRegistry,
      onLeftClick: () => {
        runAsyncAction(this.toggleSubTask(sub), 'Could not complete UI action');
      },
      onContextMenu: (event) => {
        event.stopPropagation();
        this.openStatusMenu(event, sub);
      },
    });
    this.renderSubtaskContent(row, sub);
  }

  private bindSubtaskDragAndDrop(
    row: HTMLElement,
    container: HTMLElement,
    sub: SubtaskSnapshot,
    parentTask: TaskLike,
  ): void {
    row.addEventListener('dragstart', (e) => {
      this.draggingSub = sub;
      row.addClass('is-dragging');
      e.dataTransfer?.setData('text/plain', String(sub.ref.relativeLine));
    });

    row.addEventListener('dragend', () => {
      this.draggingSub = null;
      row.removeClass('is-dragging');
      // Clean up any lingering indicators across all rows
      container.querySelectorAll('.drop-above,.drop-below').forEach((el) => {
        el.removeClass('drop-above');
        el.removeClass('drop-below');
      });
    });

    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (this.draggingSub == null || this.draggingSub.ref.relativeLine === sub.ref.relativeLine)
        return;
      const rect = row.getBoundingClientRect();
      const isAbove = e.clientY < rect.top + rect.height / 2;
      // Clear indicators on all siblings first
      container.querySelectorAll('.drop-above,.drop-below').forEach((el) => {
        el.removeClass('drop-above');
        el.removeClass('drop-below');
      });
      row.addClass(isAbove ? 'drop-above' : 'drop-below');
    });

    row.addEventListener('dragleave', (e) => {
      if (!row.contains(e.relatedTarget as Node)) {
        row.removeClass('drop-above');
        row.removeClass('drop-below');
      }
    });

    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const dragged = this.draggingSub;
      if (dragged == null || dragged.ref.relativeLine === sub.ref.relativeLine) return;
      const position = row.hasClass('drop-above') ? 'before' : 'after';
      row.removeClass('drop-above');
      row.removeClass('drop-below');
      runAsyncAction(
        this.reorderSubTask(parentTask, dragged, sub, position),
        'Could not complete UI action',
      );
    });
  }

  private renderSubtaskContent(row: HTMLElement, sub: SubtaskSnapshot): void {
    const content = row.createDiv({ cls: 'abyss-subtask-content' });
    const label = content.createSpan({
      cls: `abyss-subtask-label${sub.status === 'done' ? ' is-done' : ''}`,
    });
    renderTaskText(label, sub.markdownTitle, {
      app: this.app,
      sourcePath: rootTaskRef(sub).filePath,
      component: this.md,
      onEditLink: (occ, token) => {
        this.editLink(sub, occ, token);
      },
    });
    label.addEventListener('click', () => {
      const stack = this.state.get('taskStack');
      this.state.set('taskStack', [...stack, sub]);
    });

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

  private renderComment(
    container: HTMLElement,
    comment: TaskCommentSnapshot,
    task: TaskLike,
    commentTimeContext?: CommentTimeContext,
  ): void {
    const row = container.createDiv({ cls: 'abyss-comment-row' });
    enableAttachmentDrop(row, {
      app: this.app,
      sourcePath: rootTaskRef(task).filePath,
      onLinks: (links) => {
        runAsyncAction(
          this.updateComment(task, comment, `${comment.text} ${links}`.trim()),
          'Could not complete UI action',
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
      this.renderCommentText(row, comment, task, showText);
    };
    showText();
  }

  private renderCommentText(
    row: HTMLElement,
    comment: TaskCommentSnapshot,
    task: TaskLike,
    showText: () => void,
  ): void {
    const textEl = row.createEl('p', { cls: 'abyss-comment-text' });
    renderTaskText(textEl, comment.text, {
      app: this.app,
      sourcePath: rootTaskRef(task).filePath,
      component: this.md,
      onEditLink: (occurrence, token) => {
        this.editLinkInString(
          { type: 'comment', ref: commentRefOf(comment) },
          occurrence,
          token,
          rootTaskRef(task).filePath,
        );
      },
    });
    textEl.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('a') != null) return;
      this.openCommentEditor(row, comment, task, showText);
    });
  }

  private openCommentEditor(
    row: HTMLElement,
    comment: TaskCommentSnapshot,
    task: TaskLike,
    showText: () => void,
  ): void {
    row.querySelector('.abyss-comment-text')?.remove();
    const textarea = row.createEl('textarea', { cls: 'abyss-comment-edit-input' });
    textarea.value = comment.text;
    this.enablePaste(textarea, task);
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
          ? await this.deleteComment(task, comment)
          : await this.updateComment(task, comment, value);
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
        runAsyncAction(finish(), 'Could not complete UI action');
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

  private renderDateChip(container: HTMLElement, task: TaskLike): void {
    const d = task.planning.due ?? task.planning.scheduled;
    let field: 'due' | 'scheduled' = 'due';
    if (task.planning.due == null && task.planning.scheduled != null) field = 'scheduled';
    const chip = container.createEl('button', {
      cls: `abyss-chip${d != null ? '' : ' abyss-chip-empty'}`,
      text: d != null ? `📅 ${this.formatDate(d)}` : '📅 Date',
    });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showDatePopover(chip, task, field);
    });
  }

  /** "Plan" (⏳/`scheduled`) chip — same round-pill/popover pattern as the due-date chip. */
  private renderScheduledChip(container: HTMLElement, task: TaskLike): void {
    const value = task.planning.scheduled;
    const chip = container.createEl('button', {
      cls: `abyss-chip abyss-chip-scheduled${value != null ? '' : ' abyss-chip-empty'}`,
      text: value != null ? `⏳ ${this.formatDate(value)}` : '⏳ Plan',
      attr: { title: 'Set plan date' },
    });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showDatePopover(chip, task, 'scheduled');
    });
  }

  /** "Start" (🛫/`start`) chip — same round-pill/popover pattern as the due-date chip. */
  private renderStartChip(container: HTMLElement, task: TaskLike): void {
    const value = task.planning.start;
    const chip = container.createEl('button', {
      cls: `abyss-chip abyss-chip-start${value != null ? '' : ' abyss-chip-empty'}`,
      text: value != null ? `🛫 ${this.formatDate(value)}` : '🛫 Start',
      attr: { title: 'Set start date' },
    });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showDatePopover(chip, task, 'start');
    });
  }

  /**
   * Compact "+"-style control offering to add whichever of Start/Plan are currently unset —
   * mirrors the "+ tag" button's pattern (small affordance that reveals a chooser) rather than
   * an always-visible placeholder pill. Renders nothing once both are already set (nothing left
   * to offer), and remains extensible for future addable properties (e.g. recurrence).
   */
  private renderAddDateMenu(container: HTMLElement, task: TaskLike): void {
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
      this.showAddDateMenu(addBtn, task, options);
    });
  }

  /** Small menu anchored to the "+ date" button — clicking an option opens showDatePopover. */
  private showAddDateMenu(
    anchor: HTMLElement,
    task: TaskLike,
    options: Array<{ field: 'start' | 'scheduled'; label: string }>,
  ): void {
    const existing = this.el.querySelector('.abyss-add-date-menu');
    if (existing != null) {
      this.removeAnchoredSurface(existing as HTMLElement);
      return;
    }
    this.el.querySelectorAll<HTMLElement>('.abyss-add-date-menu').forEach((element) => {
      this.removeAnchoredSurface(element);
    });
    this.el.querySelectorAll<HTMLElement>('.abyss-context-menu').forEach((element) => {
      this.removeAnchoredSurface(element);
    });

    const menu = this.el.createDiv({
      cls: 'abyss-context-menu abyss-add-date-menu abyss-add-date-menu--compact abyss-popover-anchored',
      attr: { role: 'menu', 'aria-label': 'Add date' },
    });
    for (const opt of options) {
      this.createContextMenuItem(
        menu,
        'abyss-context-item abyss-add-date-menu-item',
        opt.label,
        () => {
          this.removeAnchoredSurface(menu);
          this.showDatePopover(anchor, task, opt.field);
        },
      );
    }

    this.positionAnchoredSurface(menu, anchor, 'below-start');
    this.dismissMenuOnOutsideClick(menu, anchor);
    menu.querySelector<HTMLElement>('.abyss-context-item')?.focus({ preventScroll: true });
  }

  private createContextMenuItem(
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

  private renderPriorityChip(container: HTMLElement, task: TaskLike): void {
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
      this.showPriorityPopover(chip, task);
    });
  }

  private renderRecurrenceChip(
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
      this.showRecurrencePopover(chip, task, stack);
    });
  }

  private showRecurrencePopover(
    anchor: HTMLElement,
    task: TaskLike,
    stack: readonly TaskLike[],
    autofocus = true,
  ): void {
    const existing = this.el.querySelector<HTMLElement>('.abyss-recurrence-popover');
    this.clearPopovers();
    if (existing != null) return;
    anchor.focus();
    const root = stack[0];
    const target = this.planningTarget(task);
    if (root == null || !('source' in root) || target == null) return;

    const popover = this.el.createDiv({
      cls: 'abyss-popover abyss-recurrence-popover abyss-popover-anchored',
      attr: { role: 'dialog', 'aria-modal': 'false' },
    });
    const handle = mountRecurrenceEditor({
      container: popover,
      source: { root, target },
      policy: { removeScheduledDate: this.settings?.recurrence.removeScheduledDate === true },
      ownershipConflict: this.hasRecurrenceOwnershipConflict(task, stack),
      onSubmit: (patch) => this.executePlanningPatch(task, patch),
      onClose: () => {
        this.removeAnchoredSurface(popover);
      },
    });
    this.recurrenceDraftEditor = { target, handle, surface: popover };
    const title = popover.querySelector<HTMLElement>('.abyss-recurrence-title');
    if (title !== null && title.id !== '') popover.setAttribute('aria-labelledby', title.id);
    this.positionAnchoredSurface(popover, anchor, 'below-start');
    const placementCleanup = this.anchoredSurfaceCleanups.get(popover);
    const editorCleanup = (): void => {
      handle.destroy();
      if (this.recurrenceDraftEditor?.surface === popover) this.recurrenceDraftEditor = undefined;
      placementCleanup?.();
      if (this.anchoredSurfaceCleanups.get(popover) === editorCleanup) {
        this.anchoredSurfaceCleanups.delete(popover);
      }
    };
    this.anchoredSurfaceCleanups.set(popover, editorCleanup);
    this.dismissMenuOnOutsideClick(popover, anchor, () => {
      handle.dismiss();
    });
    if (autofocus) this.deferRecurrenceFocus(handle);
  }

  private deferRecurrenceFocus(handle: RecurrenceEditorHandle): void {
    this.el.ownerDocument.defaultView?.setTimeout(() => {
      handle.focus();
    }, 0);
  }

  private hasRecurrenceOwnershipConflict(task: TaskLike, stack: readonly TaskLike[]): boolean {
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

  private renderTagChip(container: HTMLElement, task: TaskLike, tag: string): void {
    const chip = container.createSpan({ cls: 'abyss-chip abyss-chip-tag' });
    const color = this.getTagColor(tag);
    if (color !== undefined && color !== '') {
      chip.setCssProps({ '--abyss-chip-tag-color': color });
    }
    chip.createSpan({ text: tag });
    const x = chip.createEl('button', { cls: 'abyss-chip-remove', text: '×' });
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      runAsyncAction(this.removeTag(task, tag), 'Could not complete UI action');
    });
  }

  private getTagColor(tag: string): string | undefined {
    if (this.settings == null) return undefined;
    return colorForTag(tag, this.settings.tagGroups);
  }

  private clearPopovers(): void {
    this.el.querySelectorAll<HTMLElement>('.abyss-popover').forEach((element) => {
      this.removeAnchoredSurface(element);
    });
  }

  private removeAnchoredSurface(surface: HTMLElement): void {
    if (surface === this.dependencySearch?.element) this.dependencySearch.close(false);
    this.anchoredSurfaceCleanups.get(surface)?.();
    surface.remove();
  }

  private clearAnchoredSurfaces(): void {
    if (this.dependencySearch?.element.parentElement != null) this.dependencySearch.close(false);
    for (const [surface, cleanup] of this.anchoredSurfaceCleanups) {
      cleanup();
      surface.remove();
    }
    this.anchoredSurfaceCleanups.clear();
    this.recurrenceDraftEditor = undefined;
  }

  private openStatusMenu(event: MouseEvent, task: TaskLike): void {
    this.clearAnchoredSurfaces();
    showStatusMenuAt(event, {
      task,
      registry: this.statusRegistry,
      owner: this.md,
      onPickStatus: (symbol) => {
        runAsyncAction(this.setStatus(task, symbol), 'Could not complete UI action');
      },
      onPickPriority: (priority) => {
        runAsyncAction(this.updatePriority(task, priority), 'Could not complete UI action');
      },
      interactionOwnership: this.interactionOwnership,
    });
  }

  /**
   * Small date-picker popover shared by the due/plan/start chips. `field` selects which
   * metadata date is being edited — the popover markup, positioning, and clear-button
   * behavior are identical for all three; only the read/write pair differs.
   */
  private showDatePopover(
    anchor: HTMLElement,
    task: TaskLike,
    field: 'due' | 'scheduled' | 'start' = 'due',
  ): void {
    const already = this.el.querySelector('.abyss-date-popover');
    this.clearPopovers();
    if (already != null) return;

    const previousPopupRole = anchor.getAttribute('aria-haspopup');
    anchor.setAttribute('aria-haspopup', 'dialog');
    const pop = this.el.createDiv({
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
      if (field === 'due')
        runAsyncAction(this.updateDue(task, input.value), 'Could not complete UI action');
      else if (field === 'scheduled')
        runAsyncAction(this.updateScheduled(task, input.value), 'Could not complete UI action');
      else runAsyncAction(this.updateStart(task, input.value), 'Could not complete UI action');
      this.removeAnchoredSurface(pop);
    });
    this.el.ownerDocument.defaultView?.setTimeout(() => {
      input.focus();
    }, 0);

    const clearBtn = inputRow.createEl('button', {
      cls: 'abyss-popover-clear-icon-btn',
      attr: { title: 'Clear date', 'aria-label': 'Clear date' },
    });
    setIcon(clearBtn, 'x');
    clearBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
    clearBtn.addEventListener('click', () => {
      if (field === 'due') runAsyncAction(this.clearDate(task), 'Could not complete UI action');
      else if (field === 'scheduled')
        runAsyncAction(this.clearScheduled(task), 'Could not complete UI action');
      else runAsyncAction(this.clearStart(task), 'Could not complete UI action');
      this.removeAnchoredSurface(pop);
    });
    this.positionAnchoredSurface(pop, anchor, 'below-start');
    this.dismissMenuOnOutsideClick(pop, anchor, undefined, {
      focusLeaveDelay: 200,
      onCleanup: () => {
        if (previousPopupRole !== null && previousPopupRole !== '') {
          anchor.setAttribute('aria-haspopup', previousPopupRole);
        } else anchor.removeAttribute('aria-haspopup');
      },
    });
  }

  private showPriorityPopover(anchor: HTMLElement, task: TaskLike): void {
    const already = this.el.querySelector('.abyss-priority-popover');
    this.clearPopovers();
    if (already != null) return;

    const pop = this.el.createDiv({
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
        this.removeAnchoredSurface(pop);
        anchor.focus({ preventScroll: true });
        runAsyncAction(this.updatePriority(task, opt.value), 'Could not complete UI action');
      });
    }
    this.positionAnchoredSurface(pop, anchor, 'below-start');
    this.dismissMenuOnOutsideClick(pop, anchor);
    selectedOption?.focus({ preventScroll: true });
  }

  private positionAnchoredSurface(
    popover: HTMLElement,
    anchor: HTMLElement,
    preferred: 'below-start' | 'below-end',
  ): void {
    this.anchoredSurfaceCleanups.get(popover)?.();
    const ownerDocument = this.el.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const position = (): void => {
      const boundary = this.el.getBoundingClientRect();
      const floatingRect = popover.getBoundingClientRect();
      const computed = ownerWindow?.getComputedStyle(popover);
      const minWidth = parseFloat(computed?.minWidth ?? '');
      const floatingWidth = dimensionOrFallback(
        floatingRect.width,
        popover.offsetWidth,
        finiteNonzeroOr(minWidth, 160),
      );
      const floatingHeight = dimensionOrFallback(floatingRect.height, popover.offsetHeight, 0);
      const edgeGap = this.cssLengthToPx(
        computed?.getPropertyValue('--abyss-popover-edge-gap') ?? '',
        popover,
        8,
      );
      const anchorGap = this.cssLengthToPx(
        computed?.getPropertyValue('--abyss-popover-anchor-gap') ?? '',
        popover,
        4,
      );
      const placement = anchoredPlacement({
        anchor: anchor.getBoundingClientRect(),
        floating: { width: floatingWidth, height: floatingHeight },
        boundary,
        gap: anchorGap,
        edgeGap,
        preferred,
      });
      // Placement is expressed in viewport coordinates, while the CSS custom
      // properties are interpreted by the popover's actual containing block.
      // The panel remains the clipping boundary above; it is not necessarily
      // the element that establishes the popover's offset coordinates.
      const containingBlock = popover.offsetParent ?? this.el;
      const containingRect = containingBlock.getBoundingClientRect();
      popover.style.setProperty(
        '--abyss-pop-top',
        `${placement.top - containingRect.top - containingBlock.clientTop + containingBlock.scrollTop}px`,
      );
      popover.style.setProperty(
        '--abyss-pop-left',
        `${placement.left - containingRect.left - containingBlock.clientLeft + containingBlock.scrollLeft}px`,
      );
      popover.dataset['side'] = placement.side;
    };
    position();
    ownerWindow?.addEventListener('resize', position);
    ownerDocument.addEventListener('scroll', position, true);
    const cleanup = (): void => {
      ownerWindow?.removeEventListener('resize', position);
      ownerDocument.removeEventListener('scroll', position, true);
      if (this.anchoredSurfaceCleanups.get(popover) === cleanup) {
        this.anchoredSurfaceCleanups.delete(popover);
      }
    };
    this.anchoredSurfaceCleanups.set(popover, cleanup);
  }

  private cssLengthToPx(value: string, relativeTo: HTMLElement, fallback: number): number {
    const trimmed = value.trim();
    if (trimmed === '') return fallback;
    if (trimmed.endsWith('px')) return parseFloat(trimmed);
    if (trimmed.endsWith('rem')) {
      const parsedRootFontSize = parseFloat(
        relativeTo.ownerDocument.defaultView?.getComputedStyle(
          relativeTo.ownerDocument.documentElement,
        ).fontSize ?? '',
      );
      const rootFontSize = finiteNonzeroOr(parsedRootFontSize, 16);
      return parseFloat(trimmed) * rootFontSize;
    }
    if (trimmed.endsWith('em')) {
      const parsedFontSize = parseFloat(
        relativeTo.ownerDocument.defaultView?.getComputedStyle(relativeTo).fontSize ?? '',
      );
      const fontSize = finiteNonzeroOr(parsedFontSize, 16);
      return parseFloat(trimmed) * fontSize;
    }
    const numeric = parseFloat(trimmed);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  private showTagInput(container: HTMLElement, task: TaskLike, anchor: HTMLElement): void {
    const existing = this.el.querySelector<HTMLElement>('.abyss-tag-dropdown-wrap');
    if (existing != null) {
      this.removeAnchoredSurface(existing);
      return;
    }
    const surface = showTagDropdown(
      container,
      this.app,
      (tag) => this.getTagColor(tag),
      (tag) => {
        runAsyncAction(this.addTag(task, tag), 'Could not complete UI action');
      },
      () => {
        this.removeAnchoredSurface(surface);
      },
    );
    anchor.addClass('abyss-chip-add--hidden');
    this.dismissMenuOnOutsideClick(
      surface,
      anchor,
      () => {
        this.removeAnchoredSurface(surface);
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
    await this.saveTaskTitle(task, newText);
  }

  private async saveTaskTitle(task: TaskLike, newText: string): Promise<boolean> {
    const target = this.planningTarget(task);
    if (target == null || this.tasks == null) return false;
    const patch = { markdownTitle: { type: 'set' as const, value: newText } };
    const command = { type: 'patch', target, patch } as TaskCommand;
    const submission = this.beginDraftSubmission(
      target,
      (draft) => draft.kind === 'title' && sameNodeRef(draft.target.target, target),
    );
    if (submission == null) return false;
    let result: TaskCommandResult;
    try {
      result = await this.tasks.execute(command);
    } catch {
      result = { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
    }
    this.applyPlanningResult(result, target, undefined, submission);
    this.settleDraftSubmission(submission, result);
    return result.type === 'ok';
  }

  private async appendToTitle(task: TaskLike, text: string): Promise<void> {
    const target = this.planningTarget(task);
    if (target == null || this.tasks == null) return;
    const result = await this.tasks.execute({ type: 'append-title', target, markdown: text });
    this.applyPlanningResult(result, target);
  }

  private async updateDescription(task: TaskLike, newDesc: string): Promise<boolean> {
    const target = this.planningTarget(task);
    if (target == null) return false;
    return this.executeBlockCommand(
      {
        type: 'set-description',
        target,
        text: newDesc.trim().length > 0 ? newDesc.replace(/\r\n/gu, '\n') : null,
      },
      target,
    );
  }

  private async addSubTask(task: TaskLike, text: string): Promise<boolean> {
    const parent = this.planningTarget(task);
    if (parent == null) return false;
    return this.executeBlockCommand({ type: 'add-subtask', parent, text }, parent);
  }

  private toggleSubTask(sub: SubtaskSnapshot): Promise<void> {
    return this.toggleTaskLike(sub);
  }

  private toggleTaskLike(task: TaskLike): Promise<void> {
    return requestTaskCompletion(
      task,
      () => this.commitTaskToggle(task),
      this.interactionOwnership,
      this.completionConfirmationAbortController.signal,
    );
  }

  private async commitTaskToggle(task: TaskLike): Promise<void> {
    const target = this.planningTarget(task);
    if (target == null || this.tasks == null) return;
    const result = await this.tasks.execute({ type: 'toggle-completion', target });
    this.applyPlanningResult(result, target);
  }

  private async addComment(
    task: TaskLike,
    text: string,
    _commentList: HTMLElement,
    inputEl: HTMLTextAreaElement,
  ): Promise<boolean> {
    const parent = this.planningTarget(task);
    if (parent == null) return false;
    const committed = await this.executeBlockCommand({ type: 'add-comment', parent, text }, parent);
    if (committed) {
      inputEl.value = '';
      inputEl.focus();
    }
    return committed;
  }

  private async updateComment(
    _task: TaskLike,
    comment: TaskCommentSnapshot,
    newText: string,
  ): Promise<boolean> {
    const ref = commentRefOf(comment);
    return this.executeBlockCommand(
      { type: 'update-comment', comment: ref, text: newText },
      ref.parent,
    );
  }

  private async deleteComment(_task: TaskLike, comment: TaskCommentSnapshot): Promise<boolean> {
    const ref = commentRefOf(comment);
    return this.executeBlockCommand({ type: 'delete-comment', comment: ref }, ref.parent);
  }

  private async executeBlockCommand(
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
    if (this.tasks == null) return false;
    const initiatingStack = this.state.get('taskStack');
    const submission = this.beginDraftSubmission(target, (draft) =>
      this.matchesBlockCommandDraft(draft, command),
    );
    if (submission == null) return false;
    let result: TaskCommandResult;
    try {
      result = await this.tasks.execute(command);
    } catch {
      result = { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
    }
    this.applyPlanningResult(result, target, initiatingStack, submission);
    this.settleDraftSubmission(submission, result);
    if (result.type === 'ok') this.presentBlockUndo(result);
    return result.type === 'ok';
  }

  private presentBlockUndo(result: Extract<TaskCommandResult, { readonly type: 'ok' }>): void {
    const tasks = this.tasks;
    if (tasks === undefined) return;
    presentTaskMutationResult(
      {
        queries: tasks.queries,
        execute: async (command) => {
          const initiatingStack = this.state.get('taskStack');
          const restored = await tasks.execute(command);
          if (restored.type === 'ok' && command.type === 'restore-subtask') {
            this.applyPlanningResult(restored, command.parent, initiatingStack);
          }
          return restored;
        },
      },
      result,
    );
  }

  private async updateDue(task: TaskLike, date: string): Promise<void> {
    await this.executePlanningPatch(task, { due: { type: 'set', value: localDate(date) } });
  }

  private async clearDate(task: TaskLike): Promise<void> {
    await this.executePlanningPatch(
      task,
      task.planning.due != null || task.planning.scheduled == null
        ? { due: { type: 'clear' } }
        : { scheduled: { type: 'clear' } },
    );
  }

  private async updateScheduled(task: TaskLike, date: string): Promise<void> {
    await this.executePlanningPatch(task, {
      scheduled: { type: 'set', value: localDate(date) },
    });
  }

  private async clearScheduled(task: TaskLike): Promise<void> {
    await this.executePlanningPatch(task, { scheduled: { type: 'clear' } });
  }

  private async updateStart(task: TaskLike, date: string): Promise<void> {
    await this.executePlanningPatch(task, { start: { type: 'set', value: localDate(date) } });
  }

  private async clearStart(task: TaskLike): Promise<void> {
    await this.executePlanningPatch(task, { start: { type: 'clear' } });
  }

  private planningTarget(task: TaskLike): PlanningTarget | undefined {
    return taskNodeRef(task);
  }

  private async executePlanningPatch(task: TaskLike, patch: TaskPatch): Promise<TaskCommandResult> {
    const target = this.planningTarget(task);
    if (target == null || this.tasks == null) {
      return { type: 'io-error', cause: 'application-unavailable', contentState: 'unchanged' };
    }
    const submission = this.beginDraftSubmission(target, (draft) => {
      if (patch.recurrence === undefined && patch.onCompletion === undefined) return false;
      return draft.kind === 'recurrence-editor' && sameNodeRef(draft.target, target);
    });
    if (submission == null) {
      return { type: 'io-error', cause: 'repository-error', contentState: 'unchanged' };
    }
    let result: TaskCommandResult;
    try {
      if (target.type === 'task') {
        result = await this.tasks.execute({ type: 'patch', target, patch });
      } else {
        if (patch.duration !== undefined) {
          result = { type: 'io-error', cause: 'unsupported-field', contentState: 'unchanged' };
        } else {
          const subtaskPatch: SubtaskPatch = patch;
          result = await this.tasks.execute({ type: 'patch', target, patch: subtaskPatch });
        }
      }
    } catch {
      result = { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
    }
    this.applyPlanningResult(result, target, undefined, submission);
    this.settleDraftSubmission(submission, result);
    return result;
  }

  private applyPlanningResult(
    result: TaskCommandResult,
    target: PlanningTarget,
    initiatingStack?: readonly TaskLike[],
    submission?: object,
  ): void {
    presentTaskCommandResult(result);
    if (result.type !== 'ok' || result.outcome.type !== 'task') return;
    const stack = this.state.get('taskStack');
    const initiatingRoot = rootRefForPlanningTarget(target);
    if (this.isSelectedPlanningResult(stack, initiatingStack, initiatingRoot)) {
      this.applySelectedPlanningResult({
        root: result.outcome.task,
        changed: result.changed,
        target,
        initiatingRoot,
        stack,
        submission,
      });
    }
    if (result.changed) this.onSuccessfulMutation?.(result.outcome.task.ref);
  }

  private isSelectedPlanningResult(
    stack: readonly TaskLike[],
    initiatingStack: readonly TaskLike[] | undefined,
    initiatingRoot: TaskRef,
  ): boolean {
    const selected = stack[0];
    if (selected == null || !sameTaskRef(rootTaskRef(selected), initiatingRoot)) return false;
    return initiatingStack === undefined || stack === initiatingStack;
  }

  private applySelectedPlanningResult(result: SelectedPlanningResult): void {
    const { root, changed, target, initiatingRoot, stack, submission } = result;
    const draft =
      changed && submission != null
        ? this.captureDraftStateForOwnedTransition(initiatingRoot, root.ref, submission)
        : this.captureDraftState();
    const selection =
      target.type === 'subtask'
        ? rebuildPlanningTargetStack(root, target)
        : rebuildTaskSelection(root, stack);
    this.state.set('taskStack', selection);
    this.restoreDraftState(draft, root);
  }

  private async updateDuration(task: TaskSnapshot, minutes: number): Promise<void> {
    try {
      await this.executePlanningPatch(task, {
        duration: { type: 'set', value: durationMinutes(minutes) },
      });
    } catch {
      // Invalid input leaves the existing duration unchanged.
    }
  }

  private async clearDuration(task: TaskSnapshot): Promise<void> {
    await this.executePlanningPatch(task, { duration: { type: 'clear' } });
  }

  private setStatus(task: TaskLike, symbol: string): Promise<void> {
    if (this.statusRegistry.bySymbol(symbol)?.type === 'done') {
      return requestTaskCompletion(
        task,
        () => this.commitStatus(task, symbol),
        this.interactionOwnership,
        this.completionConfirmationAbortController.signal,
      );
    }
    return this.commitStatus(task, symbol);
  }

  private async commitStatus(task: TaskLike, symbol: string): Promise<void> {
    const target = this.planningTarget(task);
    if (target == null || this.tasks == null) return;
    const result = await this.tasks.execute({ type: 'set-status', target, symbol });
    this.applyPlanningResult(result, target);
  }

  private async updatePriority(task: TaskLike, priority: string): Promise<void> {
    if (!['A', 'B', 'C', 'D', 'E', 'F'].includes(priority)) return;
    const target = this.planningTarget(task);
    if (target == null || this.tasks == null) return;
    const patch: TaskPatch = {
      priority: { type: 'set', value: priority as TaskPriority },
    };
    await this.executePlanningPatch(task, patch);
  }

  private async removeTag(task: TaskLike, tag: string): Promise<void> {
    await this.executePlanningPatch(task, { tags: { remove: [tag] } });
  }

  private async addTag(task: TaskLike, tag: string): Promise<void> {
    await this.executePlanningPatch(task, { tags: { add: [tag] } });
  }

  private showTimePopover(anchor: HTMLElement, task: TaskLike): void {
    const already = this.el.querySelector('.abyss-time-popover');
    this.clearPopovers();
    if (already != null) return;

    const pop = this.el.createDiv({
      cls: 'abyss-popover abyss-time-popover abyss-popover-anchored',
      attr: { role: 'dialog', 'aria-label': 'Set time and duration' },
    });

    const inputRow = pop.createDiv({ cls: 'abyss-popover-input-row' });
    const input = inputRow.createEl('input', {
      cls: 'abyss-time-input',
      attr: { type: 'time', value: task.planning.time ?? '' },
    });
    this.el.ownerDocument.defaultView?.setTimeout(() => {
      input.focus();
    }, 0);
    input.addEventListener('change', () => {
      runAsyncAction(
        this.updateTime(task, input.value).then(() => {
          this.removeAnchoredSurface(pop);
        }),
        'Could not complete UI action',
      );
    });

    const clearBtn = inputRow.createEl('button', {
      cls: 'abyss-popover-clear-icon-btn',
      attr: { title: 'Clear time', 'aria-label': 'Clear time' },
    });
    setIcon(clearBtn, 'x');
    clearBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
    clearBtn.addEventListener('click', () => {
      runAsyncAction(
        this.updateTime(task, '').then(() => {
          this.removeAnchoredSurface(pop);
        }),
        'Could not complete UI action',
      );
    });

    if ('source' in task) this.renderDurationInputs(pop, task);

    this.positionAnchoredSurface(pop, anchor, 'below-start');
    this.dismissMenuOnOutsideClick(pop, anchor, undefined, { focusLeaveDelay: 200 });
  }

  private renderDurationInputs(popover: HTMLElement, task: TaskSnapshot): void {
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
          ? this.clearDuration(task)
          : this.updateDuration(task, minutes);
      runAsyncAction(
        update.then(() => {
          this.removeAnchoredSurface(popover);
        }),
        'Could not complete UI action',
      );
    });
    const clearButton = row.createEl('button', {
      cls: 'abyss-popover-clear-icon-btn',
      attr: { title: 'Clear duration', 'aria-label': 'Clear duration' },
    });
    setIcon(clearButton, 'x');
    clearButton.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });
    clearButton.addEventListener('click', () => {
      runAsyncAction(
        this.clearDuration(task).then(() => {
          this.removeAnchoredSurface(popover);
        }),
        'Could not complete UI action',
      );
    });
  }

  private async updateTime(task: TaskLike, time: string): Promise<void> {
    try {
      await this.executePlanningPatch(task, {
        time: time === '' ? { type: 'clear' } : { type: 'set', value: localTime(time) },
      });
    } catch {
      // Invalid input leaves the existing time unchanged.
    }
  }

  private renderContextMenu(task: TaskLike, anchor: HTMLElement): void {
    const existing = this.el.querySelector<HTMLElement>('.abyss-task-context-menu');
    if (existing != null) {
      this.removeAnchoredSurface(existing);
      return;
    }
    // Close any other open context menus
    this.el.querySelectorAll<HTMLElement>('.abyss-context-menu').forEach((element) => {
      this.removeAnchoredSurface(element);
    });

    const menu = this.el.createDiv({
      cls: 'abyss-context-menu abyss-task-context-menu abyss-popover-anchored',
      attr: { role: 'menu', 'aria-label': 'Task actions' },
    });

    const editRepeat = this.createContextMenuItem(
      menu,
      'abyss-context-item',
      'Edit repeat…',
      () => {
        this.removeAnchoredSurface(menu);
        this.showRecurrencePopover(anchor, task, this.recurrenceStackFor(task));
      },
    );

    this.createContextMenuItem(
      menu,
      'abyss-context-item abyss-context-danger',
      this.planningTarget(task)?.type === 'subtask' ? 'Delete sub-task' : 'Delete task',
      () => {
        this.removeAnchoredSurface(menu);
        runAsyncAction(this.deleteTask(task), 'Could not complete UI action');
      },
    );

    this.createContextMenuItem(menu, 'abyss-context-item', 'Open in file', () => {
      this.removeAnchoredSurface(menu);
      const root = this.state.get('taskStack')[0];
      if (root != null && 'source' in root)
        runAsyncAction(
          openInFile(this.app, root, taskNodeLine(root, task)),
          'Could not complete UI action',
        );
    });

    this.positionAnchoredSurface(menu, anchor, 'below-end');
    this.dismissMenuOnOutsideClick(menu, anchor);
    editRepeat.focus({ preventScroll: true });
  }

  private recurrenceStackFor(task: TaskLike): readonly TaskLike[] {
    const root = this.state.get('taskStack')[0];
    const target = this.planningTarget(task);
    if (root == null || !('source' in root) || target == null) return [];
    return rebuildPlanningTargetStack(root, target);
  }

  /** Shared outside-click dismissal for small anchored menus (context menu, add-date menu). */
  private dismissMenuOnOutsideClick(
    menu: HTMLElement,
    anchor: HTMLElement,
    dismissSurface: () => void = () => {
      this.removeAnchoredSurface(menu);
    },
    options: { focusLeaveDelay?: number; onCleanup?: () => void } = {},
  ): void {
    const ownerDocument = this.el.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const placementCleanup = this.anchoredSurfaceCleanups.get(menu);
    const ownershipToken = this.interactionOwnership.acquire({ blocksShortcuts: true });
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
      if (this.anchoredSurfaceCleanups.get(menu) === cleanup) {
        this.anchoredSurfaceCleanups.delete(menu);
      }
    };
    this.anchoredSurfaceCleanups.set(menu, cleanup);
  }

  private async deleteTask(task: TaskLike): Promise<void> {
    const target = this.planningTarget(task);
    if (target == null) return;
    if (target.type === 'subtask') {
      await this.executeBlockCommand(
        { type: 'delete-subtask', subtask: target.ref },
        target.ref.parent,
      );
      return;
    }
    await this.deleteRootTask(target.ref);
  }

  private async deleteRootTask(ref: TaskRef): Promise<void> {
    if (this.tasks == null) return;
    const initiatingStack = this.state.get('taskStack');
    let result: TaskCommandResult;
    try {
      result = await this.tasks.execute({ type: 'delete', ref });
    } catch {
      result = { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
    }
    presentTaskCommandResult(result);
    const selectedRoot = this.state.get('taskStack')[0];
    const selectedRef = selectedRoot != null ? rootTaskRef(selectedRoot) : undefined;
    if (
      result.type === 'ok' &&
      result.outcome.type === 'deleted' &&
      this.state.get('taskStack') === initiatingStack &&
      selectedRef != null &&
      sameTaskRef(selectedRef, ref)
    ) {
      this.state.set('taskStack', []);
    }
  }

  private async reorderSubTask(
    parentTask: TaskLike,
    moved: SubtaskSnapshot,
    target: SubtaskSnapshot,
    position: 'before' | 'after',
  ): Promise<void> {
    const parent = this.planningTarget(parentTask);
    const movedTarget = this.planningTarget(moved);
    const targetNode = this.planningTarget(target);
    if (parent == null || movedTarget?.type !== 'subtask' || targetNode?.type !== 'subtask') return;
    await this.executeBlockCommand(
      {
        type: 'reorder-subtask',
        subtask: movedTarget.ref,
        target: targetNode.ref,
        placement: position,
      },
      parent,
    );
  }

  private formatDate(d: string): string {
    const today = window.moment().format('YYYY-MM-DD');
    const tomorrow = window.moment().add(1, 'day').format('YYYY-MM-DD');
    if (d === today) return 'Today';
    if (d === tomorrow) return 'Tomorrow';
    return window.moment(d, 'YYYY-MM-DD').format('D MMM');
  }
}
