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
  readonly origin?: {
    readonly taskTitle: string;
    readonly filePath: string;
    readonly line: number;
  };
}

type TaskNode = TaskSnapshot | SubtaskSnapshot;

interface UniqueEntry<T> {
  candidate: T;
  count: number;
}

export interface RightPanelDraftRebaseContext {
  readonly children: WeakMap<TaskNode, ReadonlyMap<string, UniqueEntry<SubtaskSnapshot>>>;
  readonly comments: WeakMap<TaskNode, ReadonlyMap<string, UniqueEntry<TaskCommentSnapshot>>>;
}

export function createRightPanelDraftRebaseContext(): RightPanelDraftRebaseContext {
  return { children: new WeakMap(), comments: new WeakMap() };
}

function uniqueIndex<T>(
  values: readonly T[],
  source: (value: T) => string,
): ReadonlyMap<string, UniqueEntry<T>> {
  const index = new Map<string, UniqueEntry<T>>();
  for (const value of values) {
    const key = source(value);
    const entry = index.get(key);
    if (entry) entry.count += 1;
    else index.set(key, { candidate: value, count: 1 });
  }
  return index;
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
  context: RightPanelDraftRebaseContext,
): { readonly ref: TaskNodeRef; readonly node: TaskNode } | undefined {
  if (stale.type === 'task') return { ref: { type: 'task', ref: root.ref }, node: root };
  let node: TaskNode = root;
  let ref: TaskNodeRef = { type: 'task', ref: root.ref };
  for (const staleChild of childPath(stale)) {
    let index = context.children.get(node);
    if (!index) {
      index = uniqueIndex(node.subtasks, (candidate) => candidate.ref.originalBlock);
      context.children.set(node, index);
    }
    const match: UniqueEntry<SubtaskSnapshot> | undefined = index.get(staleChild.originalBlock);
    const child: SubtaskSnapshot | undefined = match?.count === 1 ? match.candidate : undefined;
    if (!child) return undefined;
    node = child;
    ref = { type: 'subtask', ref: child.ref };
  }
  return { ref, node };
}

function rebaseComment(
  root: TaskSnapshot,
  draft: Extract<RightPanelDraftState, { readonly kind: 'existing-comment' }>,
  context: RightPanelDraftRebaseContext,
): Extract<TaskTextTarget, { readonly type: 'comment' }> | undefined {
  const parent = rebaseNode(root, draft.target.ref.parent, context);
  if (!parent) return undefined;
  let index = context.comments.get(parent.node);
  if (!index) {
    index = uniqueIndex(parent.node.comments, (candidate) => candidate.ref.originalMarkdown);
    context.comments.set(parent.node, index);
  }
  const match = index.get(draft.target.ref.originalMarkdown);
  const comment: TaskCommentSnapshot | undefined = match?.count === 1 ? match.candidate : undefined;
  return comment ? { type: 'comment', ref: comment.ref } : undefined;
}

export function rebaseRightPanelDraft(
  draft: RightPanelDraftState,
  currentRoot: TaskSnapshot,
  context: RightPanelDraftRebaseContext = createRightPanelDraftRebaseContext(),
): RightPanelDraftState | undefined {
  if (draft.kind === 'existing-comment') {
    const target = rebaseComment(currentRoot, draft, context);
    return target ? { ...draft, target } : undefined;
  }
  if (draft.kind === 'title') {
    const target = rebaseNode(currentRoot, draft.target.target, context)?.ref;
    return target ? { ...draft, target: { type: 'title', target } } : undefined;
  }
  if (draft.kind === 'description') {
    const target = rebaseNode(currentRoot, draft.target.target, context)?.ref;
    return target ? { ...draft, target: { type: 'description', target } } : undefined;
  }
  if (draft.kind === 'new-comment' || draft.kind === 'new-subtask') {
    const parent = rebaseNode(currentRoot, draft.parent, context)?.ref;
    return parent ? { ...draft, parent } : undefined;
  }
  if (draft.kind === 'recurrence-editor') {
    const target = rebaseNode(currentRoot, draft.target, context)?.ref;
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
