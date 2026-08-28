import type { TaskRef } from '../../tasks';

/** The one right-inspector identity, deliberately separate from task snapshots. */
export type InspectorSelection =
  | { readonly type: 'task'; readonly task: TaskRef }
  | { readonly type: 'project'; readonly path: string }
  | { readonly type: 'work-note'; readonly path: string; readonly projectPath: string };

export interface InspectorFocusOrigin {
  readonly selection: InspectorSelection;
  readonly element: HTMLElement | null;
}

export function inspectorSelectionKey(selection: InspectorSelection): string {
  if (selection.type === 'project') return `project:${selection.path}`;
  if (selection.type === 'work-note') return `work-note:${selection.path}`;
  return `task:${selection.task.filePath}\0${String(selection.task.line)}`;
}

/** Rebase path-backed inspector identities after an Obsidian vault rename. */
export function rebaseInspectorSelectionPath(
  selection: InspectorSelection,
  oldPath: string,
  newPath: string,
): InspectorSelection {
  if (selection.type === 'project') {
    return selection.path === oldPath ? { type: 'project', path: newPath } : selection;
  }
  if (selection.type === 'work-note') {
    const path = selection.path === oldPath ? newPath : selection.path;
    const projectPath = selection.projectPath === oldPath ? newPath : selection.projectPath;
    return path === selection.path && projectPath === selection.projectPath
      ? selection
      : { type: 'work-note', path, projectPath };
  }
  if (selection.task.filePath !== oldPath) return selection;
  return { type: 'task', task: { ...selection.task, filePath: newPath } };
}

export interface InspectorSelectionInput {
  readonly project: Extract<InspectorSelection, { readonly type: 'project' }>;
  readonly activeScope: 'tasks' | 'work-notes';
  readonly task?: Extract<InspectorSelection, { readonly type: 'task' }>;
  readonly workNote?: Extract<InspectorSelection, { readonly type: 'work-note' }>;
  /** A filtered or hidden child remains remembered, but is not effective. */
  readonly taskVisible?: boolean;
  /** A filtered or hidden child remains remembered, but is not effective. */
  readonly workNoteVisible?: boolean;
}

/** Resolves the visible inspector without mutating scope-local remembered selections. */
export function deriveInspectorSelection(input: InspectorSelectionInput): InspectorSelection {
  if (input.activeScope === 'tasks' && input.task && input.taskVisible !== false) return input.task;
  if (input.activeScope === 'work-notes' && input.workNote && input.workNoteVisible !== false) {
    return input.workNote;
  }
  return input.project;
}
