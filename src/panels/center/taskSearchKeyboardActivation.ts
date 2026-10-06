import type { Component } from 'obsidian';
import { isImeOwnedEvent } from '../../ui/ime';

/** Search cards and contributing child headers share one direct-target activation policy. */
export function mountTaskSearchKeyboardActivation(
  element: HTMLElement,
  component: Component,
  activate: () => void,
): void {
  element.tabIndex = 0;
  component.registerDomEvent(element, 'keydown', (event) => {
    if (
      event.target !== element ||
      isImeOwnedEvent(event) ||
      (event.key !== 'Enter' && event.key !== ' ')
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    activate();
  });
}
