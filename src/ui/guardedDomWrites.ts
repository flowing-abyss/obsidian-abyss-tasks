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

export function writeTitle(element: HTMLElement, value: string): void {
  if (element.title !== value) element.title = value;
}

export function writeClass(element: HTMLElement, name: string, present: boolean): void {
  if (element.classList.contains(name) !== present) element.toggleClass(name, present);
}
