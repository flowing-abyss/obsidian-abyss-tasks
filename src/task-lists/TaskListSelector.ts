import type { ListSelection } from '../app/AppState';
import type { CalendarSettings, ListViewState, PropertyFilter } from '../settings/types';
import type { LocalDate, TaskSnapshot, TaskStatusType } from '../tasks/domain/types';

export interface TaskListSelectionInput {
  readonly tasks: readonly TaskSnapshot[];
  readonly selection: ListSelection;
  readonly viewState: ListViewState;
  readonly settings: CalendarSettings;
  readonly today: LocalDate;
  readonly textQuery?: string;
}

function dateOf(task: TaskSnapshot): string | undefined {
  return task.planning.due ?? task.planning.scheduled ?? task.planning.start;
}

function selected(
  task: TaskSnapshot,
  selection: ListSelection,
  settings: CalendarSettings,
  today: LocalDate,
): boolean {
  if (selection === 'inbox' || selection === 'today' || selection === 'upcoming') {
    return selectedNamedList(task, selection, settings, today);
  }
  if (typeof selection === 'string') return true;
  if (selection.type === 'tag') return task.tags.includes(selection.tag);
  if (selection.type === 'project') return task.source.filePath === selection.path;
  return selectedTagGroup(task, selection.groupId, settings);
}

function selectedNamedList(
  task: TaskSnapshot,
  selection: 'inbox' | 'today' | 'upcoming',
  settings: CalendarSettings,
  today: LocalDate,
): boolean {
  if (selection === 'inbox') return selectedInbox(task, settings);
  if (selection === 'today') return selectedToday(task, today);
  const date = task.planning.due ?? task.planning.scheduled;
  return date !== undefined && date > today;
}

function selectedInbox(task: TaskSnapshot, settings: CalendarSettings): boolean {
  const tagged = settings.inbox.mode !== 'untagged' && task.tags.includes(settings.inbox.tag);
  const untagged = settings.inbox.mode !== 'tag' && task.tags.length === 0;
  return tagged || untagged;
}

function selectedToday(task: TaskSnapshot, today: LocalDate): boolean {
  return (
    task.planning.due === today ||
    task.planning.scheduled === today ||
    (task.planning.due !== undefined && task.planning.due < today)
  );
}

function selectedTagGroup(
  task: TaskSnapshot,
  groupId: string,
  settings: CalendarSettings,
): boolean {
  const group = settings.tagGroups.find((candidate) => candidate.id === groupId);
  if (group == null) return false;
  if (group.mode === 'prefix' && group.prefix !== undefined && group.prefix.length > 0) {
    const root = `#${group.prefix}`;
    return task.tags.some((tag) => tag === root || tag.startsWith(`${root}/`));
  }
  return (group.tags ?? []).some((tag) => task.tags.includes(tag));
}

function statusTypeOf(task: TaskSnapshot): TaskStatusType {
  if (task.status === 'open') return 'todo';
  return task.status;
}

function matchesProperty(task: TaskSnapshot, filter: PropertyFilter): boolean {
  if (filter.type === 'tag') {
    return task.tags.includes(filter.value);
  }
  if (filter.type === 'file') return task.source.filePath === filter.filePath;
  if (filter.type === 'time') return String(task.planning.time) === filter.value;
  if (filter.type === 'priority') return task.priority === filter.value;
  if (filter.type === 'status') return task.statusSymbol === filter.value;
  const date = dateOf(task);
  return date !== undefined && String(date) === filter.value;
}

function compareOptional(left: string | undefined, right: string | undefined): number {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left.localeCompare(right);
}

function compareCreated(left: TaskSnapshot, right: TaskSnapshot): number {
  const a = left.planning.created;
  const b = right.planning.created;
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  return a.localeCompare(b);
}

function compare(left: TaskSnapshot, right: TaskSnapshot, input: TaskListSelectionInput): number {
  const field = input.viewState.sortBy.field;
  if (field === 'date') {
    const dateOrder = compareOptional(dateOf(left), dateOf(right));
    return dateOrder !== 0 ? dateOrder : compareOptional(left.planning.time, right.planning.time);
  }
  if (field === 'priority') return left.priority.localeCompare(right.priority);
  if (field === 'title') return left.title.localeCompare(right.title);
  if (field === 'tag') return compareOptional(left.tags[0], right.tags[0]);
  const order = input.settings.taskStatuses.map((status) => status.symbol);
  const statusOrder = (symbol: string): number => {
    const index = order.indexOf(symbol === 'X' ? 'x' : symbol);
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  return statusOrder(left.statusSymbol) - statusOrder(right.statusSymbol);
}

export function selectTaskList(input: TaskListSelectionInput): readonly TaskSnapshot[] {
  const allowed = input.viewState.statusGroups;
  const query = input.textQuery?.toLowerCase() ?? '';
  return input.tasks
    .filter((task) => selected(task, input.selection, input.settings, input.today))
    .filter(
      (task) =>
        allowed == null ||
        allowed.length === 0 ||
        allowed.length >= 4 ||
        allowed.includes(statusTypeOf(task)),
    )
    .filter((task) => input.viewState.filters.every((filter) => matchesProperty(task, filter)))
    .filter(
      (task) =>
        query.length === 0 ||
        task.title.toLowerCase().includes(query) ||
        task.source.originalMarkdown.toLowerCase().includes(query),
    )
    .slice()
    .sort((left, right) => {
      const explicit = compare(left, right, input);
      if (explicit !== 0) return input.viewState.sortBy.dir === 'asc' ? explicit : -explicit;
      return compareCreated(left, right);
    });
}

export function searchTaskList(
  tasks: readonly TaskSnapshot[],
  textQuery: string,
): readonly TaskSnapshot[] {
  const query = textQuery.toLowerCase();
  if (query.length === 0) return [];
  return tasks.filter(
    (task) =>
      task.title.toLowerCase().includes(query) ||
      task.source.originalMarkdown.toLowerCase().includes(query),
  );
}
