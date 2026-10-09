import { Component, setIcon, setTooltip } from 'obsidian';
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
  let cancelPress: (() => void) | undefined;
  owner.registerDomEvent(button, 'pointerdown', (event) => {
    event.stopPropagation();
    cancelPress?.();
    if (event.button === 0 && current()) cancelPress = guardParentPress(button, event, owner);
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

/** A moved press can dispatch click on an ancestor, outside the button's own listeners. */
function guardParentPress(
  button: HTMLButtonElement,
  start: PointerEvent,
  owner: Component,
): (() => void) | undefined {
  const doc = button.ownerDocument;
  const win = doc.defaultView;
  if (win === null) return undefined;
  const gesture = owner.addChild(new Component());
  const finish = (): void => {
    owner.removeChild(gesture);
  };
  let abandoned = false;
  const observe = (event: PointerEvent): void => {
    if (event.pointerId === start.pointerId)
      abandoned ||= Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) >= 3;
  };
  gesture.registerDomEvent(doc, 'pointermove', observe, true);
  gesture.registerDomEvent(
    doc,
    'pointerup',
    (event) => {
      if (event.pointerId !== start.pointerId) return;
      observe(event);
      gesture.registerDomEvent(
        doc,
        'click',
        (click) => {
          if (click.detail === 0 || ('pointerId' in click && click.pointerId !== start.pointerId))
            return;
          finish();
          if (abandoned || !button.contains(click.target as Node)) {
            click.preventDefault();
            click.stopImmediatePropagation();
          }
        },
        true,
      );
      // Native release and click share a turn. If no click arrives, no later action is suppressed.
      const timer = win.setTimeout(finish, 0);
      gesture.register(() => {
        win.clearTimeout(timer);
      });
    },
    true,
  );
  gesture.registerDomEvent(doc, 'pointerdown', finish, true);
  gesture.registerDomEvent(
    doc,
    'pointercancel',
    (event) => {
      if (event.pointerId === start.pointerId) finish();
    },
    true,
  );
  gesture.registerDomEvent(win, 'blur', finish);
  gesture.registerDomEvent(
    doc,
    'keydown',
    (event) => {
      if (event.key === 'Escape') abandoned = true;
    },
    true,
  );
  return finish;
}
