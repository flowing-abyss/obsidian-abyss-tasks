import { setIcon, setTooltip, type Component } from 'obsidian';
import type { ShowInTaskList } from '../panels/right/inspectorTypes';
import { taskNodeRef, type TaskSelectionNode } from './taskSelection';

/** A parent reveal belongs to the finite lifetime of the card that offered it. */
export function renderTaskParentButton(
  container: HTMLElement,
  parent: TaskSelectionNode,
  owner: Component,
  actions: {
    readonly show: ShowInTaskList;
    readonly isCurrent: () => boolean;
    readonly reportFailure: (error: unknown) => void;
  },
): HTMLButtonElement {
  const controller = new AbortController();
  owner.register(() => {
    controller.abort();
  });
  const current = (): boolean => !controller.signal.aborted && actions.isCurrent();
  const label = `Show parent: ${parent.title}`;
  const button = container.createEl('button', {
    cls: 'abyss-task-parent-btn clickable-icon',
    attr: { 'aria-label': label, draggable: 'false' },
  });
  setIcon(button, 'corner-down-right');
  setTooltip(button, label);
  const activate = (event: Event): void => {
    event.stopPropagation();
    event.preventDefault();
    if (!current()) return;
    void actions
      .show(taskNodeRef(parent), { signal: controller.signal, isCurrent: current })
      .catch((error: unknown) => {
        if (current()) actions.reportFailure(error);
      });
  };
  owner.registerDomEvent(button, 'click', activate);
  owner.registerDomEvent(button, 'keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') activate(event);
    else if (event.key !== 'Tab') event.stopPropagation();
  });
  owner.registerDomEvent(button, 'focusin', (event) => {
    event.stopPropagation();
  });
  owner.registerDomEvent(button, 'pointerdown', (event) => {
    event.stopPropagation();
  });
  owner.registerDomEvent(button, 'mousedown', (event) => {
    // A draggable ancestor can receive native dragstart even when pointerdown did not bubble.
    // Cancel that default while retaining ordinary button focus.
    event.stopPropagation();
    event.preventDefault();
    if (current()) button.focus({ preventScroll: true });
  });
  for (const type of ['dragstart', 'contextmenu'] as const)
    owner.registerDomEvent(button, type, (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
  return button;
}
