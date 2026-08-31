import type { App } from 'obsidian';
import { Component, setIcon } from 'obsidian';
import type { AppState } from '../app/AppState';
import type { LinkToken } from '../parser/links';
import { formatDurationFromMinutes, parseDurationToMinutes } from '../parser/TaskParser';

import type { CalendarSettings } from '../settings/types';
import type { StatusRegistry } from '../status/StatusRegistry';
import { colorForTag } from '../tags/tagColor';
import type {
  DependencyInspection,
  DependencyLinkValidation,
  DependencyLinkValidationInput,
  DependencyProjectionPort,
} from '../tasks';
import {
  durationMinutes,
  formatCommentTimeLabel,
  localDate,
  localTime,
  projectDependencyCandidates,
  type CommentRef,
  type CommentTimeContext,
  type CommentTimeContextProvider,
  type DependencyCandidate,
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
import { anchoredPlacement } from '../ui/anchoredPlacement';
import {
  enableAttachmentDrop,
  enableAttachmentPaste,
  insertAtCaret,
  whenPasteSettled,
} from '../ui/attachmentDrop';
import { renderDependencyBadge } from '../ui/dependencyPresentation';
import {
  createInspectorFieldPresenter,
  markInspectorEntity,
  renderInspectorControlField,
  renderInspectorField,
  type InspectorFieldKind,
} from '../ui/inspector/InspectorFields';
import type { InspectorSelection } from '../ui/inspector/InspectorSelection';
import { deriveInspectorSelection } from '../ui/inspector/InspectorSelection';
import {
  bindInspectorShell,
  type PersistentInspectorShellOptions,
} from '../ui/inspector/InspectorShell';
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
import { renderStatusMarker } from '../ui/StatusMarker';
import { showStatusMenuAt } from '../ui/statusMenu';
import { showTagDropdown } from '../ui/tagDropdown';
import { presentTaskCommandResult, requestTaskCompletion } from '../ui/taskCommandResult';
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

type TaskLike = TaskSnapshot | SubtaskSnapshot;

interface DependencyCandidateGroups {
  readonly project: readonly TaskSnapshot[];
  readonly other: readonly TaskSnapshot[];
}

/** Legacy grouped inputs are normalized at this UI boundary into one flat projection. */
export type DependencyCandidateProvider = (
  dependent: TaskSnapshot,
) => DependencyCandidateGroups | readonly DependencyCandidate[];

function isFlatDependencyCandidateSource(
  value: ReturnType<DependencyCandidateProvider> | undefined,
): value is readonly DependencyCandidate[] {
  return Array.isArray(value);
}

function dependencyValidationReason(validation: DependencyLinkValidation): string | undefined {
  if (validation.type === 'allowed') return undefined;
  const diagnostic = validation.diagnostics[0];
  if (!diagnostic) return 'Dependency is unavailable';
  if (diagnostic.type === 'cycle') return 'Would create a cycle';
  if (diagnostic.type === 'self-edge') return 'Task cannot block itself';
  if (diagnostic.type === 'duplicate-id') return 'Duplicate ID';
  if (diagnostic.type === 'missing-prerequisite') return 'Missing prerequisite';
  return 'Dependency data unavailable';
}

export interface RightPanelMutationLifecycle {
  readonly phase: 'started' | 'settled';
  readonly ref: TaskRef;
  readonly token: object;
}

/** PanelView owns compact-pane visibility; RightPanel owns Task draft inspection. */
export interface TaskInspectorShellPort {
  readonly narrow: () => boolean;
  readonly returnFocus: () => HTMLElement | null;
  readonly onRequestClose: () => void;
  /** Modal owners may deliberately close instead of retaining their private draft. */
  readonly isDirty?: () => boolean;
}

interface SubmittedDraft {
  readonly ref: TaskRef;
  readonly rootAliases: TaskRef[];
  readonly draft?: RightPanelDraftState;
  readonly origin: RightPanelDraftBundle['origin'];
  consumed: boolean;
}

interface TaskFieldBinding {
  readonly field: InspectorFieldKind;
  readonly instanceKey: string;
  readonly row?: HTMLElement;
  readonly control?: HTMLElement;
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
    if (!child) break;
    stack.push(child);
    current = child;
  }
  return stack;
}

function commentRefOf(comment: TaskCommentSnapshot): CommentRef {
  return comment.ref;
}

export class RightPanel {
  private readonly completionConfirmationAbortController = new AbortController();
  private el!: HTMLElement;
  private off?: () => void;
  private inspectorOff?: () => void;
  private inspectorCleanup?: () => void;
  private draggingSub: SubtaskSnapshot | null = null;
  private md = new Component();
  private onSuccessfulMutation?: (ref?: TaskRef) => void;
  private submittedDrafts = new Map<object, SubmittedDraft>();
  private anchoredSurfaceCleanups = new Map<HTMLElement, () => void>();
  private recurrenceDraftEditor?: {
    readonly target: TaskNodeRef;
    readonly handle: RecurrenceEditorHandle;
    readonly surface: HTMLElement;
  };
  private detachedDrafts: Array<{
    readonly id: number;
    readonly key: string;
    readonly draft: RightPanelDraftState;
    readonly origin: RightPanelDraftBundle['origin'];
  }> = [];
  private nextDetachedDraftId = 0;
  private detachedAnnouncement = '';
  private detachedFocusTimer: number | undefined;
  private dependencyOff?: () => void;
  private dependencyEditorSequence = 0;
  private renderedTaskStack: readonly TaskLike[] = [];
  private hiddenTaskDraft?: { readonly ref: TaskRef; readonly bundle: RightPanelDraftBundle };

  constructor(
    private state: AppState,
    private app: App,
    private statusRegistry: StatusRegistry,
    private settings?: CalendarSettings,
    onSuccessfulMutation?: (ref?: TaskRef) => void,
    private tasks?: TaskApplicationApi,
    private onRenderHeaderActions?: (actions: HTMLElement) => void,
    private onMutationLifecycle?: (event: RightPanelMutationLifecycle) => void,
    private commentTimeContext?: CommentTimeContextProvider,
    private readonly interactionOwnership: InteractionOwnershipPort = noInteractionOwnership,
    private readonly dependencyProjection?: DependencyProjectionPort,
    private readonly dependencyCandidates?: DependencyCandidateProvider,
    private readonly inspectorRenderer?: (
      host: HTMLElement,
      selection: InspectorSelection,
    ) => (() => void) | undefined,
    private readonly taskInspectorShell?: TaskInspectorShellPort,
  ) {
    this.onSuccessfulMutation = onSuccessfulMutation;
  }

  mount(container: HTMLElement): void {
    this.el = container;
    this.off = this.state.on('taskStack', () => this.render());
    this.inspectorOff = this.state.on('inspectorSelection', () => this.render());
    this.dependencyOff = this.dependencyProjection?.subscribe((event) => {
      const root = this.state.get('taskStack')[0];
      if (
        !root ||
        !('source' in root) ||
        !event.affected.some((ref) => sameTaskRef(ref, root.ref))
      ) {
        return;
      }
      const dependencyEditorWasOpen = this.el.querySelector('[data-dependency-editor]') !== null;
      const draft = this.captureDraftState();
      this.render();
      this.restoreDraftState(draft, root);
      if (dependencyEditorWasOpen) {
        this.el.querySelector<HTMLButtonElement>('[data-dependency-trigger]')?.click();
      }
    });
    this.render();
  }

  destroy(): void {
    this.completionConfirmationAbortController.abort();
    this.off?.();
    this.inspectorOff?.();
    this.dependencyOff?.();
    this.inspectorCleanup?.();
    this.inspectorCleanup = undefined;
    if (this.detachedFocusTimer !== undefined) window.clearTimeout(this.detachedFocusTimer);
    this.clearAnchoredSurfaces();
    this.el?.empty();
    this.md.unload();
  }

  /** Project/Work Note projections changed without a task-index event. */
  refresh(): void {
    const inspector = this.state.get('inspectorSelection');
    const stack = this.state.get('taskStack');
    const root = stack[0];
    const draft = inspector?.type === 'task' ? this.captureDraftStateForStack(stack) : undefined;
    this.render();
    if (draft && root && 'source' in root) this.restoreDraftState(draft, root);
  }

  captureDraftState(): RightPanelDraftBundle | undefined {
    return this.captureDraftStateForStack(this.state.get('taskStack'));
  }

  private captureDraftStateForStack(stack: readonly TaskLike[]): RightPanelDraftBundle | undefined {
    if (!this.el) return undefined;
    const task = stack[stack.length - 1];
    const target = task ? this.planningTarget(task) : undefined;
    const active = this.el.ownerDocument.activeElement;
    const recurrence = this.recurrenceDraftEditor;
    const candidates: RightPanelDraftState[] = [];
    if (recurrence) {
      const editor = recurrence.handle.captureDraftState();
      const hadFocus = active !== null && recurrence.surface.contains(active);
      if (editor.dirty || hadFocus) {
        candidates.push({
          kind: 'recurrence-editor',
          target: recurrence.target,
          editor,
          hadFocus,
        });
      }
    }
    if (!task || !target) return candidates.length > 0 ? { entries: candidates } : undefined;

    const textDraft = (element: HTMLInputElement | HTMLTextAreaElement, base: string) => ({
      value: element.value,
      selectionStart: element.selectionStart ?? 0,
      selectionEnd: element.selectionEnd ?? 0,
      hadFocus: active === element,
      dirty: element.value !== base,
    });
    const title = this.el.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit');
    if (title) {
      candidates.push({
        kind: 'title',
        target: { type: 'title', target },
        ...textDraft(title, task.markdownTitle),
      });
    }
    const description = this.el.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit');
    if (description) {
      candidates.push({
        kind: 'description',
        target: { type: 'description', target },
        ...textDraft(description, task.description ?? ''),
      });
    }
    const rows = [...this.el.querySelectorAll<HTMLElement>('.abyss-comment-row')];
    for (const [index, row] of rows.entries()) {
      const commentEdit = row.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input');
      if (!commentEdit) continue;
      const comment = task.comments[index];
      if (comment) {
        candidates.push({
          kind: 'existing-comment',
          target: { type: 'comment', ref: comment.ref },
          ...textDraft(commentEdit, comment.text),
        });
      }
    }
    const newSubtask = this.el.querySelector<HTMLInputElement>('.abyss-subtask-new-input');
    if (newSubtask) {
      candidates.push({ kind: 'new-subtask', parent: target, ...textDraft(newSubtask, '') });
    }
    const newComment = this.el.querySelector<HTMLTextAreaElement>('.abyss-comment-input');
    if (newComment) {
      candidates.push({ kind: 'new-comment', parent: target, ...textDraft(newComment, '') });
    }
    const entries = candidates.filter((candidate) => candidate.hadFocus || isDirtyDraft(candidate));
    const root = stack[0];
    return entries.length > 0
      ? {
          entries,
          ...(root && 'source' in root
            ? {
                origin: {
                  taskTitle: task.title,
                  filePath: root.source.filePath,
                  line: taskNodeLine(root, task),
                },
              }
            : {}),
        }
      : undefined;
  }

