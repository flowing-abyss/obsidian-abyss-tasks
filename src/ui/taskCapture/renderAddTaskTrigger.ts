/** The shared bottom capture action; its owner retains the editor and return focus. */
export function renderAddTaskTrigger(
  host: HTMLElement,
  activate: (trigger: HTMLButtonElement) => void,
): HTMLButtonElement {
  const trigger = host.createEl('button', {
    cls: 'abyss-add-task-trigger',
    attr: { type: 'button' },
  });
  trigger.createSpan({ cls: 'abyss-add-task-plus', text: '+' });
  trigger.createSpan({ cls: 'abyss-add-task-label', text: 'Add task' });
  trigger.addEventListener('click', () => {
    activate(trigger);
  });
  return trigger;
}
