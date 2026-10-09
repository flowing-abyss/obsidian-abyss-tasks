import type { ListSelection } from '../../app/AppState';
import { sameTag } from '../../markdown/tagSyntax';
import type { CalendarSettings } from '../../settings/types';
import { todayTaskCategory } from '../../task-lists/todayTaskCategory';
import type { LocalDate, SubtaskSnapshot, TaskSnapshot } from '../../tasks';

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
  const date = root.planning.due ?? root.planning.scheduled;
  if (date !== undefined && date > today) selection = 'upcoming';
  if (todayTaskCategory(root, today) !== undefined) selection = 'today';
  const tag = configuredTags.find((value) => hasTreeTag(root, value));
  if (tag !== undefined) selection = { type: 'tag', tag };
  if (projectPaths.has(root.source.filePath))
    selection = { type: 'project', path: root.source.filePath };
  return selection;
}
