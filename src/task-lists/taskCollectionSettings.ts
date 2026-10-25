import type { ListViewState } from '../settings/types';
import { normalizeTaskKanbanSettings } from './taskKanbanSettings';
import { normalizeTaskTimelineSettings } from './taskTimelineSettings';

/** Layout organization is derived; switching never overwrites saved List preferences. */
export function taskCollectionListState(view: ListViewState): ListViewState {
  if (view.view !== 'kanban' && view.view !== 'timeline') return view;
  const presentation =
    view.view === 'kanban'
      ? normalizeTaskKanbanSettings(view.kanban)
      : normalizeTaskTimelineSettings(view.timeline);
  const result = { ...view, groupBy: presentation.groupBy, sortBy: presentation.sortBy };
  delete result.statusGroups;
  return result;
}