  captureDraftStateForOwnedTransition(
    consumedOwnedRef: TaskRef,
    successorRef: TaskRef,
    token?: object,
  ): RightPanelDraftBundle | undefined {
    const bundle = this.captureDraftState();
    const submitted = token
      ? this.submittedDrafts.get(token)
      : [...this.submittedDrafts.values()].find(
          (candidate) =>
            !candidate.consumed &&
            candidate.rootAliases.some((alias) => sameTaskRef(alias, consumedOwnedRef)),
        );
    if (
      !submitted ||
      submitted.consumed ||
      !submitted.rootAliases.some((alias) => sameTaskRef(alias, consumedOwnedRef))
    ) {
      return bundle;
    }
    if (!submitted.rootAliases.some((alias) => sameTaskRef(alias, successorRef))) {
      submitted.rootAliases.push({ ...successorRef });
    }
    submitted.consumed = true;
    if (!submitted.draft || !bundle) return bundle;
    const entries = bundle.entries.filter(
      (candidate) =>
        draftIdentity(candidate) !== draftIdentity(submitted.draft!) ||
        !this.sameDraftPayload(candidate, submitted.draft!),
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
    const semanticEditor = (editor: typeof left.editor) => [
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
    const candidate = matchesDraft ? bundle?.entries.find(matchesDraft) : undefined;
    const token = Object.freeze({});
    this.submittedDrafts.set(token, {
      ref: { ...ref },
      rootAliases: [{ ...ref }],
      ...(candidate && { draft: this.snapshotDraft(candidate) }),
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
    if (!submitted) return;
    this.submittedDrafts.delete(token);
    if (result.type !== 'ok' && submitted.consumed && submitted.draft) {
      this.recoverSubmittedDraft(submitted);
    }
    this.onMutationLifecycle?.({ phase: 'settled', ref: { ...submitted.ref }, token });
  }

  private recoverSubmittedDraft(submitted: SubmittedDraft): void {
    const draft = submitted.draft;
    if (!draft) return;
    const currentSameKey = this.captureDraftState()?.entries.find(
      (candidate) => draftIdentity(candidate) === draftIdentity(draft),
    );
    if (currentSameKey && !this.sameDraftPayload(currentSameKey, draft)) {
      this.appendDetachedDraft(draft, submitted.origin);
      return;
    }
    if (currentSameKey) return;
    const root = this.state.get('taskStack')[0];
    if (root && 'source' in root) {
      this.restoreDraftState({ entries: [draft], origin: submitted.origin }, root);
      return;
    }
    this.detachDraftState({ entries: [draft], origin: submitted.origin });
  }

  restoreDraftState(bundle: RightPanelDraftBundle | undefined, currentRoot: TaskSnapshot): void {
    if (!bundle) return;
    let focusTarget: HTMLElement | undefined;
    const context = createRightPanelDraftRebaseContext();
    for (const draft of bundle.entries) {
      const restoredFocus = this.restoreDraftEntry(draft, currentRoot, bundle.origin, context);
      if (restoredFocus) focusTarget = restoredFocus;
    }
    if (focusTarget) {
      focusTarget.focus();
      this.el.ownerDocument.defaultView?.setTimeout(() => {
        if (focusTarget?.isConnected) focusTarget.focus();
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
    if (!rebased) {
      if (isDirtyDraft(draft)) this.appendDetachedDraft(draft, origin);
      return undefined;
    }
    const stack = this.state.get('taskStack');
    const task = stack[stack.length - 1];
    if (!task) {
      if (isDirtyDraft(rebased)) this.appendDetachedDraft(rebased, origin);
      return undefined;
    }
    if (rebased.kind === 'recurrence-editor') {
      const chip = this.el.querySelector<HTMLElement>('.abyss-repeat-chip');
      if (!chip) {
        if (isDirtyDraft(rebased)) this.appendDetachedDraft(rebased, origin);
        return undefined;
      }
      this.showRecurrencePopover(chip, task, stack, false);
      this.recurrenceDraftEditor?.handle.restoreDraftState(rebased.editor);
      return rebased.hadFocus
        ? (this.recurrenceDraftEditor?.surface.querySelector<HTMLElement>(':focus') ?? undefined)
        : undefined;
    }

    let edit: HTMLInputElement | HTMLTextAreaElement | null;
    if (rebased.kind === 'title') {
      this.el.querySelector<HTMLElement>('.abyss-right-title-view')?.click();
      edit = this.el.querySelector<HTMLTextAreaElement>('.abyss-right-title-edit');
    } else if (rebased.kind === 'description') {
      this.el.querySelector<HTMLElement>('.abyss-right-desc-view')?.click();
      edit = this.el.querySelector<HTMLTextAreaElement>('.abyss-right-desc-edit');
    } else if (rebased.kind === 'existing-comment') {
      const index = task.comments.findIndex(
        (comment) =>
          comment.ref.relativeLine === rebased.target.ref.relativeLine &&
          comment.ref.originalMarkdown === rebased.target.ref.originalMarkdown,
      );
      const row = this.el.querySelectorAll<HTMLElement>('.abyss-comment-row')[index];
      row?.querySelector<HTMLElement>('.abyss-comment-text')?.click();
      edit = row?.querySelector<HTMLTextAreaElement>('.abyss-comment-edit-input') ?? null;
    } else if (rebased.kind === 'new-subtask') {
      this.el.querySelector<HTMLElement>('.abyss-subtask-add-row')?.click();
      edit = this.el.querySelector<HTMLInputElement>('.abyss-subtask-new-input');
    } else {
      edit = this.el.querySelector<HTMLTextAreaElement>('.abyss-comment-input');
    }
    if (!edit) {
      if (rebased.dirty) this.appendDetachedDraft(rebased, origin);
      return undefined;
    }
    edit.value = rebased.value;
    edit.setSelectionRange(rebased.selectionStart, rebased.selectionEnd);
    return rebased.hadFocus ? edit : undefined;
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
      const existing = this.detachedDrafts[index]!;
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
    return origin ? `${origin.taskTitle}, ${field}` : field;
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
        void (async () => {
          try {
            const clipboard = this.el.ownerDocument.defaultView?.navigator.clipboard;
            if (!clipboard) throw new Error('clipboard-unavailable');
            await clipboard.writeText(draftPlainText(entry.draft));
            status.textContent = 'Copied.';
          } catch {
            status.textContent = 'Could not copy. The draft is still available.';
          }
          copy.focus();
        })();
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
    const inspector = this.state.get('inspectorSelection');
    if (
      this.renderedTaskStack.length > 0 &&
      this.state.get('mode') === 'projects' &&
      inspector?.type !== 'task'
    ) {
      const root = this.renderedTaskStack[0];
      const bundle = this.captureDraftStateForStack(this.renderedTaskStack);
      if (root && bundle) this.hiddenTaskDraft = { ref: rootTaskRef(root), bundle };
    }
    this.inspectorCleanup?.();
    this.inspectorCleanup = undefined;
    this.md.unload();
    this.md = new Component();
    this.md.load();
    this.clearAnchoredSurfaces();
    this.el.empty();
    this.el.removeClass('abyss-inspector-shell', 'abyss-entity-inspector');
    delete this.el.dataset['inspectorEntity'];
    delete this.el.dataset['inspectorShell'];
    delete this.el.dataset['inspectorLayout'];
    this.el.removeAttribute('role');
    this.el.removeAttribute('aria-label');
    this.el.removeAttribute('aria-modal');
    const stack = this.state.get('taskStack');
    const activeInspector =
      inspector?.type === 'work-note'
        ? deriveInspectorSelection({
            project: { type: 'project', path: inspector.projectPath },
            activeScope: 'work-notes',
            workNote: inspector,
          })
        : inspector;
    if (
      this.state.get('mode') === 'projects' &&
      activeInspector &&
      activeInspector.type !== 'task'
    ) {
      const rendered = this.inspectorRenderer?.(this.el, activeInspector);
      if (rendered) {
        this.inspectorCleanup = rendered;
        this.renderedTaskStack = [];
        return;
      }
    }
    if (stack.length === 0) {
      this.renderedTaskStack = [];
      this.renderEmpty();
      this.renderDetachedDraftTray();
      return;
    }
    const task = stack[stack.length - 1]!;
    this.renderTask(task, stack, this.commentTimeContext?.());
    this.inspectorCleanup = this.bindTaskInspectorShell();
    this.renderedTaskStack = [...stack];
    const root = stack[0];
    if (
      root &&
      this.hiddenTaskDraft &&
      rootTaskRef(root).filePath === this.hiddenTaskDraft.ref.filePath &&
      rootTaskRef(root).line === this.hiddenTaskDraft.ref.line
    ) {
      const draft = this.hiddenTaskDraft;
      if ('source' in root) this.restoreDraftState(draft.bundle, root);
      queueMicrotask(() => {
        if (this.hiddenTaskDraft === draft) this.hiddenTaskDraft = undefined;
      });
    }
    this.renderDetachedDraftTray();
  }

  /** Wire clipboard paste-to-attach onto an editable textarea, inserting links at the caret. */
  private enablePaste(el: HTMLTextAreaElement, task: TaskLike): void {
    enableAttachmentPaste(el, {
      app: this.app,
      sourcePath: rootTaskRef(task).filePath,
      onInsert: (links) => insertAtCaret(el, links),
    });
  }

  private editLink(task: TaskLike, occ: number, token: LinkToken, initiator?: HTMLElement): void {
    const target = this.planningTarget(task);
    if (!target) return;
    new LinkEditModal(
      this.app,
      token,
      (newRaw) => {
        void this.executeLinkEdit(
          { type: 'title', target },
          occ,
          newRaw,
          this.taskFieldBinding('relations', 'relations', initiator),
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
    initiator?: HTMLElement,
  ): void {
    new LinkEditModal(
      this.app,
      token,
      (newRaw) =>
        void this.executeLinkEdit(
          target,
          occ,
          newRaw,
          this.taskFieldBinding('relations', 'relations', initiator),
        ),
      sourcePath,
      this.interactionOwnership,
    ).open();
  }

  private async executeLinkEdit(
    target: TaskTextTarget,
    occurrence: number,
    replacement: string,
    binding: TaskFieldBinding,
  ): Promise<void> {
    if (!this.tasks) return;
    const result = await this.runTaskFieldCommand(binding, () =>
      this.tasks!.execute({ type: 'edit-link', target, occurrence, replacement }),
    );
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
        const cur = task.description ?? '';
        void this.updateDescription(task, cur.trim() ? `${cur} ${links}` : links);
      },
    });
    let showView: () => void = () => {};

    const enterEdit = (): void => {
      const start = view.offsetHeight;
      view.hide();
      const ta = section.createEl('textarea', { cls: 'abyss-right-desc abyss-right-desc-edit' });
      view.insertAdjacentElement('afterend', ta);
      ta.value = task.description ?? '';
      this.enablePaste(ta, task);
      ta.setCssStyles({ height: `${Math.max(start, 60)}px` });
      window.setTimeout(() => ta.focus(), 0);
      let done = false;
      const finish = async (save: boolean): Promise<void> => {
        if (done) return;
        // Let any in-flight paste insert its link into the value before we save/remove.
        await whenPasteSettled(ta);
        if (done) return;
        if (save && ta.value !== (task.description ?? '')) {
          const saved = await this.updateDescription(task, ta.value);
          if (!saved) {
            ta.focus();
            return;
          }
        }
        done = true;
        ta.remove();
        view.show();
        showView();
      };
      ta.addEventListener('blur', () => void finish(true));
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          void finish(false);
        }
      });
    };

    showView = (): void => {
      const desc = task.description ?? '';
      if (desc.trim()) {
        view.removeClass('abyss-right-desc-empty');
        renderTaskText(view, desc, {
          app: this.app,
          sourcePath: rootTaskRef(task).filePath,
          component: this.md,
          onEditLink: (occ, token, initiator) => {
            const target = this.planningTarget(task);
            if (target) {
              this.editLinkInString(
                { type: 'description', target },
                occ,
                token,
                rootTaskRef(task).filePath,
                initiator,
              );
            }
          },
        });
      } else {
        view.empty();
        view.addClass('abyss-right-desc-empty');
        view.setText('Add a description…');
      }
    };

    view.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a')) return; // let links navigate
      enterEdit();
    });
    showView();
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

  private bindTaskInspectorShell(): () => void {
    const shell: PersistentInspectorShellOptions = {
      label: 'Task details',
      narrow: this.taskInspectorShell?.narrow() ?? false,
      returnFocus: () => this.taskInspectorShell?.returnFocus() ?? null,
      onRequestClose: () => this.taskInspectorShell?.onRequestClose(),
      isDirty: () =>
        this.taskInspectorShell?.isDirty?.() ??
        this.captureDraftState()?.entries.some((entry) => isDirtyDraft(entry)) ??
        false,
    };
    return bindInspectorShell(this.el, shell);
  }

  private renderTask(
    task: TaskLike,
    stack: TaskLike[],
    commentTimeContext?: CommentTimeContext,
  ): void {
    markInspectorEntity(this.el, 'task');
    // Breadcrumb — shows only the parent path (current task is in the title input)
    if (stack.length > 1) {
      const breadcrumb = this.el.createDiv({ cls: 'abyss-breadcrumb' });
      const parents = stack.slice(0, -1);
      parents.forEach((item, idx) => {
        if (idx > 0) breadcrumb.createEl('span', { cls: 'abyss-breadcrumb-sep', text: ' › ' });
        const crumb = breadcrumb.createEl('span', { cls: 'abyss-breadcrumb-item' });
        renderTaskText(crumb, item.markdownTitle, {
          app: this.app,
          sourcePath: rootTaskRef(item).filePath,
          component: this.md,
          onEditLink: (occ, token, initiator) => this.editLink(item, occ, token, initiator),
        });
        crumb.addEventListener('click', () => {
          this.state.set('taskStack', stack.slice(0, idx + 1));
        });
      });
    }

    // Header
    const header = this.el.createDiv({ cls: 'abyss-right-header' });
    const status = renderInspectorControlField(
      header,
      'status',
      'Status',
      'abyss-right-status-field',
    );
    renderStatusMarker(status.content, {
      task,
      registry: this.statusRegistry,
      ...('source' in task && this.dependencyProjection
        ? { completionDecision: this.dependencyProjection.evaluateCompletion(task) }
        : {}),
      onLeftClick: () => void this.toggleTaskLike(task),
      onContextMenu: (event) => {
        event.stopPropagation();
        this.openStatusMenu(event, task);
      },
    });
    const title = renderInspectorControlField(header, 'title', 'Title', 'abyss-right-title-field');
    this.renderTitleBlock(title.content, task);

    const headerActions = header.createDiv({ cls: 'abyss-right-header-actions' });

    // More actions menu button
    const currentTask = task;
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
      this.renderContextMenu(currentTask, menuBtn);
    });
    this.onRenderHeaderActions?.(headerActions);

    // Metadata chips — available for both TaskSnapshot and SubtaskSnapshot
    {
      const chips = this.el.createDiv({ cls: 'abyss-chips-row' });

      // Date chip (due-first display; if scheduled is set, prefer showing scheduled as the
      // "when this sits on the calendar" chip, matching the due-centric anchor-priority rule)
      this.renderDateChip(
        renderInspectorControlField(chips, 'date', 'Date', 'abyss-task-chip-field', 'date-due')
          .content,
        task,
      );

      // Combined time + duration chip (duration only applies to top-level TaskSnapshot, not SubtaskSnapshot)
      const duration = 'source' in task ? task.planning.duration : undefined;
      let timeChipText = '⏰ Time';
      let timeChipLabel = 'Set time and duration';
      if (task.planning.time) {
        timeChipText = duration
          ? `⏰ ${task.planning.time} · ${formatDurationFromMinutes(duration)}`
          : `⏰ ${task.planning.time}`;
        timeChipLabel = duration
          ? `Change time, currently ${task.planning.time}, duration ${String(duration)} minutes`
          : `Change time, currently ${task.planning.time}, no duration`;
      }
      const timeChip = renderInspectorControlField(
        chips,
        'date',
        'Time',
        'abyss-task-chip-field',
        'date-time',
      ).content.createEl('button', {
        cls: `abyss-chip abyss-chip-time${task.planning.time ? '' : ' abyss-chip-empty'}`,
        text: timeChipText,
        attr: {
          title: task.planning.time ? 'Change time and duration' : 'Set time and duration',
          'aria-label': timeChipLabel,
          'aria-haspopup': 'dialog',
          'aria-expanded': 'false',
        },
      });
      timeChip.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showTimePopover(timeChip, task, this.taskFieldBinding('date', 'date-time', timeChip));
      });

      // Priority chip
      this.renderPriorityChip(
        renderInspectorControlField(
          chips,
          'priority',
          'Priority',
          'abyss-task-chip-field',
          'priority',
        ).content,
        task,
      );

      if ('source' in task && this.dependencyProjection) {
        this.renderDependencyChip(
          renderInspectorControlField(
            chips,
            'dependencies',
            'Dependencies',
            'abyss-task-chip-field',
            'dependencies',
          ).content,
          task,
        );
      }

      // Repeat chip and its one shared editor. TaskModal inherits this through RightPanel reuse.
      this.renderRecurrenceChip(
        renderInspectorControlField(
          chips,
          'recurrence',
          'Recurrence',
          'abyss-task-chip-field',
          'recurrence',
        ).content,
        task,
        stack,
      );

      // Scheduled ("Plan") and Start chips — once SET, rendered as a normal round-pill,
      // same style as the date/time/priority chips above; clicking it opens the same small
      // date-picker popover used for the due-date chip (showDatePopover, generalized with a
      // `field` param below). While UNSET, no placeholder pill clutters the main row —
      // instead a compact "+" control (mirroring the "+ tag" button's pattern) offers to
      // add whichever of Start/Plan are currently unset; picking one opens the exact same
      // popover. This intentionally reverses the "always-visible placeholder pill" unset
      // treatment from the previous round after live testing showed it cluttered the row.
      const planField = renderInspectorControlField(
        chips,
        'date',
        'Plan',
        'abyss-task-chip-field',
        'date-plan',
      );
      if (task.planning.scheduled) this.renderScheduledChip(planField.content, task);
      const startField = renderInspectorControlField(
        chips,
        'date',
        'Start',
        'abyss-task-chip-field',
        'date-start',
      );
      if (task.planning.start) this.renderStartChip(startField.content, task);
      this.renderAddDateMenu(chips, task);

      // Tag chips
      const tags = task.tags ?? [];
      for (const tag of tags) {
        this.renderTagChip(chips, task, tag);
      }
      // Add tag
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
    }

