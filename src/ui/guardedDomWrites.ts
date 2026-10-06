import { setIcon, setTooltip } from 'obsidian';

/**
 * DOM writes that do nothing when the value is already there.
 *
 * A live surface repaints on every tick and every index event, so the cheapest repaint is the one
 * that mutates nothing. These guards are what let a second pass without a single mutation record,
 * which is also how the tests prove it.
 */

export function writeText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.setText(value);
}

export function writeAttribute(element: HTMLElement, name: string, value: string): void {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

/** Writes an attribute, or removes it when the value is undefined. */
export function writeOptionalAttribute(
  element: HTMLElement,
  name: string,
  value: string | undefined,
): void {
  if (value === undefined) {
    if (element.hasAttribute(name)) element.removeAttribute(name);
  } else writeAttribute(element, name, value);
}

const tooltips = new WeakMap<HTMLElement, string>();

export function writeTooltip(element: HTMLElement, value: string): void {
  if (tooltips.get(element) === value) return;
  tooltips.set(element, value);
  setTooltip(element, value);
}

let controlNameSequence = 0;

/** A connected owner label keeps a control's action name independent of its tooltip. */
export function createControlName(control: HTMLElement, owner: HTMLElement): HTMLElement {
  const name = owner.createSpan({
    cls: 'abyss-sr-only',
    attr: { id: `abyss-control-name-${String(++controlNameSequence)}` },
  });
  control.setAttribute('aria-labelledby', name.id);
  return name;
}

export function writeClass(element: HTMLElement, name: string, present: boolean): void {
  if (element.classList.contains(name) !== present) element.toggleClass(name, present);
}

/** Replaces the icon only when it changes; `data-icon` records the one drawn. */
export function writeIcon(element: HTMLElement, icon: string): void {
  if (element.dataset['icon'] === icon) return;
  element.empty();
  writeOptionalAttribute(element, 'data-icon', icon);
  setIcon(element, icon);
}
