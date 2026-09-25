import { describe, expect, it, vi } from 'vitest';
import { prefersReducedMotion } from '../src/ui/reducedMotion';
import { expectDefined } from './helpers';

const QUERY = '(prefers-reduced-motion: reduce)';

/** A `matchMedia` that gives `answers` to successive calls. */
function answering(...answers: boolean[]) {
  const matchMedia = vi.fn<(query: string) => Pick<MediaQueryList, 'matches'>>();
  for (const matches of answers) matchMedia.mockReturnValueOnce({ matches });
  return matchMedia;
}

function withMatchMedia(ownerWindow: Window, matchMedia: (query: string) => unknown): void {
  Object.defineProperty(ownerWindow, 'matchMedia', { configurable: true, value: matchMedia });
}

describe('prefersReducedMotion', () => {
  it('answers no for a window without matchMedia, as jsdom main and iframe windows are', () => {
    const iframe = document.body.createEl('iframe');
    try {
      const popout = expectDefined(iframe.contentWindow);
      expect(typeof window.matchMedia).toBe('undefined');
      expect(typeof popout.matchMedia).toBe('undefined');

      expect(prefersReducedMotion(window)).toBe(false);
      expect(prefersReducedMotion(popout)).toBe(false);
    } finally {
      iframe.remove();
    }
  });

  it('answers no without a window', () => {
    expect(prefersReducedMotion(null)).toBe(false);
    expect(prefersReducedMotion(undefined)).toBe(false);
  });

  it("follows the owner window's answer to the exact query, read at each call", () => {
    const iframe = document.body.createEl('iframe');
    try {
      const popout = expectDefined(iframe.contentWindow);
      const matchMedia = answering(true, false);
      withMatchMedia(popout, matchMedia);

      expect(prefersReducedMotion(popout)).toBe(true);
      expect(prefersReducedMotion(popout)).toBe(false);
      expect(matchMedia.mock.calls).toEqual([[QUERY], [QUERY]]);
    } finally {
      iframe.remove();
    }
  });

  it('asks the owner window, not the main window', () => {
    const iframe = document.body.createEl('iframe');
    try {
      const popout = expectDefined(iframe.contentWindow);
      const main = answering(true);
      vi.stubGlobal('matchMedia', main);
      const owner = answering(false);
      withMatchMedia(popout, owner);

      expect(prefersReducedMotion(popout)).toBe(false);
      expect(owner).toHaveBeenCalledExactlyOnceWith(QUERY);
      expect(main).not.toHaveBeenCalled();
    } finally {
      iframe.remove();
    }
  });
});
