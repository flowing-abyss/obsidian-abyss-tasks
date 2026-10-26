import type { ListSelection } from '../../app/AppState';
import { sameTag } from '../../markdown/tagSyntax';
import type { CalendarSettings } from '../../settings/types';
import { isActiveTaskNode } from '../../task-lists/taskNodeMembership';
import { todayTaskCategory } from '../../task-lists/todayTaskCategory';
import {
  taskHasFutureDate,
  type LocalDate,
  type SubtaskSnapshot,
  type TaskSnapshot,
} from '../../tasks';

export interface TaskSearchDestinationInput {
  readonly root: TaskSnapshot;
  readonly today: LocalDate;
  readonly projectPaths: ReadonlySet<string>;
  readonly configuredTags: readonly string[];
  readonly settings: CalendarSettings;
}
function hasTreeTag(node: TaskSnapshot | SubtaskSnapshot, tag: string): boolean {
  return (
    node.tags.some((value) => sameTag(value, tag)) ||
    node.subtasks.some((child) => hasTreeTag(child, tag))
  );
}
export function taskSearchDestination(input: TaskSearchDestinationInput): ListSelection {
  const { root, today, projectPaths, configuredTags } = input;
  let selection: ListSelection = 'inbox';
  if (isActiveTaskNode(root) && taskHasFutureDate(root.planning, today)) selection = 'upcoming';
  if (todayTaskCategory(root, today) !== undefined) selection = 'today';
  const tag = configuredTags.find((value) => hasTreeTag(root, value));
  if (tag !== undefined) selection = { type: 'tag', tag };
  if (projectPaths.has(root.source.filePath))
    selection = { type: 'project', path: root.source.filePath };
  return selection;
}