    const progress = renderInspectorField(this.el, 'progress', 'Progress', 'abyss-right-section');
    progress.label.addClass('abyss-right-section-label');
    const totalSubtasks = task.subtasks.length;
    const completedSubtasks = task.subtasks.filter((subtask) => subtask.status === 'done').length;
    progress.content.setText(
      totalSubtasks === 0
        ? 'No sub-tasks'
        : `${String(completedSubtasks)} of ${String(totalSubtasks)} sub-tasks complete`,
    );

    const relations = renderInspectorField(
      this.el,
      'relations',
      'Relations',
      'abyss-right-section',
    );
    relations.label.addClass('abyss-right-section-label');
    if ('source' in task && this.dependencyProjection) {
      const count = this.dependencyInspection(task).relations.length;
      relations.content.setText(count === 0 ? 'No dependencies' : `${String(count)} dependencies`);
    } else {
      relations.content.setText('No relations');
    }

    // Description
    const description = renderInspectorField(
      this.el,
      'description',
      'Description',
      'abyss-right-section',
    );
    description.label.addClass('abyss-right-section-label');
    this.renderDescriptionBlock(description.content, task);

    // Sub-tasks
    const subtasks = renderInspectorField(this.el, 'subtasks', 'Sub-tasks', 'abyss-right-section');
    subtasks.label.addClass('abyss-right-section-label');
    const subSection = subtasks.content;
    const subHeader = subSection.createDiv({ cls: 'abyss-right-section-header' });
    const totalSubs = task.subtasks?.length ?? 0;
    if (totalSubs > 0) {
      const doneSubs = task.subtasks.filter((s) => s.status === 'done').length;
      subHeader.createEl('span', {
        cls: 'abyss-right-section-count',
        text: `${doneSubs}/${totalSubs}`,
      });
    }

    const subList = subSection.createDiv({ cls: 'abyss-subtask-list' });
    for (const sub of task.subtasks ?? []) {
      this.renderSubTask(subList, sub, task);
    }

