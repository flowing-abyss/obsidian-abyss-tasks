import { setIcon } from 'obsidian';
import { NEXT_ACTION_TAG } from '../../projects/NextActionService';
import type { TaskSnapshot } from '../../tasks';

interface NextActionControlOptions {
  readonly task: TaskSnapshot;
  readonly onSet: () => void;
  readonly onClear: () => void;
}

/** Mounts only the native icon button; callers must not reserve a wrapper or empty slot. */
export function renderNextActionControl(
  parent: HTMLElement,
  options: NextActionControlOptions,
): HTMLButtonElement | null {
  const active = options.task.tags.includes(NEXT_ACTION_TAG);
  if (!active && options.task.status !== 'open' && options.task.status !== 'in-progress')
    return null;
  const label = active ? 'Clear Next Action' : 'Set as Next Action';
  const button = parent.createEl('button', {
    cls: 'abyss-project-next-action abyss-task-next-action',
    attr: { type: 'button', 'aria-label': label, title: label },
  });
  setIcon(button, active ? 'list-x' : 'list-checks');
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (active) options.onClear();
    else options.onSet();
  });
  return button;
}
