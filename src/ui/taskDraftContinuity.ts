import type {
  SubtaskRef,
  SubtaskSnapshot,
  TaskCommentSnapshot,
  TaskNodeRef,
  TaskSnapshot,
  TaskTextTarget,
} from '../tasks';
import {
  buildRecurrenceRule,
  type MonthlyChoice,
  type Preset,
  type Unit,
  type Weekday,
  type YearlyChoice,
} from './recurrence/recurrenceEditorModel';

interface TextDraftBase {
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly hadFocus: boolean;
  readonly dirty: boolean;
}

export interface RecurrenceEditorDraft {
  readonly mode: 'structured' | 'custom';
  readonly preset?: Preset;
  readonly intervalText: string;
  readonly unit: Unit;
  readonly weekdays: readonly Weekday[];
  readonly monthly: MonthlyChoice;
  readonly yearly: YearlyChoice;
  readonly whenDone: boolean;
  readonly onCompletion: TaskSnapshot['onCompletion'];
  readonly customDraft: string;
  readonly focusedControl?: string;
  readonly selectionStart?: number;
  readonly selectionEnd?: number;
  readonly dirty: boolean;
}

export type RightPanelDraftState =
  | (TextDraftBase & {
      readonly kind: 'title';
      readonly target: Extract<TaskTextTarget, { readonly type: 'title' }>;
    })
  | (TextDraftBase & {
      readonly kind: 'description';
      readonly target: Extract<TaskTextTarget, { readonly type: 'description' }>;
    })
  | (TextDraftBase & {
      readonly kind: 'existing-comment';
      readonly target: Extract<TaskTextTarget, { readonly type: 'comment' }>;
    })
  | (TextDraftBase & {
      readonly kind: 'new-comment' | 'new-subtask';
      readonly parent: TaskNodeRef;
    })
  | {
      readonly kind: 'recurrence-editor';
      readonly target: TaskNodeRef;
      readonly editor: RecurrenceEditorDraft;
      readonly hadFocus: boolean;
    };

export interface RightPanelDraftBundle {
  readonly entries: readonly RightPanelDraftState[];
}

type TaskNode = TaskSnapshot | SubtaskSnapshot;

function uniqueExactOrSource<T>(exact: readonly T[], sourceMatches: readonly T[]): T | undefined {
  if (sourceMatches.length > 1) return undefined;
  if (exact.length === 1) return exact[0];
  if (sourceMatches.length === 1) return sourceMatches[0];
  return undefined;
}

function childPath(target: TaskNodeRef): readonly SubtaskRef[] {
  const path: SubtaskRef[] = [];
  let current = target;
  while (current.type === 'subtask') {
    path.push(current.ref);
    current = current.ref.parent;
  }
  path.reverse();
  return path;
}

function rebaseNode(
  root: TaskSnapshot,
  stale: TaskNodeRef,
): { readonly ref: TaskNodeRef; readonly node: TaskNode } | undefined {
  if (stale.type === 'task') return { ref: { type: 'task', ref: root.ref }, node: root };
  let node: TaskNode = root;
  let ref: TaskNodeRef = { type: 'task', ref: root.ref };
  for (const staleChild of childPath(stale)) {
    const exact: readonly SubtaskSnapshot[] = node.subtasks.filter(
      (candidate) =>
        candidate.ref.relativeLine === staleChild.relativeLine &&
        candidate.ref.originalBlock === staleChild.originalBlock,
    );
    const sourceMatches: readonly SubtaskSnapshot[] = node.subtasks.filter(
      (candidate) => candidate.ref.originalBlock === staleChild.originalBlock,
    );
    const child = uniqueExactOrSource(exact, sourceMatches);
    if (!child) return undefined;
    node = child;
    ref = { type: 'subtask', ref: child.ref };
  }
  return { ref, node };
}

function rebaseComment(
  root: TaskSnapshot,
  draft: Extract<RightPanelDraftState, { readonly kind: 'existing-comment' }>,
): Extract<TaskTextTarget, { readonly type: 'comment' }> | undefined {
  const parent = rebaseNode(root, draft.target.ref.parent);
  if (!parent) return undefined;
  const exact = parent.node.comments.filter(
    (candidate) =>
      candidate.ref.relativeLine === draft.target.ref.relativeLine &&
      candidate.ref.originalMarkdown === draft.target.ref.originalMarkdown,
  );
  const sourceMatches = parent.node.comments.filter(
    (candidate) => candidate.ref.originalMarkdown === draft.target.ref.originalMarkdown,
  );
  const comment: TaskCommentSnapshot | undefined = uniqueExactOrSource(exact, sourceMatches);
  return comment ? { type: 'comment', ref: comment.ref } : undefined;
}

