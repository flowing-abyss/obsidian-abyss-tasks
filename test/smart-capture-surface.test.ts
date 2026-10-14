import { Menu, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { localDate, type TaskCreatePreview, type TaskCreateRequest } from '../src/tasks';
import { RecurrenceTextInputParser } from '../src/tasks/infrastructure/input/RecurrenceTextInputParser';
import { MarkdownTaskCreatePreview } from '../src/tasks/infrastructure/markdown/MarkdownTaskCreatePreview';
import { shouldShowSourcePath } from '../src/ui/sourceNoteChip';
import { CaptureSurface } from '../src/ui/taskCapture/CaptureSurface';
import {
  CaptureTargetResolver,
  type CaptureContext,
} from '../src/ui/taskCapture/CaptureTargetResolver';
import { TaskCaptureController } from '../src/ui/taskCapture/TaskCaptureController';
import { describeTaskCreationResult } from '../src/ui/taskCommandResult';
import {
  configuredTaskApplication,
  createAppWithFiles,
  deferred,
  expectDefined,
  useRealMoment,
} from './helpers';
import { codec, recognizer, reference } from './support/taskInputHarness';
useRealMoment();
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.empty();
});

async function canonicalSurface(
  context: CaptureContext,
  preferences: Partial<CalendarSettings> = {},
) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00'));
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    taskFilePath: 'tasks.md',
    taskInsertionMode: 'append' as const,
    ...preferences,
  };
  const app = await createAppWithFiles({ 'tasks.md': '', 'Projects/P.md': '' });
  const application = configuredTaskApplication(app, settings, {
    authority: true,
    capturePreview: true,
  });
  const target = await new CaptureTargetResolver(
    application.tasks,
    settings,
    () => reference.localDate,
  ).resolve(context);
  const readReference = vi.fn(() => reference);
  const recognize = vi.spyOn(recognizer, 'recognize');
  const controller = new TaskCaptureController({
    target,
    smart: {
      recognizer,
      recurrence: new RecurrenceTextInputParser(),
      readReference,
      enabled: () => true,
      onRecognitionFailure: vi.fn(),
    },
    describe: describeTaskCreationResult,
    onResult: vi.fn(),
    onRequestClose: vi.fn(),
  });
  const host = document.body.createDiv();
  const surface = new CaptureSurface(host, controller, {
    shouldShowSourceNote: (path) =>
      shouldShowSourcePath(path, settings.sourceNoteDisplay, settings.taskFilePath),
  });
  const contents = () =>
    [...host.querySelectorAll('.abyss-capture-chip-body')].map((el) => el.textContent);
  const button = (label: string) =>
    expectDefined(host.querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`));
  const description = () => host.querySelector('.abyss-capture-destination')?.textContent;
  const close = () => {
    surface.destroy();
    controller.destroy();
    application.index.destroy();
  };
  return {
    async readCreated() {
      const file = app.vault.getAbstractFileByPath('tasks.md');
      if (!(file instanceof TFile)) throw new Error('Missing created note');
      return app.vault.read(file);
    },
    settings,
    host,
    controller,
    surface,
    readReference,
    recognize,
    contents,
    button,
    description,
    close,
  };
}

describe('canonical Q context representation', () => {
  it.each([true, false])(
    'represents the Inbox service tag only through its actual caption, remove=%s',
    async (removeTagOnAssign) => {
      const h = await canonicalSurface(
        { type: 'list', selection: 'inbox' },
        {
          sourceNoteDisplay: 'always',
          inbox: { mode: 'tag', tag: '#task/inbox', removeTagOnAssign },
        },
      );
      try {
        expect(h.contents()).toEqual(['Inbox']);
        expect(h.host.querySelector('button[aria-label="Remove #task/inbox"]')).toBeNull();
        expect(h.description()).toBe('Inbox');
        h.controller.setDraft('Call #health');
        expect(h.contents()).toEqual([removeTagOnAssign ? 'tasks' : 'Inbox', '#health']);
        expect(h.description()).toBe(removeTagOnAssign ? 'tasks' : 'Inbox');
        expect(h.host.querySelector('button[aria-label="Remove #task/inbox"]')).toBeNull();
        h.button('Remove #health').focus();
        h.button('Remove #health').click();
        expect(h.contents()).toEqual(['Inbox', 'Restore']);
        expect(h.description()).toBe('Inbox');
        expect(document.activeElement).toBe(h.button('Restore'));
        h.button('Restore').click();
        expect(h.contents()).toEqual([removeTagOnAssign ? 'tasks' : 'Inbox', '#health']);
        expect(h.controller.snapshot().draft).toBe('Call #health');
        expect(h.description()).toBe(removeTagOnAssign ? 'tasks' : 'Inbox');
      } finally {
        h.close();
      }
    },
  );

  it('uses current source preferences while preserving frozen context tags and empty raw input', async () => {
    const h = await canonicalSurface(
      { type: 'list', selection: { type: 'tag', tag: '#selected' } },
      {
        taskPrefix: '#prefix',
        sourceNoteDisplay: 'non-default',
      },
    );
    try {
      expect(h.contents()).toEqual(['#selected']);
      expect(h.description()).toBe('');
      expect(h.readReference).not.toHaveBeenCalled();
      expect(h.recognize).not.toHaveBeenCalled();
      h.settings.sourceNoteDisplay = 'always';
      h.settings.taskPrefix = '#changed';
      h.controller.flushRecognition();
      expect(h.contents()).toEqual(['tasks', '#selected']);
      expect(h.description()).toBe('tasks');
      h.button('Remove #selected').click();
      expect(h.contents()).toEqual(['tasks', '#prefix', 'Restore']);
      h.button('Restore').click();
      expect(h.contents()).toEqual(['tasks', '#selected']);
      expect(h.surface.input.value).toBe('');
      h.settings.sourceNoteDisplay = 'never';
      h.controller.flushRecognition();
      expect(h.contents()).toEqual(['#selected']);
      expect(h.description()).toBe('');
    } finally {
      h.close();
    }
  });

  it.each([
    { type: 'project-dashboard', path: 'Projects/P.md' },
    { type: 'project-table', path: 'Projects/P.md' },
    { type: 'list', selection: { type: 'project', path: 'Projects/P.md' } },
  ] satisfies CaptureContext[])(
    'retains the explicit project context when generic source is hidden: $type',
    async (context) => {
      const h = await canonicalSurface(context, {
        taskPrefix: '#prefix',
        sourceNoteDisplay: 'never',
      });
      try {
        expect(h.contents()).toEqual(['P', '#prefix']);
        expect(h.description()).toBe('P');
        expect(h.readReference).not.toHaveBeenCalled();
      } finally {
        h.close();
      }
    },
  );

  it('keeps default Projects capture generic and leaves only actual extra tags after Inbox eviction', async () => {
    const h = await canonicalSurface(
      { type: 'default', source: 'projects' },
      { taskPrefix: '#prefix', sourceNoteDisplay: 'never' },
    );
    try {
      expect(h.contents()).toEqual(['#prefix']);
      expect(h.description()).toBe('');
    } finally {
      h.close();
    }
    const inbox = await canonicalSurface(
      { type: 'list', selection: 'inbox' },
      { sourceNoteDisplay: 'non-default' },
    );
    try {
      inbox.controller.setDraft('Call #health');
      expect(inbox.contents()).toEqual(['#health']);
      expect(inbox.description()).toBe('');
    } finally {
      inbox.close();
    }
  });
});
function harness(
  initial?: TaskCreateRequest['initial'],
  getDateClass?: (value: string, referenceDate?: string) => string,
) {
  vi.useFakeTimers();
  const port = new MarkdownTaskCreatePreview(codec);
  const execute = vi.fn(async (_request: TaskCreateRequest) => ({
    type: 'io-error' as const,
    cause: 'test',
    contentState: 'unchanged' as const,
  }));
  const preview = vi.fn((request: TaskCreateRequest): TaskCreatePreview =>
    port.preview({ ...request, today: localDate('2026-10-13'), addCreatedDate: false }),
  );
  const host = document.body.createDiv();
  const controller = new TaskCaptureController({
    target: {
      label: 'Inbox',
      context: { type: 'list', selection: 'inbox' },
      session: {
        type: 'ready',
        destination: { filePath: 'Inbox.md', insertion: { type: 'append' } },
        preview,
        execute,
      },
      ...(initial === undefined ? {} : { initial }),
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
  const options = {
    getTagColor: () => '#ff0000',
    ...(getDateClass === undefined ? {} : { getDateClass }),
  };
  const surface = new CaptureSurface(host, controller, options);
  surface.focus();
  const type = (raw: string) => {
    surface.input.value = raw;
    surface.input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const button = (label: string) =>
    expectDefined(host.querySelector<HTMLButtonElement>(`button[aria-label^="${label}"]`));
  return { host, controller, surface, type, button, execute, preview };
}

function ownedChoiceMenu(hideOrder: 'before' | 'after') {
  const portals = new Map<Menu, HTMLElement>();
  const callbacks = new Map<Menu, () => unknown>();
  vi.spyOn(Menu.prototype, 'onHide').mockImplementation(function (this: Menu, callback) {
    callbacks.set(this, callback);
  });
  vi.spyOn(Menu.prototype, 'hide').mockImplementation(function (this: Menu) {
    portals.get(this)?.remove();
    const callback = callbacks.get(this);
    callbacks.delete(this);
    callback?.();
    return this;
  });
  const shown: Menu[] = [];
  vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
    shown.push(this);
    const portal = document.body.createDiv({ cls: 'menu' });
    portals.set(this, portal);
    const items = (
      this as unknown as {
        menuItems__: Array<{ title__: string; onClick__: (() => void) | null }>;
      }
    ).menuItems__;
    for (const item of items) {
      const row = portal.createDiv({ cls: 'menu-item', text: item.title__ });
      row.tabIndex = -1;
      row.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        event.stopPropagation();
        if (hideOrder === 'before') this.hide();
        item.onClick__?.();
        if (hideOrder === 'after') this.hide();
      });
    }
    return this;
  });
  return {
    portal: () => expectDefined(portals.get(expectDefined(shown[shown.length - 1]))),
    hide: () => expectDefined(shown[shown.length - 1]).hide(),
    choose: (title: string) => {
      const row = expectDefined(
        [...expectDefined(portals.get(expectDefined(shown[shown.length - 1]))).children].find(
          (element) => element.textContent === title,
        ),
      ) as HTMLElement;
      row.focus();
      row.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    },
  };
}
it('starts with destination context and reveals only real policy tags and planning', () => {
  const h = harness({ tags: { add: ['#task/inbox'] } });
  const contents = () =>
    [...h.host.querySelectorAll('.abyss-capture-chip-body')].map((element) => element.textContent);
  expect(contents()).toEqual(['Inbox']);
  h.type('Call');
  vi.advanceTimersByTime(24);
  expect(contents()).toEqual(['Inbox', '#task/inbox']);
  h.type('Call tomorrow at 14:00');
  vi.advanceTimersByTime(24);
  expect(contents()).toEqual(['Inbox', '2026-10-14', '14:00', '#task/inbox']);
  h.type('Call 📅 2026-10-20');
  vi.advanceTimersByTime(24);
  expect(contents()).toEqual(['Inbox', '2026-10-20', '#task/inbox']);
  h.type('');
  vi.advanceTimersByTime(24);
  expect(contents()).toEqual(['Inbox']);
  expect(h.execute).not.toHaveBeenCalled();
  h.surface.destroy();
});
it.each([
  {
    label: 'Remove due date',
    target: '.abyss-date-icon',
    remaining: ['Inbox', '#health', 'Restore'],
  },
  {
    label: 'Remove due date',
    target: '.abyss-task-date > span:last-child',
    remaining: ['Inbox', '#health', 'Restore'],
  },
  {
    label: 'Remove time',
    target: '.abyss-date-icon',
    remaining: ['Inbox', '2026-10-14', '#health', 'Restore'],
  },
  {
    label: 'Remove time',
    target: '.abyss-task-date > span:last-child',
    remaining: ['Inbox', '2026-10-14', '#health', 'Restore'],
  },
  {
    label: 'Remove #health',
    target: '.abyss-task-tag',
    remaining: ['Inbox', '2026-10-14', '10:00', 'Restore'],
  },
])(
  'dismisses $label from $target once and restores without changing raw input',
  ({ label, target, remaining }) => {
    const h = harness();
    const raw = 'Завтра в 10:00 позвонить #health';
    h.type(raw);
    vi.advanceTimersByTime(24);
    const body = expectDefined(
      h.button(label).parentElement?.querySelector<HTMLElement>('.abyss-capture-chip-body'),
    );
    const content = expectDefined(body.querySelector(target));
    const action = vi.spyOn(h.controller, 'applyMetadataAction');
    const input = h.surface.input;
    input.setSelectionRange(2, 5);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    content.dispatchEvent(down);
    content.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(action).toHaveBeenCalledOnce();
    expect(down.defaultPrevented).toBe(true);
    expect(h.host.querySelector(`button[aria-label^="${label}"]`)).toBeNull();
    expect(
      [...h.host.querySelectorAll('.abyss-capture-chip-body')].map((el) => el.textContent),
    ).toEqual(remaining);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(raw);
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 5]);
    expect(h.host.querySelector('input[type="date"]')).toBeNull();
    h.button('Restore').click();
    expect(h.button(label).isConnected).toBe(true);
    expect(input.value).toBe(raw);
    expect(h.execute).not.toHaveBeenCalled();
    h.surface.destroy();
  },
);

it('opens secondary date editing with Shift+F10 while ignoring IME and preserving metadata', () => {
  const h = harness();
  h.type('Call tomorrow');
  vi.advanceTimersByTime(24);
  const date = h.button('Remove due date');
  date.focus();
  date.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, isComposing: true, bubbles: true }),
  );
  expect(h.host.querySelector('input[type="date"]')).toBeNull();
  const key = new KeyboardEvent('keydown', {
    key: 'F10',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  date.dispatchEvent(key);
  vi.runAllTimers();
  expect(key.defaultPrevented).toBe(true);
  expect(h.host.querySelector<HTMLInputElement>('input[type="date"]')?.value).toBe('2026-10-14');
  expect(h.controller.snapshot().metadata?.canRestore).toBe(false);
  expect(h.execute).not.toHaveBeenCalled();
  h.surface.destroy();
});

it('ignores disabled, submitting and disposed body activations', async () => {
  const h = harness();
  h.type('Call tomorrow at 10:00 #work');
  vi.advanceTimersByTime(24);
  const bodies = ['Remove due date', 'Remove time', 'Remove #work'].map(h.button);
  const action = vi.spyOn(h.controller, 'applyMetadataAction');
  const before = h.controller.snapshot().metadata;
  const pending = deferred<Awaited<ReturnType<typeof h.execute>>>();
  h.execute.mockImplementationOnce(() => pending.promise);
  const submission = h.controller.submit('enter');
  expect(h.controller.snapshot().phase).toBe('submitting');
  for (const body of bodies) {
    expect(body.disabled).toBe(true);
    body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
  }
  expect(action).not.toHaveBeenCalled();
  expect(h.host.querySelector('input[type="date"]')).toBeNull();
  expect(h.controller.snapshot().metadata).toEqual(before);
  h.surface.destroy();
  for (const body of bodies) body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  expect(action).not.toHaveBeenCalled();
  pending.resolve({ type: 'io-error', cause: 'test', contentState: 'unchanged' });
  await submission;
});

it('removes the last date and restores it while preserving raw text and repairing focus', () => {
  const h = harness();
  const raw = 'Call tomorrow';
  h.type(raw);
  vi.advanceTimersByTime(24);
  const input = h.surface.input;
  input.setSelectionRange(1, 3);
  const write = vi.spyOn(input, 'value', 'set');
  const remove = h.button('Remove due date');
  remove.focus();
  remove.click();
  expect(h.host.querySelector('button[aria-label^="Remove due date"]')).toBeNull();
  expect(remove.isConnected).toBe(false);
  expect(document.activeElement).toBe(h.button('Restore'));
  h.button('Restore').click();
  expect(h.button('Remove due date').textContent).toBe('2026-10-14');
  expect(document.activeElement).toBe(input);
  expect(h.surface.input).toBe(input);
  expect(input.value).toBe(raw);
  expect(input.selectionStart).toBe(1);
  expect(input.selectionEnd).toBe(3);
  expect(write).not.toHaveBeenCalled();
  expect(h.execute).not.toHaveBeenCalled();
  h.surface.destroy();
});
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
  const date = h.button('Remove due date');
  date.focus();
  h.surface.input.dispatchEvent(new FocusEvent('blur', { relatedTarget: date }));
  vi.runAllTimers();
  expect(h.execute).not.toHaveBeenCalled();
  date.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
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
  h.button('Remove due date').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
  );
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
  const date = h.button('Remove due date');
  date.focus();
  h.controller.flushRecognition();
  expect(document.activeElement).toBe(date);
  expect(h.button('Remove due date')).toBe(date);
  date.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
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

it('repairs focus when the focused due badge is removed', () => {
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
  const date = h.button('Remove due date');
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

it.each(['before', 'after'] as const)(
  'returns keyboard Ignore focus to Restore when the native menu hides %s its callback',
  async (hideOrder) => {
    const h = harness();
    const menu = ownedChoiceMenu(hideOrder);
    const raw = 'Call tomorrow and послезавтра';
    h.type(raw);
    vi.advanceTimersByTime(24);
    const opener = h.button('Choose date');
    opener.focus();
    opener.click();
    menu.choose('Ignore date suggestions');
    expect(document.activeElement).toBe(h.button('Restore'));
    expect(opener.isConnected).toBe(false);
    expect(menu.portal().isConnected).toBe(false);
    expect(h.surface.input.value).toBe(raw);
    expect(h.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { planning: {} },
    });
    await vi.runAllTimersAsync();
    expect(h.controller.snapshot().phase).toBe('idle');
    expect(h.execute).not.toHaveBeenCalled();
    h.surface.destroy();
  },
);

it.each(['before', 'after'] as const)(
  'returns keyboard candidate focus to its surviving opener when the native menu hides %s its callback',
  async (hideOrder) => {
    const h = harness();
    const menu = ownedChoiceMenu(hideOrder);
    const raw = 'Call tomorrow and послезавтра';
    h.type(raw);
    vi.advanceTimersByTime(24);
    const opener = h.button('Choose date');
    opener.focus();
    opener.click();
    menu.choose('2026-10-14');
    expect(document.activeElement).toBe(opener);
    expect(opener.isConnected).toBe(true);
    expect(menu.portal().isConnected).toBe(false);
    expect(h.surface.input.value).toBe(raw);
    expect(h.controller.snapshot().metadata?.preview).toMatchObject({
      type: 'valid',
      metadata: { planning: { due: '2026-10-14' } },
    });
    await vi.runAllTimersAsync();
    expect(h.controller.snapshot().phase).toBe('idle');
    expect(h.execute).not.toHaveBeenCalled();
    h.surface.destroy();
  },
);

it.each(['before', 'after'] as const)(
  'preserves the manual picker focus when the native menu hides %s its callback',
  async (hideOrder) => {
    const h = harness();
    const menu = ownedChoiceMenu(hideOrder);
    const raw = 'Call tomorrow and послезавтра';
    h.type(raw);
    vi.advanceTimersByTime(24);
    h.button('Choose date').click();
    menu.choose('Choose date…');
    const picker = expectDefined(h.host.querySelector<HTMLInputElement>('input[type="date"]'));
    await vi.runAllTimersAsync();
    expect(document.activeElement).toBe(picker);
    expect(h.surface.input.value).toBe(raw);
    expect(h.controller.snapshot().metadata?.projection?.ambiguity).toBe(true);
    expect(h.execute).not.toHaveBeenCalled();
    h.surface.destroy();
  },
);

it('preserves external focus when an owned choice menu is dismissed outside', () => {
  const h = harness();
  const menu = ownedChoiceMenu('after');
  h.type('Call tomorrow and послезавтра');
  vi.advanceTimersByTime(24);
  h.button('Choose date').click();
  const external = document.body.createEl('button');
  external.focus();
  menu.hide();
  expect(document.activeElement).toBe(external);
  expect(h.controller.snapshot().metadata?.projection?.ambiguity).toBe(true);
  expect(h.execute).not.toHaveBeenCalled();
  h.surface.destroy();
});

it.each(['input', 'Restore', 'external'] as const)(
  'preserves connected %s focus acquired while completing a menu choice',
  (target) => {
    const h = harness();
    const menu = ownedChoiceMenu('after');
    h.type('Call tomorrow and послезавтра');
    vi.advanceTimersByTime(24);
    h.button('Choose date').click();
    const external = document.body.createEl('button');
    let active: HTMLElement | undefined;
    const observer = h.controller.subscribe((snapshot) => {
      if (snapshot.metadata?.canRestore !== true) return;
      active = { input: h.surface.input, Restore: h.button('Restore'), external }[target];
      active.focus();
    });
    menu.choose('Ignore date suggestions');
    expect(document.activeElement).toBe(expectDefined(active));
    expect(h.execute).not.toHaveBeenCalled();
    observer.release();
    h.surface.destroy();
  },
);

it('returns a completed menu choice to input when Restore is disabled', async () => {
  const h = harness();
  const menu = ownedChoiceMenu('after');
  h.type('Call tomorrow and послезавтра');
  vi.advanceTimersByTime(24);
  h.button('Choose date').click();
  const observer = h.controller.subscribe((snapshot) => {
    if (snapshot.metadata?.canRestore === true) h.button('Restore').disabled = true;
  });
  menu.choose('Ignore date suggestions');
  expect(document.activeElement).toBe(h.surface.input);
  expect(h.button('Restore').disabled).toBe(true);
  await vi.runAllTimersAsync();
  expect(h.execute).not.toHaveBeenCalled();
  observer.release();
  h.surface.destroy();
});

it('returns a blocked menu choice to its surviving opener', () => {
  const h = harness();
  const menu = ownedChoiceMenu('after');
  h.type('Call tomorrow and послезавтра');
  vi.advanceTimersByTime(24);
  const opener = h.button('Choose date');
  opener.click();
  h.surface.input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  menu.choose('Ignore date suggestions');
  expect(document.activeElement).toBe(opener);
  expect(h.controller.snapshot().metadata?.projection?.ambiguity).toBe(true);
  expect(h.execute).not.toHaveBeenCalled();
  h.surface.destroy();
});

it('does not return menu choice focus after capture migrates to another document', () => {
  const h = harness();
  const menu = ownedChoiceMenu('after');
  h.type('Call tomorrow and послезавтра');
  vi.advanceTimersByTime(24);
  h.button('Choose date').click();
  const inputFocus = vi.spyOn(h.surface.input, 'focus');
  const migrated = document.implementation.createHTMLDocument('Migrated capture');
  migrated.body.append(h.host);
  menu.choose('Ignore date suggestions');
  expect(document.activeElement).toBe(document.body);
  expect(inputFocus).not.toHaveBeenCalled();
  expect(h.execute).not.toHaveBeenCalled();
  h.surface.destroy();
});

it('does not return focus when capture destroys an owned choice menu', async () => {
  const h = harness();
  const menu = ownedChoiceMenu('after');
  h.type('Call tomorrow and послезавтра');
  vi.advanceTimersByTime(24);
  h.button('Choose date').click();
  const inputFocus = vi.spyOn(h.surface.input, 'focus');
  const openerFocus = vi.spyOn(h.button('Choose date'), 'focus');
  h.surface.destroy();
  menu.choose('Ignore date suggestions');
  expect(menu.portal().isConnected).toBe(false);
  expect(document.activeElement).toBe(document.body);
  expect(inputFocus).not.toHaveBeenCalled();
  expect(openerFocus).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  expect(h.execute).not.toHaveBeenCalled();
});

it('does not return menu choice focus after capture starts submitting', async () => {
  const h = harness();
  const menu = ownedChoiceMenu('after');
  const pending = deferred<Awaited<ReturnType<typeof h.execute>>>();
  h.execute.mockImplementationOnce(() => pending.promise);
  h.type('Call tomorrow and послезавтра');
  vi.advanceTimersByTime(24);
  h.button('Choose date').click();
  const submission = h.controller.submit('enter');
  const inputFocus = vi.spyOn(h.surface.input, 'focus');
  menu.choose('Ignore date suggestions');
  expect(h.controller.snapshot().readonly).toBe(true);
  expect(document.activeElement).toBe(document.body);
  expect(inputFocus).not.toHaveBeenCalled();
  expect(h.execute).toHaveBeenCalledOnce();
  pending.resolve({ type: 'io-error', cause: 'test', contentState: 'unchanged' });
  await submission;
  h.surface.destroy();
});

it.each(['2026-10-14', 'Choose date…', 'Ignore date suggestions'])(
  'keeps ambiguity actionable and handles menu choice %s',
  (choice) => {
    const h = harness();
    const menus: Menu[] = [];
    vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
      menus.push(this);
      return this;
    });
    const raw = 'Call tomorrow and послезавтра';
    h.type(raw);
    vi.advanceTimersByTime(24);
    const opener = expectDefined(
      [...h.host.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent === 'Choose date',
      ),
    );
    opener.click();
    const shown = expectDefined(menus[0]);
    const items = (
      shown as unknown as {
        menuItems__: Array<{ title__: string; onClick__: (() => void) | null }>;
      }
    ).menuItems__;
    expect(items.map((item) => item.title__)).toEqual([
      '2026-10-14',
      '2026-10-15',
      'Choose date…',
      'Ignore date suggestions',
    ]);
    expect(h.host.querySelector('button[aria-label="Remove date suggestions"]')).toBeNull();
    expectDefined(expectDefined(items.find((item) => item.title__ === choice)).onClick__)();
    shown.hide();
    vi.runAllTimers();
    if (choice === 'Choose date…') {
      expect(h.host.querySelector('input[type="date"]')).not.toBeNull();
    } else if (choice === '2026-10-14') {
      expect(h.button('Remove due date').textContent).toBe('2026-10-14');
    } else {
      expect(opener.isConnected).toBe(false);
      expect(h.host.querySelector('.abyss-task-date')).toBeNull();
      expect(h.button('Restore').isConnected).toBe(true);
      h.button('Restore').click();
      expect(
        [...h.host.querySelectorAll('.abyss-capture-chip-body')].some(
          (el) => el.textContent === 'Choose date',
        ),
      ).toBe(true);
    }
    expect(h.surface.input.value).toBe(raw);
    expect(h.execute).not.toHaveBeenCalled();
    h.surface.destroy();
  },
);

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
  h.type('Call tomorrow 📅 2026-10-20');
  vi.advanceTimersByTime(24);
  expect(h.host.textContent).toContain('Could not recognize dates and times');
  expect(h.host.textContent).not.toContain('private input details');
  expect(h.button('Remove due date').isConnected).toBe(true);
  h.surface.destroy();
});

it.each([false, true])(
  'settles a retained picker before raw Enter, valid replacement %s',
  async (valid) => {
    const h = harness();
    h.type('Call tomorrow');
    vi.advanceTimersByTime(24);
    h.button('Remove due date').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
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
  const date = h.button('Remove due date');
  date.focus();
  date.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  date.click();
  await vi.runAllTimersAsync();
  expect(h.host.querySelector('input[type="date"]')).toBeNull();
  expect(h.host.querySelector('button[aria-label^="Remove due date"]')).toBeNull();
  expect(document.activeElement).toBe(h.button('Restore'));
  expect(h.execute).not.toHaveBeenCalled();
  h.surface.destroy();
});

it('shows, reopens and clears a real initial day before a title without rewriting the input', () => {
  const h = harness({ due: { type: 'set', value: localDate('2026-10-19') } });
  expect(h.button('Remove due date').textContent).toBe('2026-10-19');
  expect(h.controller.snapshot().metadata?.referenceDate).toBeUndefined();
  expect(h.controller.snapshot().metadata?.preview.type).toBe('invalid');
  expect(h.execute).not.toHaveBeenCalled();
  const input = h.surface.input;
  input.setSelectionRange(0, 0);
  const write = vi.spyOn(input, 'value', 'set');
  h.button('Remove due date').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
  );
  vi.runAllTimers();
  const picker = expectDefined(h.host.querySelector<HTMLInputElement>('input[type="date"]'));
  picker.value = '2026-10-20';
  picker.dispatchEvent(new Event('change', { bubbles: true }));
  expect(h.controller.snapshot().metadata?.preview.type).toBe('invalid');
  expect(h.host.querySelector('.abyss-task-date')?.textContent).toContain('2026-10-20');
  expect(h.button('Remove due date').hidden).toBe(false);
  h.button('Remove due date').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
  );
  vi.runAllTimers();
  expect(h.host.querySelector<HTMLInputElement>('input[type="date"]')?.value).toBe('2026-10-20');
  h.host
    .querySelector<HTMLInputElement>('input[type="date"]')
    ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  h.button('Remove due date').click();
  expect(h.host.querySelector('button[aria-label^="Remove due date"]')).toBeNull();
  expect(h.host.querySelector('.abyss-task-date')).toBeNull();
  expect(h.surface.input).toBe(input);
  expect(input.value).toBe('');
  expect(input.selectionStart).toBe(0);
  expect(input.selectionEnd).toBe(0);
  expect(write).not.toHaveBeenCalled();
  h.surface.destroy();
});

it('confirms the effective full date and recognized phrase, then drops the phrase on manual replacement', () => {
  const h = harness();
  h.type('Call tomorrow');
  vi.advanceTimersByTime(24);
  const date = h.button('Remove due date');
  expect(date.getAttribute('aria-label')).toContain('2026-10-14');
  expect(date.getAttribute('aria-label')).toContain('tomorrow');
  expect(date.title).toContain('2026-10-14');
  expect(date.title).toContain('tomorrow');
  date.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  vi.runAllTimers();
  const picker = expectDefined(h.host.querySelector<HTMLInputElement>('input[type="date"]'));
  picker.value = '2027-01-01';
  picker.dispatchEvent(new Event('change', { bubbles: true }));
  expect(h.button('Remove due date')).toBe(date);
  expect(date.getAttribute('aria-label')).toContain('2027-01-01');
  expect(date.getAttribute('aria-label')).not.toContain('tomorrow');
  expect(date.title).toContain('2027-01-01');
  expect(date.title).not.toContain('tomorrow');
  expect(h.surface.input.value).toBe('Call tomorrow');
  h.surface.destroy();
});

it.each(['input', 'date', 'tag'] as const)(
  'keeps date and time before tags through edits and Restore with stable %s focus',
  async (focused) => {
    const h = harness();
    const escape = vi.spyOn(h.controller, 'escape');
    h.type('Call #work tomorrow');
    vi.advanceTimersByTime(24);
    const input = h.surface.input;
    input.setSelectionRange(1, 3);
    const date = h.button('Remove due date');
    const tag = h.button('Remove #work');
    const active = { input, date, tag }[focused];
    active.focus();
    const blur = vi.fn();
    active.addEventListener('blur', blur);
    const order = () =>
      [...h.host.querySelectorAll('.abyss-capture-chip-body')].map((el) => el.textContent);
    h.type('Call #work tomorrow at 14:00');
    await vi.runAllTimersAsync();
    expect(order()).toEqual(['Inbox', '2026-10-14', '14:00', '#work']);
    expect(document.activeElement).toBe(active);
    input.setSelectionRange(1, 3);
    h.button('Remove time').click();
    await vi.runAllTimersAsync();
    expect(order()).toEqual(['Inbox', '2026-10-14', '#work', 'Restore']);
    expect(input.selectionStart).toBe(1);
    expect(input.selectionEnd).toBe(3);
    h.button('Restore').click();
    await vi.runAllTimersAsync();
    expect(order()).toEqual(['Inbox', '2026-10-14', '14:00', '#work']);
    expect(input.selectionStart).toBe(1);
    expect(input.selectionEnd).toBe(3);
    expect(
      [...h.host.querySelectorAll('.abyss-capture-metadata button:not([hidden])')].map((button) =>
        button.getAttribute('aria-label'),
      ),
    ).toEqual([
      'Remove due date: 2026-10-14 (tomorrow at 14:00). Right-click or Shift+F10 to edit.',
      'Remove time: 14:00',
      'Remove #work',
    ]);
    h.type('Call #home #work tomorrow at 14:00');
    await vi.runAllTimersAsync();
    expect(order()).toEqual(['Inbox', '2026-10-14', '14:00', '#home', '#work']);
    h.type('Call #work #home tomorrow at 14:00');
    await vi.runAllTimersAsync();
    expect(order()).toEqual(['Inbox', '2026-10-14', '14:00', '#work', '#home']);
    h.type('Call #work tomorrow');
    await vi.runAllTimersAsync();
    expect(order()).toEqual(['Inbox', '2026-10-14', '#work']);
    h.type('Call #work tomorrow at 14:00 #home');
    await vi.runAllTimersAsync();
    expect(order()).toEqual(['Inbox', '2026-10-14', '14:00', '#work', '#home']);
    expect(h.surface.input).toBe(input);
    expect(h.button('Remove due date')).toBe(date);
    expect(h.button('Remove #work')).toBe(tag);
    expect(document.activeElement).toBe(active);
    expect(h.execute).not.toHaveBeenCalled();
    expect(escape).not.toHaveBeenCalled();
    expect(blur).not.toHaveBeenCalled();
    h.surface.destroy();
  },
);

it('shows held context planning without inventing a recognized phrase', () => {
  const h = harness({ scheduled: { type: 'set', value: localDate('2026-10-19') } });
  h.controller.applyMetadataAction({
    type: 'select-date',
    role: 'due',
    value: localDate('2026-10-20'),
  });
  const scheduled = h.button('Remove scheduled date');
  expect(scheduled.textContent).toBe('2026-10-19');
  expect(scheduled.title).toBe(
    'Remove scheduled date: 2026-10-19. Right-click or Shift+F10 to edit.',
  );
  expect(scheduled.getAttribute('aria-label')).toBe(scheduled.title);
  expect(h.controller.snapshot().metadata?.preview.type).toBe('invalid');
  h.surface.destroy();
});

it.each(['unavailable', 'throw', 'invalid-metadata'] as const)(
  'never exposes empty-title transient planning when canonical preview is %s',
  (failure) => {
    const log =
      failure === 'throw' ? vi.spyOn(console, 'error').mockImplementation(() => {}) : undefined;
    const h = harness();
    h.preview.mockImplementation(() => {
      if (failure === 'throw') throw new Error('preview test');
      if (failure === 'unavailable') return { type: 'unavailable', cause: 'preview-capability' };
      return {
        type: 'invalid',
        issues: [
          { code: 'invalid-title', field: 'title' },
          { code: 'invalid-date', field: 'due' },
        ],
      };
    });
    h.controller.applyMetadataAction({
      type: 'select-date',
      role: 'due',
      value: localDate('2026-10-20'),
    });
    expect(h.controller.snapshot().metadata?.projection).toBeUndefined();
    expect(h.host.querySelector('button[aria-label^="Remove due date"]')).toBeNull();
    expect(h.execute).not.toHaveBeenCalled();
    if (log !== undefined)
      expect(log.mock.calls).toEqual([['[abyss-tasks] Quick-capture draft preview failed']]);
    h.surface.destroy();
  },
);

it('does not display held manual planning through a malformed canonical carrier', () => {
  const h = harness();
  h.controller.applyMetadataAction({
    type: 'select-date',
    role: 'due',
    value: localDate('2026-10-20'),
  });
  h.type('Call 📅 nope');
  vi.advanceTimersByTime(24);
  expect(h.controller.snapshot().metadata?.preview.type).toBe('invalid');
  expect(h.host.querySelector('button[aria-label^="Remove due date"]')).toBeNull();
  expect(h.surface.input.value).toBe('Call 📅 nope');
  h.surface.destroy();
});

it('identifies the clock phrase that supplies an inferred date', () => {
  const h = harness();
  h.type('Call at 14:00');
  vi.advanceTimersByTime(24);
  const date = h.button('Remove due date');
  expect(date.title).toContain('2026-10-13');
  expect(date.title).toContain('at 14:00');
  expect(date.getAttribute('aria-label')).toBe(date.title);
  h.controller.applyMetadataAction({
    type: 'select-date',
    role: 'due',
    value: localDate('2026-10-20'),
  });
  expect(date.title).toContain('2026-10-20');
  expect(date.title).not.toContain('at 14:00');
  h.surface.destroy();
});

it('updates unchanged clock text with the edited date class and preserves the date button and focus', () => {
  const classes: Record<string, string> = {
    '2026-10-13': 'is-today',
    '2026-10-14': 'is-tomorrow',
  };
  const getDateClass = vi.fn((value: string, referenceDate?: string) =>
    referenceDate === '2026-10-13' ? (classes[value] ?? '') : '',
  );
  const h = harness(undefined, getDateClass);
  const raw = 'Call tomorrow ⏰ 14:00';
  h.type(raw);
  vi.advanceTimersByTime(24);
  const date = h.button('Remove due date');
  const clock = () => h.button('Remove time');
  const content = (body: Element) => expectDefined(body.querySelector('.abyss-task-date'));
  expect(content(date).classList.contains('is-tomorrow')).toBe(true);
  expect(content(clock()).classList.contains('is-tomorrow')).toBe(true);
  expect(getDateClass).toHaveBeenCalledWith('2026-10-14', '2026-10-13');
  date.focus();
  h.controller.applyMetadataAction({
    type: 'select-date',
    role: 'due',
    value: localDate('2026-10-13'),
  });
  expect(h.button('Remove due date')).toBe(date);
  expect(document.activeElement).toBe(date);
  expect(content(date).classList.contains('is-today')).toBe(true);
  expect(content(clock()).classList.contains('is-today')).toBe(true);
  expect(content(clock()).textContent).toBe('14:00');
  h.button('Remove due date').click();
  expect(content(clock()).className).toBe('abyss-task-date');
  h.button('Restore').click();
  expect(content(h.button('Remove due date')).classList.contains('is-today')).toBe(true);
  expect(content(clock()).classList.contains('is-today')).toBe(true);
  expect(h.surface.input.value).toBe(raw);
  expect(h.execute).not.toHaveBeenCalled();
  h.surface.destroy();
});

it.each(['2026-10-13', '2026-10-14'])(
  'keeps an interval starting %s neutral, then recolors the unchanged end and clock on removal and Restore',
  (start) => {
    const h = harness(
      {
        start: { type: 'set', value: localDate(start) },
        due: { type: 'set', value: localDate('2026-10-14') },
      },
      () => 'is-tomorrow',
    );
    h.type('Call ⏰ 14:00');
    vi.advanceTimersByTime(24);
    const date = h.button('Remove due date');
    const clock = h.button('Remove time');
    const classes = () =>
      [...h.host.querySelectorAll('.abyss-task-date')].map((el) => el.className);
    expect(classes()).toEqual(['abyss-task-date', 'abyss-task-date', 'abyss-task-date']);
    date.focus();
    h.button('Remove start date').click();
    expect(h.button('Remove due date')).toBe(date);
    expect(document.activeElement).toBe(date);
    expect(classes()).toEqual(['abyss-task-date is-tomorrow', 'abyss-task-date is-tomorrow']);
    expect(clock.textContent).toBe('14:00');
    h.button('Restore').click();
    expect(classes()).toEqual(['abyss-task-date', 'abyss-task-date', 'abyss-task-date']);
    expect(h.button('Remove due date')).toBe(date);
    expect(document.activeElement).toBe(date);
    expect(h.surface.input.value).toBe('Call ⏰ 14:00');
    h.surface.destroy();
  },
);

it('colors raw time by its inferred due date while actual time-only planning stays neutral', () => {
  const h = harness(undefined, (value, referenceDate) =>
    value === '2026-10-13' && referenceDate === '2026-10-13' ? 'is-today' : '',
  );
  h.type('Call ⏰ 14:00');
  vi.advanceTimersByTime(24);
  expect([...h.host.querySelectorAll('.abyss-task-date')].map((el) => el.className)).toEqual([
    'abyss-task-date',
  ]);
  h.type('Call at 14:00');
  vi.advanceTimersByTime(24);
  expect([...h.host.querySelectorAll('.abyss-task-date')].map((el) => el.className)).toEqual([
    'abyss-task-date is-today',
    'abyss-task-date is-today',
  ]);
  h.surface.destroy();
});

it('keeps dates and time neutral when their presentation classifier is absent', () => {
  const h = harness();
  h.type('Call tomorrow at 14:00');
  vi.advanceTimersByTime(24);
  expect([...h.host.querySelectorAll('.abyss-task-date')].map((el) => el.className)).toEqual([
    'abyss-task-date',
    'abyss-task-date',
  ]);
  h.surface.destroy();
});

it('classifies real context planning before editing without freezing the input reference', () => {
  const h = harness({ due: { type: 'set', value: localDate('2026-10-14') } }, () => 'is-tomorrow');
  expect(h.button('Remove due date').querySelector('.abyss-task-date')?.className).toBe(
    'abyss-task-date is-tomorrow',
  );
  expect(h.controller.snapshot().metadata?.referenceDate).toBeUndefined();
  expect(h.controller.snapshot().metadata?.preview.type).toBe('invalid');
  h.surface.destroy();
});

it.each([
  {
    role: 'due' as const,
    initial: {
      due: { type: 'set' as const, value: localDate('2026-10-13') },
      scheduled: { type: 'set' as const, value: localDate('2026-10-14') },
    },
    before: ['abyss-task-date is-today', 'abyss-task-date is-tomorrow', 'abyss-task-date is-today'],
    after: ['abyss-task-date is-tomorrow', 'abyss-task-date is-tomorrow'],
  },
  {
    role: 'scheduled' as const,
    initial: {
      scheduled: { type: 'set' as const, value: localDate('2026-10-14') },
      start: { type: 'set' as const, value: localDate('2026-10-15') },
    },
    before: [
      'abyss-task-date is-tomorrow',
      'abyss-task-date is-soon',
      'abyss-task-date is-tomorrow',
    ],
    after: ['abyss-task-date is-soon', 'abyss-task-date is-soon'],
  },
])(
  'colors point dates independently and moves the clock after removing $role',
  ({ role, initial, before, after }) => {
    const classes: Record<string, string> = {
      '2026-10-13': 'is-today',
      '2026-10-14': 'is-tomorrow',
      '2026-10-15': 'is-soon',
    };
    const h = harness(initial, (value) => classes[value] ?? '');
    h.type('Call ⏰ 14:00');
    vi.advanceTimersByTime(24);
    const colors = () => [...h.host.querySelectorAll('.abyss-task-date')].map((el) => el.className);
    expect(colors()).toEqual(before);
    h.button(`Remove ${role} date`).click();
    expect(colors()).toEqual(after);
    h.button('Restore').click();
    expect(colors()).toEqual(before);
    h.surface.destroy();
  },
);

describe('Q recurrence metadata', () => {
  it('orders repeat after time and before tags, dismisses the whole badge and restores without changing raw selection', async () => {
    const h = await canonicalSurface(
      { type: 'list', selection: 'inbox' },
      { sourceNoteDisplay: 'always' },
    );
    try {
      h.surface.input.value = 'Позвонить каждый день в 18:00 #work';
      h.surface.input.dispatchEvent(new Event('input', { bubbles: true }));
      h.controller.flushRecognition();
      expect(h.contents()).toEqual(['tasks', '2026-10-13', '18:00', 'every day', '#work']);
      const repeat = h.button('Remove repeat');
      expect(repeat.querySelector('[data-icon="repeat-2"]')).not.toBeNull();
      expect(repeat.classList.contains('is-removable')).toBe(true);
      const separator = expectDefined(
        repeat.parentElement?.querySelector('.abyss-capture-separator'),
      );
      expect(separator.textContent).toBe('·');
      expect(separator.getAttribute('aria-hidden')).toBe('true');
      h.surface.input.focus();
      h.surface.input.setSelectionRange(2, 7);
      repeat.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      repeat.click();
      expect(h.contents()).toEqual(['tasks', '2026-10-13', '18:00', '#work', 'Restore']);
      expect(h.surface.input.value).toBe('Позвонить каждый день в 18:00 #work');
      expect([h.surface.input.selectionStart, h.surface.input.selectionEnd]).toEqual([2, 7]);
      h.button('Restore').click();
      expect(h.contents()).toEqual(['tasks', '2026-10-13', '18:00', 'every day', '#work']);
      expect(h.controller.snapshot().draft).toBe('Позвонить каждый день в 18:00 #work');
    } finally {
      h.close();
    }
  });
});

it('submits the displayed canonical repeat through the real Q create session', async () => {
  const h = await canonicalSurface({ type: 'list', selection: 'inbox' });
  try {
    h.controller.setDraft('Позвонить каждые 3 дня после выполнения #work');
    expect(h.button('Remove repeat').textContent).toBe('every 3 days when done');
    await h.controller.submit('enter');
    expect(await h.readCreated()).toBe(
      '- [ ] Позвонить #work 🔁 every 3 days when done ➕ 2026-10-13 📅 2026-10-13',
    );
    expect(h.controller.snapshot().draft).toBe('');
  } finally {
    h.close();
  }
});
