import * as obsidian from 'obsidian';
import { beforeEach, vi } from 'vitest';

/** The stock host mock is a no-op; expose its tooltip label for owner DOM assertions. */
export function useHostTooltips(): void {
  beforeEach(() => {
    vi.mocked(obsidian.setTooltip).mockImplementation((element, tooltip) => {
      element.setAttribute('aria-label', tooltip);
    });
  });
}
export function accessibleName(element: HTMLElement): string | null {
  const label = element.getAttribute('aria-labelledby');
  return label === null
    ? element.getAttribute('aria-label')
    : (element.ownerDocument.getElementById(label)?.textContent ?? null);
}