export function rebaseRightPanelDraft(
  draft: RightPanelDraftState,
  currentRoot: TaskSnapshot,
): RightPanelDraftState | undefined {
  if (draft.kind === 'existing-comment') {
    const target = rebaseComment(currentRoot, draft);
    return target ? { ...draft, target } : undefined;
  }
  if (draft.kind === 'title') {
    const target = rebaseNode(currentRoot, draft.target.target)?.ref;
    return target ? { ...draft, target: { type: 'title', target } } : undefined;
  }
  if (draft.kind === 'description') {
    const target = rebaseNode(currentRoot, draft.target.target)?.ref;
    return target ? { ...draft, target: { type: 'description', target } } : undefined;
  }
  if (draft.kind === 'new-comment' || draft.kind === 'new-subtask') {
    const parent = rebaseNode(currentRoot, draft.parent)?.ref;
    return parent ? { ...draft, parent } : undefined;
  }
  if (draft.kind === 'recurrence-editor') {
    const target = rebaseNode(currentRoot, draft.target)?.ref;
    return target ? { ...draft, target } : undefined;
  }
  return undefined;
}

export function draftPlainText(draft: RightPanelDraftState): string {
  if (draft.kind === 'recurrence-editor') {
    const editor = draft.editor;
    if (editor.mode === 'custom') return editor.customDraft;
    const parsed =
      editor.preset === 'weekdays'
        ? { type: 'valid' as const, raw: `every weekday${editor.whenDone ? ' when done' : ''}` }
        : buildRecurrenceRule({
            interval: Number(editor.intervalText),
            unit: editor.unit,
            weekdays: editor.weekdays,
            monthly: editor.monthly,
            yearly: editor.yearly,
            whenDone: editor.whenDone,
          });
    const recurrence = parsed.type === 'valid' ? parsed.raw : 'invalid structured recurrence';
    const details = [
      `preset: ${editor.preset ?? 'customized'}`,
      `interval: ${editor.intervalText}`,
      `unit: ${editor.unit}`,
      `weekdays: ${editor.weekdays.join(', ')}`,
      `monthly: ${JSON.stringify(editor.monthly)}`,
      `yearly: ${JSON.stringify(editor.yearly)}`,
      `when done: ${editor.whenDone ? 'yes' : 'no'}`,
      `on completion: ${editor.onCompletion}`,
    ];
    return [recurrence, ...details].join('\n');
  }
  return draft.value;
}

export function isDirtyDraft(draft: RightPanelDraftState | undefined): boolean {
  if (!draft) return false;
  return draft.kind === 'recurrence-editor' ? draft.editor.dirty : draft.dirty;
}

export function isDirtyDraftBundle(bundle: RightPanelDraftBundle | undefined): boolean {
  return bundle?.entries.some(isDirtyDraft) ?? false;
}

function nodeRefKey(target: TaskNodeRef): unknown {
  const path: Array<readonly [number, string]> = [];
  let current = target;
  while (current.type === 'subtask') {
    path.push([current.ref.relativeLine, current.ref.originalBlock]);
    current = current.ref.parent;
  }
  path.reverse();
  return [current.ref, path];
}

export function draftIdentity(draft: RightPanelDraftState): string {
  if (draft.kind === 'title' || draft.kind === 'description') {
    return JSON.stringify([draft.kind, nodeRefKey(draft.target.target)]);
  }
  if (draft.kind === 'existing-comment') {
    return JSON.stringify([
      draft.kind,
      nodeRefKey(draft.target.ref.parent),
      draft.target.ref.relativeLine,
      draft.target.ref.originalMarkdown,
    ]);
  }
  if (draft.kind === 'new-comment' || draft.kind === 'new-subtask') {
    return JSON.stringify([draft.kind, nodeRefKey(draft.parent)]);
  }
  return JSON.stringify([draft.kind, nodeRefKey('target' in draft ? draft.target : draft.parent)]);
}
