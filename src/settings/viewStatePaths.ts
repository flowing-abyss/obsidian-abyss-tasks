import { listSelectionToKey } from '../app/listViewState';
import { forgetProjectPath, renameProjectPath } from '../projects/projectKanbanModel';
import type { CalendarSettings, ListViewState, PropertyFilter } from './types';

/** A Markdown note's delete or rename, as saved view state reads it. */
export type NotePathChange =
  | { readonly type: 'deleted'; readonly path: string }
  | { readonly type: 'renamed'; readonly oldPath: string; readonly path: string };

function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : '';
}

/** A deleted file's meaning for saved view state: only a Markdown note has any. */
export function noteDeleteChange(path: string, extension: string): NotePathChange | undefined {
  return extension === 'md' ? { type: 'deleted', path } : undefined;
}

/** A renamed file's meaning: a note rename, a delete when it stops being a note, or nothing. */
export function noteRenameChange(
  oldPath: string,
  path: string,
  extension: string,
): NotePathChange | undefined {
  if (extensionOf(oldPath) !== 'md') return undefined;
  return extension === 'md'
    ? { type: 'renamed', oldPath, path }
    : { type: 'deleted', path: oldPath };
}

/** Applies a note change to the saved view state that names note paths; true when anything changed. */
export function rebaseSavedNotePath(settings: CalendarSettings, change: NotePathChange): boolean {
  const ranks = rebaseKanbanRanks(settings, change);
  const lists = rebaseListStates(settings, change);
  return ranks || lists;
}

function rebaseKanbanRanks(settings: CalendarSettings, change: NotePathChange): boolean {
  const kanban = settings.projects.kanban;
  if (kanban === undefined) return false;
  const next =
    change.type === 'deleted'
      ? forgetProjectPath(kanban.manualOrder, change.path)
      : renameProjectPath(kanban.manualOrder, change.oldPath, change.path);
  if (next === undefined) return false;
  kanban.manualOrder = next;
  return true;
}

function rebaseListStates(settings: CalendarSettings, change: NotePathChange): boolean {
  const states = settings.listViewStates;
  if (states === undefined) return false;
  if (change.type === 'deleted') return forgetListState(states, change.path);
  const moved = moveProjectListState(states, change.oldPath, change.path);
  const rewritten = renameSavedFileFilters(states, change.oldPath, change.path);
  return moved || rewritten;
}

function projectKey(path: string): string {
  return listSelectionToKey({ type: 'project', path });
}

/** A `file` filter that names the note stays: it is visible intent in another list. */
function forgetListState(states: Record<string, ListViewState>, path: string): boolean {
  const key = projectKey(path);
  if (!(key in states)) return false;
  delete states[key];
  return true;
}

function moveProjectListState(
  states: Record<string, ListViewState>,
  oldPath: string,
  newPath: string,
): boolean {
  const oldKey = projectKey(oldPath);
  const newKey = projectKey(newPath);
  if (oldKey === newKey) return false;
  let changed = false;
  if (newKey in states) {
    delete states[newKey];
    changed = true;
  }
  const saved = states[oldKey];
  if (saved !== undefined) {
    states[newKey] = saved;
    delete states[oldKey];
    changed = true;
  }
  return changed;
}

function renameSavedFileFilters(
  states: Record<string, ListViewState>,
  oldPath: string,
  newPath: string,
): boolean {
  let changed = false;
  for (const key in states) {
    const state = states[key];
    if (state === undefined) continue;
    const renamed = renameFileFilters(state, oldPath, newPath);
    if (renamed === undefined) continue;
    states[key] = renamed;
    changed = true;
  }
  return changed;
}

/** The list state with its `file` filters moved to `newPath`; undefined when none names `oldPath`. */
export function renameFileFilters(
  state: ListViewState,
  oldPath: string,
  newPath: string,
): ListViewState | undefined {
  if (oldPath === newPath || !state.filters.some((filter) => namesFile(filter, oldPath))) {
    return undefined;
  }
  const renamed = state.filters.map((filter) =>
    namesFile(filter, oldPath) ? { ...filter, filePath: newPath } : filter,
  );
  return { ...state, filters: withoutDuplicateFileFilters(renamed, newPath) };
}

/** Keeps the first `file` filter for `path` and every other filter, in order, as the chip adder does. */
function withoutDuplicateFileFilters(
  filters: readonly PropertyFilter[],
  path: string,
): PropertyFilter[] {
  let kept = false;
  return filters.filter((filter) => {
    if (!namesFile(filter, path)) return true;
    if (kept) return false;
    kept = true;
    return true;
  });
}

function namesFile(
  filter: PropertyFilter,
  path: string,
): filter is Extract<PropertyFilter, { type: 'file' }> {
  return filter.type === 'file' && filter.filePath === path;
}
