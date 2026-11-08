import { setIcon } from 'obsidian';
/** Shared date glyph and label; the caller owns the native button or readonly field. */
export function createProjectDateParts(host: HTMLElement, fieldId: string): HTMLElement {
  setIcon(host.createSpan(), fieldId === 'start' ? 'calendar-arrow-up' : 'calendar-check');
  return host.createSpan();
}
