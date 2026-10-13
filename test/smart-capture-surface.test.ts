import { Menu } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import { localDate, type TaskCreateRequest } from '../src/tasks';
import { MarkdownTaskCreatePreview } from '../src/tasks/infrastructure/markdown/MarkdownTaskCreatePreview';
import { CaptureSurface } from '../src/ui/taskCapture/CaptureSurface';
import { TaskCaptureController } from '../src/ui/taskCapture/TaskCaptureController';
import { describeTaskCreationResult } from '../src/ui/taskCommandResult';
import { expectDefined } from './helpers';
import { codec, recognizer, reference } from './support/taskInputHarness';
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.empty();
});
function harness() {
  vi.useFakeTimers();
  const port = new MarkdownTaskCreatePreview(codec);
  const execute = vi.fn(async (_request: TaskCreateRequest) => ({
    type: 'io-error' as const,
    cause: 'test',
    contentState: 'unchanged' as const,
  }));
  const host = document.body.createDiv();
  const controller = new TaskCaptureController({
    target: {
      label: 'Inbox',
      context: { type: 'list', selection: 'inbox' },
      session: {
        type: 'ready',
        destination: { filePath: 'Inbox.md', insertion: { type: 'append' } },
        preview: (request) =>
          port.preview({ ...request, today: localDate('2026-10-13'), addCreatedDate: false }),
        execute,
      },
      markdownPrefix: '',
      markdownSuffixes: [],
    },
    smart: {
      recognizer,
      readReference: () => reference,
      enabled: () => true,
      onRecognitionFailure: vi.fn(),
    },
    describe: describeTaskCreationResult,
    onResult: vi.fn(),
    onRequestClose: vi.fn(),
  });
  const surface = new CaptureSurface(host, controller, { getTagColor: () => '#ff0000' });
  surface.focus();
  const type = (raw: string) => {
    surface.input.value = raw;
    surface.input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const button = (label: string) =>
    expectDefined(host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`));
  return { host, controller, surface, type, button, execute };
}
it('keeps raw input, selection, mounted node and metadata controls stable across remove and Restore', () => {
  const h = harness();
  const raw = 'Call tomorrow #work';
  h.type(raw);
  vi.advanceTimersByTime(24);
  const input = h.surface.input;
  input.setSelectionRange(2, 5);
  const write = vi.spyOn(input, 'value', 'set');
  const focus = vi.spyOn(input, 'focus');
  const remove = h.button('Remove #work');
  expect(remove.parentElement?.querySelector('button button')).toBeNull();
  remove.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  remove.click();
  expect(input.value).toBe(raw);
  expect(input.selectionStart).toBe(2);
  expect(input.selectionEnd).toBe(5);
  h.button('Restore').click();
  expect(h.surface.input).toBe(input);
  expect(write).not.toHaveBeenCalled();
  expect(focus).not.toHaveBeenCalled();
  expect(h.host.querySelector('.abyss-task-tag--colored')?.textContent).toBe('#work');
  h.surface.destroy();
});
it('keeps input-to-date-to-picker owned and settles actual picker value before one outside write', async () => {
  const h = harness();
  h.type('Позвонить завтра');
  vi.advanceTimersByTime(24);
  const date = h.button('Edit due date');
  date.focus();
  h.surface.input.dispatchEvent(new FocusEvent('blur', { relatedTarget: date }));
  vi.runAllTimers();
  expect(h.execute).not.toHaveBeenCalled();
  date.click();
  vi.runAllTimers();
  const picker = expectDefined(h.host.querySelector<HTMLInputElement>('input[type="date"]'));
  picker.value = '2026-10-20';
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  picker.dispatchEvent(new FocusEvent('blur'));
  await vi.runAllTimersAsync();
  expect(h.execute).toHaveBeenCalledTimes(1);
  expect(h.execute.mock.calls[0]?.[0].initial?.due).toEqual({ type: 'set', value: '2026-10-20' });
  h.surface.destroy();
});
it('blocks invalid picker through outside events and delayed blur and shows inline feedback', async () => {
  const h = harness();
  h.type('Call tomorrow');
  vi.advanceTimersByTime(24);
  h.button('Edit due date').click();
  vi.runAllTimers();
  const picker = expectDefined(h.host.querySelector<HTMLInputElement>('input[type="date"]'));
  picker.value = '0202-01-01';
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  picker.dispatchEvent(new FocusEvent('blur'));
  await vi.advanceTimersByTimeAsync(250);
  expect(picker.isConnected).toBe(true);
  expect(h.execute).not.toHaveBeenCalled();
  expect(h.host.textContent).toContain('Enter a complete date');
  h.surface.destroy();
});
it('repairs disappearing keyboard control focus to Restore without resetting the input', () => {
  const h = harness();
  h.type('Call #work');
  vi.advanceTimersByTime(24);
  h.button('Remove #work').focus();
  h.button('Remove #work').click();
  expect(document.activeElement).toBe(h.button('Restore'));
  h.surface.destroy();
});
it('coalesces typing and synchronously flushes Enter while ignoring IME keys', async () => {
  const h = harness();
  const recognize = vi.spyOn(recognizer, 'recognize');
  h.type('Call');
  h.type('Call tomorrow');
  expect(recognize).not.toHaveBeenCalled();
  h.surface.input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
  );
  expect(h.execute).not.toHaveBeenCalled();
  h.surface.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.runAllTimersAsync();
  expect(h.execute.mock.calls[0]?.[0].initial?.due).toEqual({ type: 'set', value: '2026-10-14' });
  h.surface.destroy();
});

it('processes the final composition input before a pending outside exit and keeps the old suppression', async () => {
  const h = harness();
  h.type('Call tomorrow');
  vi.advanceTimersByTime(24);
  h.button('Remove due date').click();
  h.surface.input.dispatchEvent(new CompositionEvent('compositionstart'));
  h.type('Call tom');
  document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(30);
  expect(h.execute).not.toHaveBeenCalled();
  h.surface.input.dispatchEvent(new CompositionEvent('compositionend'));
  h.type('Call tomorrow');
  await vi.runAllTimersAsync();
  expect(h.execute).toHaveBeenCalledOnce();
  expect(h.execute.mock.calls[0]?.[0].markdownBody).toBe('Call tomorrow');
  expect(h.execute.mock.calls[0]?.[0].initial?.due).toEqual({ type: 'clear' });
  h.surface.destroy();
});
it('closes only the child picker on Escape and keeps stable badge focus across incidental renders', () => {
  const h = harness();
  h.type('Call tomorrow');
  vi.advanceTimersByTime(24);
  const date = h.button('Edit due date');
  date.focus();
  h.controller.flushRecognition();
  expect(document.activeElement).toBe(date);
  expect(h.button('Edit due date')).toBe(date);
  date.click();
  vi.runAllTimers();
  const picker = expectDefined(h.host.querySelector<HTMLInputElement>('input[type="date"]'));
  picker.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  expect(picker.isConnected).toBe(false);
  expect(document.activeElement).toBe(date);
  expect(h.controller.snapshot().phase).toBe('idle');
  expect(h.execute).not.toHaveBeenCalled();
  h.surface.destroy();
});
it('drops coalesced recognition and child work on destroy', async () => {
  const h = harness();
  const recognize = vi.spyOn(recognizer, 'recognize');
  h.type('Call tomorrow');
  h.surface.destroy();
  await vi.runAllTimersAsync();
  expect(recognize).not.toHaveBeenCalled();
  expect(h.execute).not.toHaveBeenCalled();
});

it('repairs focus when the focused due cross becomes hidden', () => {
  const h = harness();
  h.type('Call tomorrow');
  vi.advanceTimersByTime(24);
  h.button('Remove due date').focus();
  h.button('Remove due date').click();
  expect(document.activeElement).toBe(h.button('Restore'));
  h.surface.destroy();
});

it('closes capture once when Escape is pressed on a metadata control', () => {
  const h = harness();
  h.type('Call tomorrow');
  vi.advanceTimersByTime(24);
  const date = h.button('Edit due date');
  date.focus();
  const escape = vi.spyOn(h.controller, 'escape');
  date.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  expect(escape).toHaveBeenCalledOnce();
  expect(h.controller.snapshot().phase).toBe('closed');
  h.surface.destroy();
});

it('owns a native menu before first focus and returns nested Escape to its opener', async () => {
  const h = harness();
  let portal: HTMLElement | undefined;
  vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
    portal = document.body.createDiv({ cls: 'menu' });
    portal.createDiv({ cls: 'menu-item', text: 'Date choice' });
    return this;
  });
  h.type('Call tomorrow and послезавтра');
  vi.advanceTimersByTime(24);
  const opener = expectDefined(
    Array.from(h.host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Choose date',
    ),
  );
  opener.click();
  vi.runAllTimers();
  const item = expectDefined(portal?.querySelector<HTMLElement>('.menu-item'));
  expect(document.activeElement).toBe(item);
  expect(h.execute).not.toHaveBeenCalled();
  item.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  expect(document.activeElement).toBe(opener);
  expect(h.controller.snapshot().phase).toBe('idle');
  h.surface.destroy();
  portal?.remove();
});

it('does not execute a stale remove after flushing a newer input revision', () => {
  const h = harness();
  h.type('Call #work');
  vi.advanceTimersByTime(24);
  const stale = h.button('Remove #work');
  h.type('Call #other');
  stale.click();
  expect(h.controller.snapshot().metadata?.canRestore).toBe(false);
  expect(h.controller.snapshot().metadata?.preview).toMatchObject({
    type: 'valid',
    metadata: { tags: ['#other'] },
  });
  h.surface.destroy();
});

it('shows sanitized recognition failure while retaining explicit metadata controls', () => {
  const h = harness();
  vi.spyOn(recognizer, 'recognize').mockImplementation(() => {
    throw new Error('private input details');
  });
  h.type('Call tomorrow');
  vi.advanceTimersByTime(24);
  expect(h.host.textContent).toContain('Could not recognize dates and times');
  expect(h.host.textContent).not.toContain('private input details');
  expect(h.button('Edit due date').isConnected).toBe(true);
  h.surface.destroy();
});

it.each([false, true])(
  'settles a retained picker before raw Enter, valid replacement %s',
  async (valid) => {
    const h = harness();
    h.type('Call tomorrow');
    vi.advanceTimersByTime(24);
    h.button('Edit due date').click();
    vi.runAllTimers();
    const picker = expectDefined(h.host.querySelector<HTMLInputElement>('input[type="date"]'));
    picker.value = '0202-01-01';
    h.surface.input.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    h.surface.input.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    h.surface.input.focus();
    await vi.advanceTimersByTimeAsync(250);
    expect(picker.isConnected).toBe(true);
    expect(document.activeElement).toBe(h.surface.input);
    expect(h.execute).not.toHaveBeenCalled();
    if (valid) picker.value = '2026-10-20';
    const enter = () =>
      h.surface.input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
    enter();
    enter();
    await vi.runAllTimersAsync();
    if (valid) {
      expect(h.execute).toHaveBeenCalledOnce();
      expect(h.execute.mock.calls[0]?.[0].initial?.due).toEqual({
        type: 'set',
        value: '2026-10-20',
      });
      expect(picker.isConnected).toBe(false);
      // A known unchanged failure still permits a subsequent explicit Enter retry.
      enter();
      await vi.runAllTimersAsync();
      expect(h.execute).toHaveBeenCalledTimes(2);
    } else {
      expect(h.execute).not.toHaveBeenCalled();
      expect(picker.isConnected).toBe(true);
      expect(h.host.textContent).toContain('Enter a complete date');
      expect(document.activeElement).toBe(picker);
    }
    h.surface.destroy();
  },
);
it('keeps unknown execution latched across repeated raw Enter settlement', async () => {
  const h = harness();
  h.execute.mockRejectedValueOnce(new Error('unknown write'));
  h.type('Call tomorrow');
  h.surface.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.runAllTimersAsync();
  h.surface.input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.runAllTimersAsync();
  expect(h.execute).toHaveBeenCalledOnce();
  expect(h.controller.snapshot().metadata?.needsCheckedRetry).toBe(true);
  h.surface.destroy();
});

it('keeps Enter on a metadata body action inside the capture', async () => {
  const h = harness();
  h.type('Call tomorrow');
  vi.advanceTimersByTime(24);
  const date = h.button('Edit due date');
  date.focus();
  date.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  date.click();
  await vi.runAllTimersAsync();
  expect(h.host.querySelector('input[type="date"]')).not.toBeNull();
  expect(h.execute).not.toHaveBeenCalled();
  h.surface.destroy();
});