    // Inline add-subtask row at the bottom of the subtask list
    const addSubRow = subSection.createDiv({ cls: 'abyss-subtask-add-row' });
    addSubRow.createEl('span', { cls: 'abyss-subtask-add-icon', text: '+' });
    addSubRow.createEl('span', { cls: 'abyss-subtask-add-label', text: 'Add sub-task' });
    addSubRow.addEventListener('click', () => {
      addSubRow.addClass('abyss-subtask-add-row--hidden');
      const input = subSection.createEl('input', {
        cls: 'abyss-subtask-new-input',
        attr: { type: 'text', placeholder: 'New sub-task…' },
      });
      input.focus();
      let closed = false;
      let saving = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        input.remove();
        addSubRow.removeClass('abyss-subtask-add-row--hidden');
      };
      const commit = async (): Promise<void> => {
        if (closed || saving) return;
        const text = input.value.trim();
        if (!text) {
          close();
          return;
        }
        saving = true;
        const succeeded = await this.addSubTask(task, text);
        saving = false;
        if (closed) return;
        if (succeeded) close();
        else input.focus();
      };
      input.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') void commit();
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
      });
      // Delay to allow click on commit button before blur fires
      input.addEventListener('blur', () => window.setTimeout(() => void commit(), 150));
    });

    // Comments
    const comments = renderInspectorField(this.el, 'comments', 'Comments', 'abyss-right-section');
    comments.label.addClass('abyss-right-section-label');
    const commentSection = comments.content;
    const commentHeader = commentSection.createDiv({ cls: 'abyss-right-section-header' });
    commentHeader.append(comments.label);
    const commentCount = task.comments?.length ?? 0;
    if (commentCount > 0) {
      commentHeader.createEl('span', {
        cls: 'abyss-right-section-count',
        text: String(commentCount),
      });
    }

    const commentList = commentSection.createDiv({ cls: 'abyss-comment-list' });
    for (const comment of task.comments ?? []) {
      this.renderComment(commentList, comment, task, commentTimeContext);
    }

    // Always-visible textarea — Enter submits, Shift+Enter inserts newline
    const commentInput = commentSection.createEl('textarea', {
      cls: 'abyss-comment-input',
      attr: { placeholder: 'Write a comment…', rows: '2' },
    });
    enableAttachmentDrop(commentInput, {
      app: this.app,
      sourcePath: rootTaskRef(task).filePath,
      onLinks: (links) => {
        commentInput.value = commentInput.value ? `${commentInput.value} ${links}` : links;
        commentInput.focus();
      },
    });
    this.enablePaste(commentInput, task);
    commentInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const text = commentInput.value.trim();
        if (text) {
          void this.addComment(task, text, commentList, commentInput);
        }
      }
    });
  }

  private renderTitleBlock(header: HTMLElement, task: TaskLike): void {
    const view = header.createDiv({ cls: 'abyss-right-title abyss-right-title-view' });
    enableAttachmentDrop(view, {
      app: this.app,
      sourcePath: rootTaskRef(task).filePath,
      onLinks: (links) => void this.appendToTitle(task, links),
    });
    const renderView = (): void => {
      renderTaskText(view, task.markdownTitle, {
        app: this.app,
        sourcePath: rootTaskRef(task).filePath,
        component: this.md,
        onEditLink: (occ, token, initiator) => this.editLink(task, occ, token, initiator),
      });
    };
    renderView();

    // Click on empty space / non-link text enters edit mode.
    view.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('a')) return; // let links navigate
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

    let done = false;
    let saving = false;
    const finish = async (save: boolean): Promise<void> => {
      if (done || saving) return;
      // Let any in-flight paste insert its link into the value before we save/remove.
      await whenPasteSettled(ta);
      if (done || saving) return;
      // Carry the current height back to the read-mode block so the stretch persists.
      view.setCssStyles({ height: `${ta.offsetHeight}px` });
      if (save && ta.value !== task.markdownTitle) {
        saving = true;
        const saved = await this.saveTaskTitle(task, ta.value.trim());
        saving = false;
        if (!saved) {
          ta.focus();
          return;
        }
      }
      done = true;
      ta.remove();
      view.show();
      renderView();
    };
    ta.addEventListener('blur', () => void finish(true));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void finish(true);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        void finish(false);
      }
    });
  }

  private renderSubTask(container: HTMLElement, sub: SubtaskSnapshot, parentTask: TaskLike): void {
    const row = container.createDiv({ cls: 'abyss-subtask-row', attr: { draggable: 'true' } });

    // ── Drag-and-drop ─────────────────────────────────────────
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
      if (!this.draggingSub || this.draggingSub.ref.relativeLine === sub.ref.relativeLine) return;
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
      if (!dragged || dragged.ref.relativeLine === sub.ref.relativeLine) return;
      const position = row.hasClass('drop-above') ? 'before' : 'after';
      row.removeClass('drop-above');
      row.removeClass('drop-below');
      void this.reorderSubTask(parentTask, dragged, sub, position);
    });

    // ── Status marker ─────────────────────────────────────────
    renderStatusMarker(row, {
      task: sub,
      registry: this.statusRegistry,
      onLeftClick: () => void this.toggleSubTask(sub),
      onContextMenu: (ev) => {
        ev.stopPropagation();
        this.openStatusMenu(ev, sub);
      },
    });

    // ── Content ───────────────────────────────────────────────
    const content = row.createDiv({ cls: 'abyss-subtask-content' });
    const label = content.createEl('span', {
      cls: `abyss-subtask-label${sub.status === 'done' ? ' is-done' : ''}`,
    });
    renderTaskText(label, sub.markdownTitle, {
      app: this.app,
      sourcePath: rootTaskRef(sub).filePath,
      component: this.md,
      onEditLink: (occ, token, initiator) => this.editLink(sub, occ, token, initiator),
    });
    label.addEventListener('click', () => {
      const stack = this.state.get('taskStack');
      this.state.set('taskStack', [...stack, sub]);
    });

    // Progress + comment count indicators
    const subCount = sub.subtasks?.length ?? 0;
    const commentCount = sub.comments?.length ?? 0;
    if (subCount > 0 || commentCount > 0) {
      const subMeta = content.createDiv({ cls: 'abyss-subtask-meta' });
      if (subCount > 0) {
        const done = sub.subtasks.filter((s) => s.status === 'done').length;
        subMeta.createEl('span', { cls: 'abyss-subtask-progress', text: `${done}/${subCount}` });
      }
      if (commentCount > 0) {
        subMeta.createEl('span', {
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
      onLinks: (links) => void this.updateComment(task, comment, `${comment.text} ${links}`.trim()),
    });
    if (comment.timestamp && commentTimeContext) {
      row.createEl('span', {
        cls: 'abyss-comment-date',
        text: formatCommentTimeLabel({ timestamp: comment.timestamp, ...commentTimeContext }),
      });
    }
    let showText: () => void = () => {};

    const enterEdit = (): void => {
      row.querySelector('.abyss-comment-text')?.remove();
      const textarea = row.createEl('textarea', { cls: 'abyss-comment-edit-input' });
      textarea.value = comment.text;
      this.enablePaste(textarea, task);
      textarea.focus();
      textarea.select();
      let saved = false;
      const finish = async (): Promise<void> => {
        if (saved) return;
        // Let any in-flight paste insert its link into the value before we save/remove.
        await whenPasteSettled(textarea);
        if (saved) return;
        const val = textarea.value.trim();
        if (val === comment.text) {
          saved = true;
          textarea.remove();
          showText();
          return;
        }
        let committed: boolean;
        if (val === '') {
          committed = await this.deleteComment(task, comment);
        } else {
          committed = await this.updateComment(task, comment, val);
        }
        if (!committed) {
          textarea.focus();
          return;
        }
        saved = true;
        textarea.remove();
      };
      textarea.addEventListener('blur', () => window.setTimeout(() => void finish(), 150));
      textarea.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          textarea.blur();
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          saved = true;
          textarea.remove();
          showText();
        }
      });
    };

    showText = (): void => {
      const textEl = row.createEl('p', { cls: 'abyss-comment-text' });
      renderTaskText(textEl, comment.text, {
        app: this.app,
        sourcePath: rootTaskRef(task).filePath,
        component: this.md,
        onEditLink: (occ, token, initiator) => {
          const ref = commentRefOf(comment);
          if (ref)
            this.editLinkInString(
              { type: 'comment', ref },
              occ,
              token,
              rootTaskRef(task).filePath,
              initiator,
            );
        },
      });
      textEl.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('a')) return; // let links navigate
        enterEdit();
      });
    };

    showText();
  }

  private renderDateChip(container: HTMLElement, task: TaskLike): void {
    const d = task.planning.due ?? task.planning.scheduled;
    let field: 'due' | 'scheduled' = 'due';
    if (!task.planning.due && task.planning.scheduled) field = 'scheduled';
    const chip = container.createEl('button', {
      cls: `abyss-chip${d ? '' : ' abyss-chip-empty'}`,
      text: d ? `📅 ${this.formatDate(d)}` : '📅 Date',
    });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showDatePopover(chip, task, field, this.taskFieldBinding('date', 'date-due', chip));
    });
  }

  /** "Plan" (⏳/`scheduled`) chip — same round-pill/popover pattern as the due-date chip. */
  private renderScheduledChip(container: HTMLElement, task: TaskLike): void {
    const value = task.planning.scheduled;
    const chip = container.createEl('button', {
      cls: `abyss-chip abyss-chip-scheduled${value ? '' : ' abyss-chip-empty'}`,
      text: value ? `⏳ ${this.formatDate(value)}` : '⏳ Plan',
      attr: { title: 'Set plan date' },
    });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showDatePopover(
        chip,
        task,
        'scheduled',
        this.taskFieldBinding('date', 'date-plan', chip),
      );
    });
  }

  /** "Start" (🛫/`start`) chip — same round-pill/popover pattern as the due-date chip. */
  private renderStartChip(container: HTMLElement, task: TaskLike): void {
    const value = task.planning.start;
    const chip = container.createEl('button', {
      cls: `abyss-chip abyss-chip-start${value ? '' : ' abyss-chip-empty'}`,
      text: value ? `🛫 ${this.formatDate(value)}` : '🛫 Start',
      attr: { title: 'Set start date' },
    });
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showDatePopover(chip, task, 'start', this.taskFieldBinding('date', 'date-start', chip));
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
    if (!task.planning.start) options.push({ field: 'start', label: '🛫 Start' });
    if (!task.planning.scheduled) options.push({ field: 'scheduled', label: '⏳ Plan' });
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
    if (existing) {
      this.removeAnchoredSurface(existing as HTMLElement);
      return;
    }
    this.el
      .querySelectorAll<HTMLElement>('.abyss-add-date-menu')
      .forEach((element) => this.removeAnchoredSurface(element));
    this.el
      .querySelectorAll<HTMLElement>('.abyss-context-menu')
      .forEach((element) => this.removeAnchoredSurface(element));

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
          this.showDatePopover(
            anchor,
            task,
            opt.field,
            this.taskFieldBinding(
              'date',
              opt.field === 'scheduled' ? 'date-plan' : 'date-start',
              anchor,
            ),
          );
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
      cls: `abyss-chip abyss-priority-chip abyss-priority-chip--${task.priority ?? 'D'}${task.priority === 'D' ? ' abyss-chip-empty' : ''}`,
      text: labels[task.priority] ?? 'Priority',
      attr: {
        'data-priority': task.priority ?? 'D',
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
    const chip = container.createEl('button', {
      cls: `abyss-chip abyss-repeat-chip${task.recurrence ? '' : ' abyss-chip-add abyss-chip-empty'}`,
      attr: { title: task.recurrence ? 'Edit repeat' : 'Add repeat' },
    });
    if (task.recurrence) {
      renderRecurrenceBadge(chip, recurrenceBadgeInput(task.recurrence));
      chip.createSpan({ cls: 'abyss-repeat-chip-label', text: task.recurrence });
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
    if (existing) return;
    anchor.focus();
    const root = stack[0];
    const target = this.planningTarget(task);
    if (!root || !('source' in root) || !target) return;

    const popover = this.el.createDiv({
      cls: 'abyss-popover abyss-recurrence-popover abyss-popover-anchored',
      attr: { role: 'dialog', 'aria-modal': 'false' },
    });
    const handle = mountRecurrenceEditor({
      container: popover,
      source: { root, target },
      policy: {
        removeScheduledDate: this.settings?.recurrence.removeScheduledDate ?? false,
      },
      ownershipConflict: this.hasRecurrenceOwnershipConflict(task, stack),
      onSubmit: (patch) => this.executePlanningPatch(task, patch),
      onClose: () => this.removeAnchoredSurface(popover),
    });
    this.recurrenceDraftEditor = { target, handle, surface: popover };
    const title = popover.querySelector<HTMLElement>('.abyss-recurrence-title');
    if (title?.id) popover.setAttribute('aria-labelledby', title.id);
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
    this.dismissMenuOnOutsideClick(popover, anchor, () => handle.dismiss());
    if (autofocus) this.el.ownerDocument.defaultView?.setTimeout(() => handle.focus(), 0);
  }

  private hasRecurrenceOwnershipConflict(task: TaskLike, stack: readonly TaskLike[]): boolean {
    if (stack.slice(0, -1).some((ancestor) => ancestor.recurrence !== undefined)) return true;
    const queue = [...task.subtasks];
    while (queue.length > 0) {
      const descendant = queue.shift()!;
      if (descendant.recurrence !== undefined) return true;
      queue.push(...descendant.subtasks);
    }
    return false;
  }

  private renderTagChip(container: HTMLElement, task: TaskLike, tag: string): void {
    const chip = container.createEl('span', { cls: 'abyss-chip abyss-chip-tag' });
    const color = this.getTagColor(tag);
    if (color) chip.setCssProps({ '--abyss-chip-tag-color': color });
    chip.createEl('span', { text: tag });
    const x = chip.createEl('button', { cls: 'abyss-chip-remove', text: '×' });
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.removeTag(task, tag);
    });
  }

  private getTagColor(tag: string): string | undefined {
    if (!this.settings) return undefined;
    return colorForTag(tag, this.settings.tagGroups);
  }

  private dependencyInspection(task: TaskSnapshot): DependencyInspection {
    return (
      this.dependencyProjection?.inspect?.(task) ?? {
        decision: this.dependencyProjection?.evaluateCompletion(task) ?? { type: 'allowed' },
        relations: [],
      }
    );
  }

  private renderDependencyChip(container: HTMLElement, task: TaskSnapshot): void {
    const inspection = this.dependencyInspection(task);
    const trigger = container.createEl('button', {
      cls: `abyss-chip abyss-dependency-chip${inspection.relations.length === 0 ? ' abyss-chip-empty' : ''}`,
      attr: {
        type: 'button',
        title: 'Edit blocked by',
        'aria-label': 'Edit blocked by',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
        'data-dependency-trigger': '',
      },
    });
    setIcon(trigger, inspection.relations.length > 0 ? 'lock-keyhole' : 'link-2');
    if (inspection.decision.type !== 'allowed') {
      renderDependencyBadge(trigger, inspection.decision);
    }
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.showDependencyEditor(trigger, task);
    });
  }

  private showDependencyEditor(anchor: HTMLButtonElement, task: TaskSnapshot): void {
    task = this.currentDependencyTask(task) ?? task;
    this.clearPopovers();
    const inspection = this.dependencyInspection(task);
    const editorId = `abyss-dependency-editor-${String(++this.dependencyEditorSequence)}`;
    anchor.setAttr('aria-controls', editorId);
    const editor = this.el.createDiv({
      cls: 'abyss-popover abyss-popover-anchored abyss-dependency-editor',
      attr: {
        id: editorId,
        role: 'dialog',
        'aria-label': 'Blocked by',
        'data-dependency-editor': '',
      },
    });
    let repairDependencyId: string | undefined;
    // ID-less candidates are graph-preflighted by identity. Allocate exactly
    // once on activation so an unsuccessful command cannot poison later tries.
    const dependencyIdFor = (candidate: TaskSnapshot): string | undefined => {
      if (repairDependencyId !== undefined) return repairDependencyId;
      if (candidate.dependency?.id !== undefined) return candidate.dependency.id;
      return this.tasks?.newDependencyId?.();
    };
    const repairButtons: HTMLButtonElement[] = [];
    let beginRepair: ((dependencyId: string) => void) | undefined;
    if (inspection.decision.type === 'invalid') {
      for (const diagnostic of inspection.decision.diagnostics) {
        if (diagnostic.type === 'missing-prerequisite' || diagnostic.type === 'duplicate-id') {
          continue;
        }
        let text: string;
        if (diagnostic.type === 'self-edge') {
          text = `Task depends on itself · ${diagnostic.id}`;
        } else if (diagnostic.type === 'cycle') {
          text = `Dependency cycle · ${diagnostic.ids.join(' → ')}`;
        } else {
          text = 'Dependency data unavailable · Reopen and inspect before changing it';
        }
        editor.createDiv({
          cls: 'abyss-dependency-diagnostic',
          text,
          attr: { 'data-dependency-diagnostic': diagnostic.type },
        });
      }
    }
    const relationHost = editor.createDiv({ cls: 'abyss-dependency-relations' });
    const snapshotByRef = (ref: TaskRef): TaskSnapshot | undefined =>
      this.tasks?.queries
        .list()
        .find(
          (candidate) => candidate.ref.filePath === ref.filePath && candidate.ref.line === ref.line,
        );
    for (const relation of inspection.relations) {
      const row = relationHost.createDiv({
        cls: 'abyss-dependency-relation',
        attr: {
          'data-dependency-relation': relation.id,
          'data-dependency-resolution': relation.resolution.type,
        },
      });
      if (relation.resolution.type === 'resolved') {
        const prerequisite = snapshotByRef(relation.resolution.prerequisite);
        const fallbackStatus = relation.resolution.complete
          ? this.statusRegistry.defaultDone()
          : this.statusRegistry.defaultTodo();
        const marker = renderStatusMarker(row, {
          task: {
            statusSymbol: fallbackStatus.symbol,
            status: relation.resolution.complete ? 'done' : 'open',
          },
          registry: this.statusRegistry,
          interactive: false,
          onLeftClick: () => undefined,
          onContextMenu: () => undefined,
        });
        marker.setAttr(
          'aria-label',
          relation.resolution.complete ? 'Prerequisite complete' : 'Prerequisite open',
        );
        row.createSpan({ text: prerequisite?.title ?? relation.id });
      } else if (relation.resolution.type === 'missing') {
        row.createSpan({ text: `${relation.id} · Missing` });
        const repair = row.createEl('button', {
          cls: 'abyss-dependency-repair',
          attr: {
            type: 'button',
            title: `Find task for ${relation.id}`,
            'aria-label': `Repair missing dependency ${relation.id}`,
            'aria-pressed': 'false',
            'data-dependency-repair': relation.id,
          },
        });
        setIcon(repair, 'link');
        repair.addEventListener('click', () => beginRepair?.(relation.id));
        repairButtons.push(repair);
      } else {
        row.createSpan({
          text: `${relation.id} · ${String(relation.resolution.candidates.length)} matches`,
        });
      }
      const clear = row.createEl('button', {
        cls: 'abyss-dependency-remove',
        attr: {
          type: 'button',
          title: `Remove ${relation.id}`,
          'aria-label': `Remove dependency ${relation.id}`,
          'data-dependency-clear': relation.id,
        },
      });
      setIcon(clear, 'x');
      clear.addEventListener('click', () => {
        if (!this.tasks?.clearDependency) return;
        void this.runTaskFieldCommand(
          this.taskFieldBinding('dependencies', 'dependencies', clear),
          () => this.tasks!.clearDependency!({ dependent: task.ref, dependencyId: relation.id }),
        ).then((result) => {
          if (result.type === 'ok') void this.refreshDependencyEditor(editor, anchor, task);
        });
      });
    }
    // Keep the persisted blocker list at the top even when graph diagnostics are present.
    editor.prepend(relationHost);

    const listId = `${editorId}-list`;
    const search = editor.createEl('input', {
      type: 'search',
      cls: 'abyss-dependency-search',
      attr: {
        placeholder: 'Search tasks',
        'aria-label': 'Search prerequisite tasks',
        role: 'combobox',
        'aria-controls': listId,
        'aria-autocomplete': 'list',
        'data-dependency-search': '',
      },
    });
    const results = editor.createDiv({
      cls: 'abyss-dependency-candidates',
      attr: { id: listId, role: 'listbox' },
    });
    const flatCandidates = (): readonly DependencyCandidate[] =>
      this.flatDependencyCandidates(task);
    const selectionUnavailable =
      inspection.decision.type === 'invalid' &&
      inspection.decision.diagnostics.some(
        (diagnostic) => diagnostic.type !== 'missing-prerequisite',
      );
    const repairRequired =
      inspection.decision.type === 'invalid' &&
      inspection.decision.diagnostics.some(
        (diagnostic) => diagnostic.type === 'missing-prerequisite',
      );
    const candidateButtons = (): HTMLButtonElement[] =>
      Array.from(results.querySelectorAll<HTMLButtonElement>('[data-dependency-candidate]')).filter(
        (button) => !button.disabled,
      );
    const renderCandidates = (query: string): void => {
      results.empty();
      const needle = query.trim().toLocaleLowerCase();
      const matching = flatCandidates().filter(({ task: candidate }) =>
        `${candidate.title} ${candidate.ref.filePath}`.toLocaleLowerCase().includes(needle),
      );
      let count = 0;
      for (const projected of matching.slice(0, 20)) {
        const candidate = projected.task;
        count += 1;
        const candidateDecision = this.dependencyProjection?.evaluateCompletion(candidate);
        const duplicateId =
          candidate.dependency?.id !== undefined &&
          candidateDecision?.type === 'invalid' &&
          candidateDecision.diagnostics.some(
            (diagnostic) =>
              diagnostic.type === 'duplicate-id' && diagnostic.id === candidate.dependency?.id,
          );
        const dependencyIdAvailable =
          repairDependencyId !== undefined ||
          candidate.dependency?.id !== undefined ||
          this.tasks?.newDependencyId !== undefined;
        let unavailableReason: string | undefined =
          projected.availability.type === 'disabled' ? projected.availability.reason : undefined;
        const repairValidation =
          repairDependencyId !== undefined && candidate.dependency?.id === undefined
            ? this.validateDependencyLink(candidate, task, repairDependencyId)
            : undefined;
        if (duplicateId) unavailableReason = 'Duplicate ID';
        else if (selectionUnavailable) unavailableReason = 'Resolve dependency issue';
        else if (repairDependencyId === undefined && repairRequired) {
          unavailableReason = 'Repair missing prerequisite';
        } else if (repairValidation) {
          unavailableReason = dependencyValidationReason(repairValidation);
        } else if (repairDependencyId !== undefined && candidate.dependency?.id !== undefined) {
          unavailableReason = 'Already has an ID';
        } else if (!dependencyIdAvailable) unavailableReason = 'Dependency ID unavailable';
        const diagnosticTitle = unavailableReason ? ` — ${unavailableReason}` : '';
        const diagnosticLabel = unavailableReason ? `, ${unavailableReason}` : '';
        const candidateTitle = `${candidate.title} — ${candidate.ref.filePath}:${String(candidate.ref.line + 1)}${diagnosticTitle}`;
        const button = results.createEl('button', {
          cls: 'abyss-dependency-candidate',
          attr: {
            type: 'button',
            role: 'option',
            title: candidateTitle,
            'aria-label': `${candidate.title}, ${candidate.ref.filePath}, line ${String(candidate.ref.line + 1)}${diagnosticLabel}`,
            'data-dependency-candidate': '',
            ...(unavailableReason && { 'aria-disabled': 'true' }),
          },
        });
        button.createSpan({
          cls: 'abyss-dependency-candidate-title',
          text: candidate.title,
        });
        button.createSpan({
          cls: 'abyss-dependency-candidate-source',
          text: `${candidate.ref.filePath}:${String(candidate.ref.line + 1)}`,
          attr: { 'aria-hidden': 'true' },
        });
        if (unavailableReason) {
          button.createSpan({
            cls: 'abyss-dependency-candidate-diagnostic',
            text: unavailableReason,
            attr: { 'aria-hidden': 'true' },
          });
        }
        button.addEventListener('keydown', (event) => {
          if (unavailableReason && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          const buttons = candidateButtons();
          const index = buttons.indexOf(button);
          const next = event.key === 'ArrowDown' ? buttons[index + 1] : buttons[index - 1];
          (next ?? search).focus({ preventScroll: true });
        });
        button.addEventListener('click', () => {
          if (unavailableReason) return;
          if (!this.tasks?.setDependency) return;
          const dependencyId = dependencyIdFor(candidate);
          if (dependencyId === undefined) return;
          void this.runTaskFieldCommand(
            this.taskFieldBinding('dependencies', 'dependencies', button),
            () =>
              this.tasks!.setDependency!({
                prerequisite: candidate.ref,
                dependent: task.ref,
                dependencyId,
                enabled: true,
              }),
          ).then((result) => {
            if (result.type === 'ok') void this.refreshDependencyEditor(editor, anchor, task);
          });
        });
      }
      if (count === 0) results.createDiv({ cls: 'abyss-dependency-empty', text: 'No tasks found' });
    };
    beginRepair = (dependencyId) => {
      repairDependencyId = dependencyId;
      editor.setAttr('data-dependency-repairing', dependencyId);
      for (const button of repairButtons) {
        button.setAttr(
          'aria-pressed',
          button.getAttribute('data-dependency-repair') === dependencyId ? 'true' : 'false',
        );
      }
      search.setAttr('placeholder', `Find task for ${dependencyId}`);
      renderCandidates(search.value);
      search.focus({ preventScroll: true });
    };
    renderCandidates('');
    search.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const buttons = candidateButtons();
      const next = event.key === 'ArrowDown' ? buttons[0] : buttons[buttons.length - 1];
      if (!next) return;
      event.preventDefault();
      next.focus({ preventScroll: true });
    });
    let debounce: number | undefined;
    search.addEventListener('input', () => {
      if (debounce !== undefined) this.el.ownerDocument.defaultView?.clearTimeout(debounce);
      debounce = this.el.ownerDocument.defaultView?.setTimeout(() => {
        debounce = undefined;
        renderCandidates(search.value);
      }, 120);
    });
    this.positionAnchoredSurface(editor, anchor, 'below-start');
    this.dismissMenuOnOutsideClick(editor, anchor, () => this.removeAnchoredSurface(editor), {
      onCleanup: () => {
        if (debounce !== undefined) this.el.ownerDocument.defaultView?.clearTimeout(debounce);
        anchor.removeAttribute('aria-controls');
      },
    });
    search.focus({ preventScroll: true });
  }

  private focusDependencyTrigger(): void {
    this.el
      .querySelector<HTMLButtonElement>('[data-dependency-trigger]')
      ?.focus({ preventScroll: true });
  }

  private flatDependencyCandidates(task: TaskSnapshot): readonly DependencyCandidate[] {
    const supplied = this.dependencyCandidates?.(task);
    if (isFlatDependencyCandidateSource(supplied)) return supplied;
    const projectTasks = supplied?.project ?? [];
    const tasks = supplied
      ? [...supplied.project, ...supplied.other]
      : (this.tasks?.queries.list() ?? []);
    const policy = this.dependencyProjection as
      | {
          readonly validateLink?: (
            input: DependencyLinkValidationInput,
          ) => DependencyLinkValidation;
          readonly preflightIdentityLink?: (
            prerequisite: TaskSnapshot,
            dependent: TaskSnapshot,
          ) => DependencyLinkValidation;
        }
      | undefined;
    return projectDependencyCandidates({
      dependent: task,
      tasks,
      projectTasks,
      validateLink: (prerequisite, dependent, dependencyId) =>
        this.validateDependencyLink(prerequisite, dependent, dependencyId),
      preflightIdentityLink: (prerequisite, dependent) =>
        policy?.preflightIdentityLink?.(prerequisite, dependent) ?? { type: 'allowed' },
    });
  }

  private validateDependencyLink(
    prerequisite: TaskSnapshot,
    dependent: TaskSnapshot,
    dependencyId: string,
  ): DependencyLinkValidation {
    const policy = this.dependencyProjection as
      | {
          readonly validateLink?: (
            input: DependencyLinkValidationInput,
          ) => DependencyLinkValidation;
        }
      | undefined;
    return policy?.validateLink?.({ prerequisite, dependent, dependencyId }) ?? { type: 'allowed' };
  }

  /** Re-read the settled graph and keep the anchored editor open for consecutive edits. */
  private async refreshDependencyEditor(
    editor: HTMLElement,
    anchor: HTMLButtonElement,
    task: TaskSnapshot,
  ): Promise<void> {
    await this.tasks?.queries.rescan?.();
    if (!editor.isConnected || !anchor.isConnected) return;
    this.removeAnchoredSurface(editor);
    this.showDependencyEditor(anchor, this.currentDependencyTask(task) ?? task);
  }

  /** A graph update may rebase an ID-less root, so never render blockers from a captured stack item. */
  private currentDependencyTask(task: TaskSnapshot): TaskSnapshot | undefined {
    const resolved = this.tasks?.queries.resolve(task.ref);
    if (resolved?.type === 'exact') return resolved.task;
    if (resolved?.type === 'rebased') return resolved.current;
    const sameLocation = this.tasks?.queries
      .list({ filePath: task.ref.filePath })
      .filter((candidate) => candidate.ref.line === task.ref.line);
    return sameLocation?.length === 1 ? sameLocation[0] : undefined;
  }

  private clearPopovers(): void {
    this.el
      .querySelectorAll<HTMLElement>('.abyss-popover')
      .forEach((element) => this.removeAnchoredSurface(element));
  }

  private removeAnchoredSurface(surface: HTMLElement): void {
    this.anchoredSurfaceCleanups.get(surface)?.();
    surface.remove();
  }

  private clearAnchoredSurfaces(): void {
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
      onPickStatus: (symbol) => void this.setStatus(task, symbol),
      onPickPriority: (priority) => void this.updatePriority(task, priority),
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
    binding = this.taskFieldBinding('date', 'date-due', anchor),
  ): void {
    const already = this.el.querySelector('.abyss-date-popover');
    this.clearPopovers();
    if (already) return;

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
      if (field === 'due') void this.updateDue(task, input.value, binding);
      else if (field === 'scheduled') void this.updateScheduled(task, input.value, binding);
      else void this.updateStart(task, input.value, binding);
      this.removeAnchoredSurface(pop);
    });
    this.el.ownerDocument.defaultView?.setTimeout(() => input.focus(), 0);

    const clearBtn = inputRow.createEl('button', {
      cls: 'abyss-popover-clear-icon-btn',
      attr: { title: 'Clear date', 'aria-label': 'Clear date' },
    });
    setIcon(clearBtn, 'x');
    clearBtn.addEventListener('mousedown', (e) => e.preventDefault());
    clearBtn.addEventListener('click', () => {
      if (field === 'due') void this.clearDate(task, binding);
      else if (field === 'scheduled') void this.clearScheduled(task, binding);
      else void this.clearStart(task, binding);
      this.removeAnchoredSurface(pop);
    });
    this.positionAnchoredSurface(pop, anchor, 'below-start');
    this.dismissMenuOnOutsideClick(pop, anchor, undefined, {
      focusLeaveDelay: 200,
      onCleanup: () => {
        if (previousPopupRole) anchor.setAttribute('aria-haspopup', previousPopupRole);
        else anchor.removeAttribute('aria-haspopup');
      },
    });
  }

  private showPriorityPopover(anchor: HTMLElement, task: TaskLike): void {
    const already = this.el.querySelector('.abyss-priority-popover');
    this.clearPopovers();
    if (already) return;

    const pop = this.el.createDiv({
      cls: 'abyss-popover abyss-priority-popover abyss-popover-anchored',
      attr: { role: 'listbox', 'aria-label': 'Priority' },
    });

    const currentPriority = anchor.getAttribute('data-priority') ?? task.priority ?? 'D';
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
      const checkEl = btn.createEl('span', { cls: 'abyss-priority-option-check' });
      if (isActive) setIcon(checkEl, 'check');
      const flagEl = btn.createEl('span', { cls: 'abyss-priority-option-flag' });
      setIcon(flagEl, 'flag');
      btn.createEl('span', { cls: 'abyss-priority-option-label', text: opt.label });
      btn.addEventListener('click', () => {
        // Optimistic update stays on the control: the field row owns semantics.
        const chipLabels: Record<string, string> = {
          A: '🚩 Highest',
          B: '🚩 High',
          C: '🚩 Medium',
          D: 'Priority',
          E: '🚩 Low',
          F: '🚩 Lowest',
        };
        const previous = {
          text: anchor.textContent ?? '',
          priority: anchor.getAttribute('data-priority'),
          classes: Array.from(anchor.classList),
        };
        anchor.textContent = chipLabels[opt.value] ?? 'Priority';
        anchor.setAttribute('data-priority', opt.value);
        for (const className of Array.from(anchor.classList)) {
          if (className.startsWith('abyss-priority-chip--') || className === 'abyss-chip-empty') {
            anchor.removeClass(className);
          }
        }
        anchor.addClass(`abyss-priority-chip--${opt.value}`);
        if (opt.value === 'D') anchor.addClass('abyss-chip-empty');
        this.removeAnchoredSurface(pop);
        anchor.focus({ preventScroll: true });
        void this.updatePriority(task, opt.value).then((saved) => {
          if (saved) return;
          anchor.textContent = previous.text;
          if (previous.priority === null) anchor.removeAttribute('data-priority');
          else anchor.setAttribute('data-priority', previous.priority);
          for (const className of Array.from(anchor.classList)) anchor.classList.remove(className);
          for (const className of previous.classes) anchor.classList.add(className);
        });
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
      const computed = ownerWindow?.getComputedStyle(popover);
      const edgeGap = this.cssLengthToPx(
        computed?.getPropertyValue('--abyss-popover-edge-gap') ?? '',
        popover,
        8,
      );
      popover.style.setProperty(
        '--abyss-popover-max-block-size',
        `${String(Math.max(0, boundary.height - edgeGap * 2))}px`,
      );
      const floatingRect = popover.getBoundingClientRect();
      const minWidth = parseFloat(computed?.minWidth ?? '');
      const floatingWidth =
        floatingRect.width || popover.offsetWidth || (Number.isFinite(minWidth) ? minWidth : 160);
      const floatingHeight = floatingRect.height || popover.offsetHeight;
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
    if (!trimmed) return fallback;
    if (trimmed.endsWith('px')) return parseFloat(trimmed);
    if (trimmed.endsWith('rem')) {
      const rootFontSize =
        parseFloat(
          relativeTo.ownerDocument.defaultView?.getComputedStyle(
            relativeTo.ownerDocument.documentElement,
          ).fontSize ?? '',
        ) || 16;
      return parseFloat(trimmed) * rootFontSize;
    }
    if (trimmed.endsWith('em')) {
      const fontSize =
        parseFloat(
          relativeTo.ownerDocument.defaultView?.getComputedStyle(relativeTo).fontSize ?? '',
        ) || 16;
      return parseFloat(trimmed) * fontSize;
    }
    const numeric = parseFloat(trimmed);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  private showTagInput(container: HTMLElement, task: TaskLike, anchor: HTMLElement): void {
    const existing = this.el.querySelector<HTMLElement>('.abyss-tag-dropdown-wrap');
    if (existing) {
      this.removeAnchoredSurface(existing);
      return;
    }
    let surface!: HTMLElement;
    surface = showTagDropdown(
      container,
      this.app,
      (tag) => this.getTagColor(tag),
      (tag) => void this.addTag(task, tag),
      () => this.removeAnchoredSurface(surface),
    );
    anchor.addClass('abyss-chip-add--hidden');
    this.dismissMenuOnOutsideClick(surface, anchor, () => this.removeAnchoredSurface(surface), {
      focusLeaveDelay: 200,
      onCleanup: () => anchor.removeClass('abyss-chip-add--hidden'),
    });
  }

  // ---- Write-back helpers ----

  private async runTaskFieldCommand(
    binding: TaskFieldBinding,
    command: () => Promise<TaskCommandResult> | TaskCommandResult,
  ): Promise<TaskCommandResult> {
    // Command-only callers (including task command tests) have no inspector
    // surface. They retain the same structured I/O result without inventing DOM.
    if (!this.el) {
      try {
        return await command();
      } catch {
        return { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
      }
    }
    const { control, field, instanceKey, row } = binding;
    if (!row || !control) {
      try {
        return await command();
      } catch {
        return { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
      }
    }
    let feedback = row.querySelector<HTMLElement>(
      `[data-task-field-feedback="${field}"][data-task-field-instance="${instanceKey}"]`,
    );
    if (!feedback) {
      feedback = row.createDiv({
        cls: 'abyss-task-inspector-result',
        attr: {
          'data-task-field-feedback': field,
          'data-task-field-instance': instanceKey,
        },
      });
    }
    return (await createInspectorFieldPresenter(feedback).run(
      { field, control },
      command,
    )) as TaskCommandResult;
  }

  private taskFieldBinding(
    field: InspectorFieldKind,
    instanceKey: string = field,
    control?: HTMLElement,
  ): TaskFieldBinding {
    if (!this.el) return { field, instanceKey };
    const selector = `.abyss-inspector-field-row[data-inspector-field="${field}"][data-inspector-field-instance="${instanceKey}"]`;
    const row =
      control?.closest<HTMLElement>(selector) ??
      this.el.querySelector<HTMLElement>(selector) ??
      this.el;
    return {
      field,
      instanceKey,
      row,
      control: control ?? row.querySelector<HTMLElement>('button, input, textarea, select') ?? row,
    };
  }

  private planningField(patch: TaskPatch): InspectorFieldKind {
    if (patch.priority !== undefined) return 'priority';
    if (
      patch.due !== undefined ||
      patch.scheduled !== undefined ||
      patch.start !== undefined ||
      patch.time !== undefined
    ) {
      return 'date';
    }
    if (patch.duration !== undefined) return 'progress';
    if (patch.tags !== undefined) return 'relations';
    return 'recurrence';
  }

  private planningFieldBinding(patch: TaskPatch): TaskFieldBinding {
    if (patch.time !== undefined) return this.taskFieldBinding('date', 'date-time');
    if (patch.scheduled !== undefined) return this.taskFieldBinding('date', 'date-plan');
    if (patch.start !== undefined) return this.taskFieldBinding('date', 'date-start');
    if (patch.due !== undefined) return this.taskFieldBinding('date', 'date-due');
    return this.taskFieldBinding(this.planningField(patch));
  }

  private blockCommandField(command: TaskCommand): InspectorFieldKind {
    if (command.type === 'set-description') return 'description';
    if (
      command.type === 'add-comment' ||
      command.type === 'update-comment' ||
      command.type === 'delete-comment'
    ) {
      return 'comments';
    }
    return command.type === 'add-subtask' || command.type === 'delete-subtask'
      ? 'progress'
      : 'subtasks';
  }

  private async updateTaskTitle(task: TaskLike, newText: string): Promise<void> {
    await this.saveTaskTitle(task, newText);
  }

  private async saveTaskTitle(task: TaskLike, newText: string): Promise<boolean> {
    const target = this.planningTarget(task);
    if (!target || !this.tasks) return false;
    const patch = { markdownTitle: { type: 'set' as const, value: newText } };
    const command = { type: 'patch', target, patch } as TaskCommand;
    const submission = this.beginDraftSubmission(
      target,
      (draft) => draft.kind === 'title' && sameNodeRef(draft.target.target, target),
    );
    if (!submission) return false;
    let result: TaskCommandResult;
    try {
      result = await this.runTaskFieldCommand(this.taskFieldBinding('title'), () =>
        this.tasks!.execute(command),
      );
    } catch {
      result = { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
    }
    this.applyPlanningResult(result, target, undefined, submission);
    this.settleDraftSubmission(submission, result);
    return result.type === 'ok';
  }

  private async appendToTitle(task: TaskLike, text: string): Promise<void> {
    const target = this.planningTarget(task);
    if (!target || !this.tasks) return;
    const result = await this.runTaskFieldCommand(this.taskFieldBinding('title'), () =>
      this.tasks!.execute({ type: 'append-title', target, markdown: text }),
    );
    this.applyPlanningResult(result, target);
  }

  private async updateDescription(task: TaskLike, newDesc: string): Promise<boolean> {
    const target = this.planningTarget(task);
    if (!target) return false;
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
    if (!parent) return false;
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
    if (!target || !this.tasks) return;
    const result = await this.runTaskFieldCommand(this.taskFieldBinding('status'), () =>
      this.tasks!.execute({ type: 'toggle-completion', target }),
    );
    this.applyPlanningResult(result, target);
  }

  private async addComment(
    task: TaskLike,
    text: string,
    _commentList: HTMLElement,
    inputEl: HTMLTextAreaElement,
  ): Promise<boolean> {
    const parent = this.planningTarget(task);
    if (!parent) return false;
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
    if (!ref) return false;
    return this.executeBlockCommand(
      { type: 'update-comment', comment: ref, text: newText },
      ref.parent,
    );
  }

  private async deleteComment(_task: TaskLike, comment: TaskCommentSnapshot): Promise<boolean> {
    const ref = commentRefOf(comment);
    if (!ref) return false;
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
    if (!this.tasks) return false;
    const initiatingStack = this.state.get('taskStack');
    const submission = this.beginDraftSubmission(target, (draft) =>
      this.matchesBlockCommandDraft(draft, command),
    );
    if (!submission) return false;
    const result = await this.runTaskFieldCommand(
      this.taskFieldBinding(this.blockCommandField(command)),
      () => this.tasks!.execute(command),
    );
    this.applyPlanningResult(result, target, initiatingStack, submission);
    this.settleDraftSubmission(submission, result);
    return result.type === 'ok';
  }

  private async updateDue(task: TaskLike, date: string, binding?: TaskFieldBinding): Promise<void> {
    await this.executePlanningPatch(
      task,
      { due: { type: 'set', value: localDate(date) } },
      binding,
    );
  }

  private async clearDate(task: TaskLike, binding?: TaskFieldBinding): Promise<void> {
    await this.executePlanningPatch(
      task,
      task.planning.due || !task.planning.scheduled
        ? { due: { type: 'clear' } }
        : { scheduled: { type: 'clear' } },
      binding,
    );
  }

  private async updateScheduled(
    task: TaskLike,
    date: string,
    binding?: TaskFieldBinding,
  ): Promise<void> {
    await this.executePlanningPatch(
      task,
      {
        scheduled: { type: 'set', value: localDate(date) },
      },
      binding,
    );
  }

  private async clearScheduled(task: TaskLike, binding?: TaskFieldBinding): Promise<void> {
    await this.executePlanningPatch(task, { scheduled: { type: 'clear' } }, binding);
  }

  private async updateStart(
    task: TaskLike,
    date: string,
    binding?: TaskFieldBinding,
  ): Promise<void> {
    await this.executePlanningPatch(
      task,
      { start: { type: 'set', value: localDate(date) } },
      binding,
    );
  }

  private async clearStart(task: TaskLike, binding?: TaskFieldBinding): Promise<void> {
    await this.executePlanningPatch(task, { start: { type: 'clear' } }, binding);
  }

  private planningTarget(task: TaskLike): PlanningTarget | undefined {
    return taskNodeRef(task);
  }

  private async executePlanningPatch(
    task: TaskLike,
    patch: TaskPatch,
    binding?: TaskFieldBinding,
  ): Promise<TaskCommandResult> {
    const target = this.planningTarget(task);
    if (!target || !this.tasks) {
      return { type: 'io-error', cause: 'application-unavailable', contentState: 'unchanged' };
    }
    const submission = this.beginDraftSubmission(target, (draft) => {
      if (patch.recurrence === undefined && patch.onCompletion === undefined) return false;
      return draft.kind === 'recurrence-editor' && sameNodeRef(draft.target, target);
    });
    if (!submission) {
      return { type: 'io-error', cause: 'repository-error', contentState: 'unchanged' };
    }
    const result = await this.runTaskFieldCommand(
      binding ?? this.planningFieldBinding(patch),
      () => {
        if (target.type === 'task') return this.tasks!.execute({ type: 'patch', target, patch });
        if (patch.duration !== undefined) {
          return { type: 'io-error', cause: 'unsupported-field', contentState: 'unchanged' };
        }
        const subtaskPatch: SubtaskPatch = patch;
        return this.tasks!.execute({ type: 'patch', target, patch: subtaskPatch });
      },
    );
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
    if (result.type !== 'ok' || result.outcome.type !== 'task') return;
    const stack = this.state.get('taskStack');
    const initiatingRoot = rootRefForPlanningTarget(target);
    const selectedRoot = stack[0] ? rootTaskRef(stack[0]) : undefined;
    if (
      selectedRoot &&
      sameTaskRef(selectedRoot, initiatingRoot) &&
      (initiatingStack === undefined || stack === initiatingStack)
    ) {
      const root = result.outcome.task;
      const draft =
        result.changed && submission
          ? this.captureDraftStateForOwnedTransition(initiatingRoot, root.ref, submission)
          : this.captureDraftState();
      this.state.set(
        'taskStack',
        target.type === 'subtask'
          ? rebuildPlanningTargetStack(root, target)
          : rebuildTaskSelection(root, stack),
      );
      this.restoreDraftState(draft, root);
    }
    if (result.changed) this.onSuccessfulMutation?.(result.outcome.task.ref);
  }

  private async updateDuration(
    task: TaskSnapshot,
    minutes: number,
    binding?: TaskFieldBinding,
  ): Promise<void> {
    try {
      await this.executePlanningPatch(
        task,
        { duration: { type: 'set', value: durationMinutes(minutes) } },
        binding,
      );
    } catch {
      // Invalid input leaves the existing duration unchanged.
    }
  }

  private async clearDuration(task: TaskSnapshot, binding?: TaskFieldBinding): Promise<void> {
    await this.executePlanningPatch(task, { duration: { type: 'clear' } }, binding);
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
    if (!target || !this.tasks) return;
    const result = await this.runTaskFieldCommand(this.taskFieldBinding('status'), () =>
      this.tasks!.execute({ type: 'set-status', target, symbol }),
    );
    this.applyPlanningResult(result, target);
  }

  private async updatePriority(task: TaskLike, priority: string): Promise<boolean | undefined> {
    if (!['A', 'B', 'C', 'D', 'E', 'F'].includes(priority)) return undefined;
    const target = this.planningTarget(task);
    if (!target || !this.tasks) return undefined;
    const patch: TaskPatch = {
      priority: { type: 'set', value: priority as TaskPriority },
    };
    const result = await this.executePlanningPatch(task, patch);
    return result.type === 'ok';
  }

  private async removeTag(task: TaskLike, tag: string): Promise<void> {
    await this.executePlanningPatch(task, { tags: { remove: [tag] } });
  }

  private async addTag(task: TaskLike, tag: string): Promise<void> {
    await this.executePlanningPatch(task, { tags: { add: [tag] } });
  }

  private showTimePopover(
    anchor: HTMLElement,
    task: TaskLike,
    binding = this.taskFieldBinding('date', 'date-time', anchor),
  ): void {
    const already = this.el.querySelector('.abyss-time-popover');
    this.clearPopovers();
    if (already) return;

    const pop = this.el.createDiv({
      cls: 'abyss-popover abyss-time-popover abyss-popover-anchored',
      attr: { role: 'dialog', 'aria-label': 'Set time and duration' },
    });

    const inputRow = pop.createDiv({ cls: 'abyss-popover-input-row' });
    const input = inputRow.createEl('input', {
      cls: 'abyss-time-input',
      attr: { type: 'time', value: task.planning.time ?? '' },
    });
    this.el.ownerDocument.defaultView?.setTimeout(() => input.focus(), 0);
    input.addEventListener('change', () => {
      void this.updateTime(task, input.value, binding).then(() => this.removeAnchoredSurface(pop));
    });

    const clearBtn = inputRow.createEl('button', {
      cls: 'abyss-popover-clear-icon-btn',
      attr: { title: 'Clear time', 'aria-label': 'Clear time' },
    });
    setIcon(clearBtn, 'x');
    clearBtn.addEventListener('mousedown', (e) => e.preventDefault());
    clearBtn.addEventListener('click', () => {
      void this.updateTime(task, '', binding).then(() => this.removeAnchoredSurface(pop));
    });

    // Duration only applies to top-level TaskSnapshot (SubtaskSnapshot has no duration field) —
    // same 'duration' in task discriminator used for the Planning section gate.
    if ('source' in task) {
      const durationRow = pop.createDiv({ cls: 'abyss-popover-input-row' });
      const durationInput = durationRow.createEl('input', {
        cls: 'abyss-duration-input',
        attr: {
          type: 'text',
          // eslint-disable-next-line obsidianmd/ui/sentence-case
          placeholder: 'Duration, e.g. 1h30m',
          value: task.planning.duration ? formatDurationFromMinutes(task.planning.duration) : '',
        },
      });
      durationInput.addEventListener('change', () => {
        const minutes = parseDurationToMinutes(durationInput.value);
        const done = minutes
          ? this.updateDuration(task, minutes, binding)
          : this.clearDuration(task, binding);
        void done.then(() => this.removeAnchoredSurface(pop));
      });
      const clearDurationBtn = durationRow.createEl('button', {
        cls: 'abyss-popover-clear-icon-btn',
        attr: { title: 'Clear duration', 'aria-label': 'Clear duration' },
      });
      setIcon(clearDurationBtn, 'x');
      clearDurationBtn.addEventListener('mousedown', (e) => e.preventDefault());
      clearDurationBtn.addEventListener('click', () => {
        void this.clearDuration(task, binding).then(() => this.removeAnchoredSurface(pop));
      });
    }

    this.positionAnchoredSurface(pop, anchor, 'below-start');
    this.dismissMenuOnOutsideClick(pop, anchor, undefined, { focusLeaveDelay: 200 });
  }

  private async updateTime(
    task: TaskLike,
    time: string,
    binding?: TaskFieldBinding,
  ): Promise<void> {
    try {
      await this.executePlanningPatch(
        task,
        {
          time: time ? { type: 'set', value: localTime(time) } : { type: 'clear' },
        },
        binding,
      );
    } catch {
      // Invalid input leaves the existing time unchanged.
    }
  }

  private renderContextMenu(task: TaskLike, anchor: HTMLElement): void {
    const existing = this.el.querySelector<HTMLElement>('.abyss-task-context-menu');
    if (existing) {
      this.removeAnchoredSurface(existing);
      return;
    }
    // Close any other open context menus
    this.el
      .querySelectorAll<HTMLElement>('.abyss-context-menu')
      .forEach((element) => this.removeAnchoredSurface(element));

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
        void this.deleteTask(task);
      },
    );

    this.createContextMenuItem(menu, 'abyss-context-item', 'Open in file', () => {
      this.removeAnchoredSurface(menu);
      const root = this.state.get('taskStack')[0];
      if (root && 'source' in root) void openInFile(this.app, root, taskNodeLine(root, task));
    });

    this.positionAnchoredSurface(menu, anchor, 'below-end');
    this.dismissMenuOnOutsideClick(menu, anchor);
    editRepeat.focus({ preventScroll: true });
  }

  private recurrenceStackFor(task: TaskLike): readonly TaskLike[] {
    const root = this.state.get('taskStack')[0];
    const target = this.planningTarget(task);
    if (!root || !('source' in root) || !target) return [];
    return rebuildPlanningTargetStack(root, target);
  }

  /** Shared outside-click dismissal for small anchored menus (context menu, add-date menu). */
  private dismissMenuOnOutsideClick(
    menu: HTMLElement,
    anchor: HTMLElement,
    dismissSurface: () => void = () => this.removeAnchoredSurface(menu),
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
      if (registrationTimer !== undefined) ownerWindow?.clearTimeout(registrationTimer);
      if (focusLeaveTimer !== undefined) ownerWindow?.clearTimeout(focusLeaveTimer);
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
    if (target?.type === 'subtask') {
      await this.executeBlockCommand(
        { type: 'delete-subtask', subtask: target.ref },
        target.ref.parent,
      );
      return;
    }
    if (target?.type !== 'task' || !this.tasks) return;
    const initiatingStack = this.state.get('taskStack');
    let result: TaskCommandResult;
    try {
      result = await this.tasks.execute({ type: 'delete', ref: target.ref });
    } catch {
      result = { type: 'io-error', cause: 'repository-error', contentState: 'unknown' };
    }
    presentTaskCommandResult(result);
    const selectedRoot = this.state.get('taskStack')[0];
    const selectedRef = selectedRoot ? rootTaskRef(selectedRoot) : undefined;
    if (
      result.type === 'ok' &&
      result.outcome.type === 'deleted' &&
      this.state.get('taskStack') === initiatingStack &&
      selectedRef &&
      sameTaskRef(selectedRef, target.ref)
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
    if (!parent || movedTarget?.type !== 'subtask' || targetNode?.type !== 'subtask') return;
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
