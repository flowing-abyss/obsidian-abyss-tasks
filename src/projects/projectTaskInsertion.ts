import type { ProjectsSettings } from '../settings/types';
import type { TaskInsertionPolicy } from '../tasks';

export function projectTaskInsertion(
  settings: ProjectsSettings,
  action: 'capture' | 'move',
): TaskInsertionPolicy {
  if (
    settings.taskInsertionMode === 'section' &&
    (action === 'move' || settings.taskInsertionSection.trim().length > 0)
  ) {
    return {
      type: 'section',
      heading: settings.taskInsertionSection,
      position: settings.taskInsertionSectionPosition,
    };
  }
  return { type: settings.taskInsertionMode === 'prepend' ? 'prepend' : 'append' };
}
