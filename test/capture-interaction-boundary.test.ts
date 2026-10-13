import { afterEach, expect, it, vi } from 'vitest';
import { CaptureInteractionBoundary } from '../src/ui/taskCapture/CaptureInteractionBoundary';
afterEach(() => {
  vi.useRealTimers();
  document.body.empty();
});
function harness() {
  vi.useFakeTimers();
  const host = document.body.createDiv();
  const input = host.createEl('input');
  const calls: string[] = [];
  const boundary = new CaptureInteractionBoundary(host, {
    flushInput: () => {
      calls.push('input');
      return 'ready';
    },
    submit: () => {
      calls.push('submit');
    },
    isLive: () => host.isConnected,
  });
  input.focus();
  return { host, input, calls, boundary };
}
it('settles owned portals before the latest input and coalesces proven exits', () => {
  const h = harness();
  const portal = document.body.createDiv();
  const button = portal.createEl('button');
  h.boundary.register(portal, {
    flush: () => {
      h.calls.push('picker');
      return 'ready';
    },
  });
  button.focus();
  vi.runAllTimers();
  expect(h.calls).toEqual([]);
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  h.boundary.requestExit({ type: 'focus', relatedTarget: document.body });
  vi.runAllTimers();
  expect(h.calls).toEqual(['picker', 'input', 'submit']);
  h.boundary.destroy();
});
it('keeps a blocked child and cancels all pending work on destruction', () => {
  const h = harness();
  const cancel = vi.fn();
  h.boundary.register(document.body.createDiv(), { flush: () => 'blocked', cancel });
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  vi.runAllTimers();
  expect(h.calls).toEqual([]);
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  h.boundary.destroy();
  vi.runAllTimers();
  expect(h.calls).toEqual([]);
  expect(cancel).toHaveBeenCalledOnce();
});
it('ignores null blur and window blur, waits for IME final input, cancels exit on owned return', () => {
  const h = harness();
  h.boundary.requestExit({ type: 'focus', relatedTarget: null });
  window.dispatchEvent(new Event('blur'));
  vi.runAllTimers();
  expect(h.calls).toEqual([]);
  h.boundary.beginComposition();
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  vi.runAllTimers();
  expect(h.calls).toEqual([]);
  h.boundary.endComposition();
  h.calls.push('final-input');
  vi.runAllTimers();
  expect(h.calls).toEqual(['final-input', 'input', 'submit']);
  h.calls.length = 0;
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  h.input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  vi.runAllTimers();
  expect(h.calls).toEqual([]);
  h.boundary.destroy();
});

it('uses a later outside focusin as proof after a null blur', () => {
  const h = harness();
  h.boundary.requestExit({ type: 'focus', relatedTarget: null });
  const outside = document.body.createEl('button');
  outside.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  vi.runAllTimers();
  expect(h.calls).toEqual(['input', 'submit']);
  h.boundary.destroy();
});

it('uses the child-input-submit path for explicit Enter and cancels queued outside exit', () => {
  const h = harness();
  const flush = vi.fn(() => {
    h.calls.push('picker');
    return 'ready' as const;
  });
  h.boundary.register(document.body.createDiv(), { flush });
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  h.boundary.requestSubmit();
  vi.runAllTimers();
  expect(flush).toHaveBeenCalledExactlyOnceWith('enter');
  expect(h.calls).toEqual(['picker', 'input', 'submit']);
  h.boundary.destroy();
});
it('blocks explicit Enter before raw flush for an invalid child, composition or disposed owner', () => {
  const h = harness();
  const flush = vi.fn(() => 'blocked' as const);
  h.boundary.register(document.body.createDiv(), { flush });
  h.boundary.beginComposition();
  h.boundary.requestSubmit();
  expect(flush).not.toHaveBeenCalled();
  h.boundary.endComposition();
  h.boundary.requestSubmit();
  expect(flush).toHaveBeenCalledExactlyOnceWith('enter');
  expect(h.calls).toEqual([]);
  h.boundary.destroy();
  h.boundary.requestSubmit();
  expect(flush).toHaveBeenCalledOnce();
});
