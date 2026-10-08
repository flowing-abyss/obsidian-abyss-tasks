import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CaptureSessions } from '../src/panels/center/CaptureSessions';
import { CenterPanel } from '../src/panels/CenterPanel';
import { mountGroupHeader } from '../src/panels/task-list/taskListRowView';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type {
  TaskApplicationApi,
  TaskCaptureApplicationApi,
  TaskCreateSession,
} from '../src/tasks';
import { localDate, type TaskCommandResult } from '../src/tasks';
import {
  CreationPresentationController,
  type CreationRevealRequest,
} from '../src/ui/creation/CreationPresentationController';
import {
  appWithFiles,
  configuredTaskApplication,
  createAppWithFiles,
  deferred,
  expectDefined,
  flushMicrotasks,
  task,
  taskQueryApi,
  useRealMoment,
} from './helpers';
import { taskListRect, useTaskPanelViewport } from './support/taskPanelViewport';

useRealMoment();
useTaskPanelViewport(true);
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return (
      taskListRect(this) ?? {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: this.clientWidth,
        bottom: this.clientHeight,
        width: this.clientWidth,
        height: this.clientHeight,
        toJSON: () => ({}),
      }
    );
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  activeDocument.body.empty();
});

describe('capture session cancellation', () => {
  it('keeps a cancelled late destination resolution inert without mounting, focusing or executing', async () => {
    const state = new AppState();
    const pending = deferred<TaskCreateSession>();
    const execute = vi.fn<TaskApplicationApi['execute']>();
    const sessionExecute = vi.fn<TaskCreateSession['execute']>();
    const application: TaskApplicationApi & TaskCaptureApplicationApi = {
      queries: taskQueryApi(),
      execute,
      planCreate: () => pending.promise,
    };
    const root = activeDocument.body.createDiv();
    const captures = new CaptureSessions({
      state,
      settings: DEFAULT_SETTINGS,
      application,
      listNodes: () => application.queries.listNodes(),
      onCreationResult: () => {},
      root: () => root,
    });
    const host = root.createDiv();
    captures.renderCaptureHost(host, { type: 'list', selectionKey: 'inbox' });
    const next = activeDocument.body.createEl('button', { text: 'Unrelated focus' });
    try {
      captures.openCapture(
        { type: 'list', selectionKey: 'inbox' },
        { type: 'default', source: 'search' },
      );
      captures.cancelActiveCapture();
      next.focus();
      pending.resolve({
        type: 'ready',
        destination: { filePath: 'Capture.md', insertion: { type: 'append' } },
        execute: sessionExecute,
      });
      await flushMicrotasks();
      expect(root.querySelector('.abyss-capture-surface')).toBeNull();
      expect(root.querySelector('.abyss-capture-input')).toBeNull();
      expect(activeDocument.activeElement).toBe(next);
      expect(execute).not.toHaveBeenCalled();
      expect(sessionExecute).not.toHaveBeenCalled();
      expect(host.querySelector<HTMLButtonElement>('.abyss-add-task-trigger')?.hidden).toBe(false);
    } finally {
      captures.cancelActiveCapture();
    }
  });
});

describe('retained capture hosts', () => {
  it('retains the input, selection and composition with one trigger across refresh', async () => {
    const state = new AppState();
    const execute = vi.fn<TaskCreateSession['execute']>();
    const application: TaskApplicationApi & TaskCaptureApplicationApi = {
      queries: taskQueryApi(),
      execute: vi.fn(),
      planCreate: async () => ({
        type: 'ready',
        destination: { filePath: 'Capture.md', insertion: { type: 'append' } },
        execute,
      }),
    };
    const root = activeDocument.body.createDiv();
    const captures = new CaptureSessions({
      state,
      settings: DEFAULT_SETTINGS,
      application,
      listNodes: () => [],
      onCreationResult: () => {},
      root: () => root,
    });
    const host = root.createDiv();
    const placement = { type: 'list', selectionKey: 'inbox' } as const;
    captures.renderCaptureHost(host, placement);
    captures.openCapture(placement, { type: 'default', source: 'search' });
    await flushMicrotasks();
    const input = expectDefined(host.querySelector<HTMLInputElement>('.abyss-capture-input'));
    input.value = 'Draft composing';
    input.setSelectionRange(3, 8);
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    captures.renderCaptureHost(host, placement);
    expect(host.querySelector('.abyss-capture-input')).toBe(input);
    expect(host.querySelectorAll('.abyss-add-task-trigger')).toHaveLength(1);
    expect(activeDocument.activeElement).toBe(input);
    expect(input.value).toBe('Draft composing');
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 8]);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
    );
    expect(execute).not.toHaveBeenCalled();
    captures.cancelActiveCapture();
  });
});

describe('capture publication through a bounded task surface', () => {
  it.each([
    'before-result',
    'after-result',
    'outside-focus',
    'closed',
    'changed-query',
    'replaced-surface',
  ] as const)(
    'reveals the exact created row only with its original input and context (%s)',
    async (scenario) => {
      const tasks = Array.from({ length: 1200 }, (_, line) =>
        task({
          title: `Task ${line}`,
          tags: ['#task/inbox'],
          source: { filePath: 'large.md', line },
        }),
      );
      const created = task({
        title: 'New captured task',
        tags: ['#task/inbox'],
        source: { filePath: 'large.md', line: 1200 },
      });
      const state = new AppState();
      state.set('selectedList', 'inbox');
      const queries = taskQueryApi({
        list: () => tasks,
        resolve: (ref) => {
          const current = tasks.find((candidate) => candidate.ref.revision === ref.revision);
          return current === undefined
            ? { type: 'not-found', ref }
            : { type: 'exact', task: current, basis: { observed: current } };
        },
      });
      const result = {
        type: 'ok',
        changed: true,
        outcome: { type: 'task', task: created },
      } as const;
      const application: TaskApplicationApi & TaskCaptureApplicationApi = {
        queries,
        execute: vi.fn(),
        planCreate: async () => ({
          type: 'ready',
          destination: { filePath: 'large.md', insertion: { type: 'append' } },
          execute: async () => result,
        }),
      };
      const root = activeDocument.body.createDiv();
      const feedback = activeDocument.body.createDiv();
      const presentation = new CreationPresentationController({
        host: feedback,
        queries,
        reducedMotion: () => true,
        now: () => Date.now(),
      });
      const panel = new CenterPanel({
        state,
        app: appWithFiles({}),
        settings: {
          ...DEFAULT_SETTINGS,
          inbox: { mode: 'tag', tag: '#task/inbox', removeTagOnAssign: true },
        },
        queries,
        statusRegistry: new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
        tasks: application,
        captureApplication: application,
        onCreationResult: (commandResult, description, authority) => {
          presentation.present(commandResult, description, authority);
        },
        onRenderComplete: (renderRoot) => {
          presentation.afterRender(renderRoot);
        },
      });
      panel.mount(root);
      expectDefined(root.querySelector<HTMLButtonElement>('.abyss-add-task-trigger')).click();
      await flushMicrotasks();
      const input = expectDefined(root.querySelector<HTMLInputElement>('.abyss-capture-input'));
      input.value = 'New captured task';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      if (scenario === 'before-result') {
        tasks.push(created);
        panel.refresh();
      }
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushMicrotasks();
      const outside = activeDocument.body.createEl('input');
      if (scenario === 'outside-focus') outside.focus();
      if (scenario === 'closed')
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      if (scenario === 'changed-query') {
        state.set('centerFilter', 'task');
        expect(state.get('centerFilter')).toBe('task');
        state.set('centerFilter', '');
      }
      if (scenario === 'replaced-surface') {
        state.set('mode', 'calendar');
        expect(state.get('mode')).toBe('calendar');
        state.set('mode', 'tasks');
      }
      if (scenario !== 'before-result') tasks.push(created);
      panel.refresh();
      const scroll = expectDefined(root.querySelector<HTMLElement>('.abyss-center-scroll'));
      if (scenario === 'before-result' || scenario === 'after-result') {
        await vi.waitFor(() => {
          expect(scroll.scrollTop).toBeGreaterThan(50000);
        });
        expect(root.querySelector('[data-line="1200"]')).not.toBeNull();
        expect(activeDocument.activeElement).toBe(input);
        expect(root.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(100);
      } else {
        expect(scroll.scrollTop).toBe(0);
        if (scenario === 'outside-focus') expect(activeDocument.activeElement).toBe(outside);
      }
      panel.destroy();
      presentation.destroy();
      root.remove();
      feedback.remove();
      outside.remove();
    },
  );
});

it('keeps Mod+A and IME keys inside the actual centre capture input without blur or submit', async () => {
  const state = new AppState();
  state.set('selectedList', 'inbox');
  const execute = vi.fn<TaskCreateSession['execute']>();
  const queries = taskQueryApi({ list: () => [task({ tags: ['#task/inbox'] })] });
  const application: TaskApplicationApi & TaskCaptureApplicationApi = {
    queries,
    execute: vi.fn(),
    planCreate: async () => ({
      type: 'ready',
      destination: { filePath: 'tasks.md', insertion: { type: 'append' } },
      execute,
    }),
  };
  const root = activeDocument.body.createDiv();
  const panel = new CenterPanel({
    state,
    app: appWithFiles({}),
    settings: DEFAULT_SETTINGS,
    queries,
    statusRegistry: new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
    tasks: application,
    captureApplication: application,
  });
  panel.mount(root);
  expectDefined(root.querySelector<HTMLButtonElement>('.abyss-add-task-trigger')).click();
  await flushMicrotasks();
  const input = expectDefined(root.querySelector<HTMLInputElement>('.abyss-capture-input'));
  input.value = 'Capture draft';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.setSelectionRange(2, 7);
  const blur = vi.fn();
  input.addEventListener('blur', blur);
  for (const init of [
    { ctrlKey: true },
    { metaKey: true },
    { ctrlKey: true, isComposing: true },
    { ctrlKey: true, keyCode: 229 },
  ]) {
    const event = new KeyboardEvent('keydown', {
      key: 'a',
      bubbles: true,
      cancelable: true,
      ...init,
    });
    input.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  expect(root.querySelector('.abyss-capture-input')).toBe(input);
  expect(activeDocument.activeElement).toBe(input);
  expect(input.value).toBe('Capture draft');
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 7]);
  expect(blur).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(panel['rowSelection_abyssPrivate'].size).toBe(0);
  panel.destroy();
});

it.each(['blur', 'input', 'unmount', 'parent'] as const)(
  'forwards the result request and cancels on %s',
  async (cause) => {
    const snapshot = task();
    const held = deferred<HTMLElement | undefined>();
    let forwarded: CreationRevealRequest | undefined;
    let revealing: HTMLElement | undefined | Promise<HTMLElement | undefined>;
    const parent = new AbortController();
    let current = true;
    const application: TaskApplicationApi & TaskCaptureApplicationApi = {
      queries: taskQueryApi(),
      execute: vi.fn(),
      planCreate: async () => ({
        type: 'ready',
        destination: { filePath: 'tasks.md', insertion: { type: 'append' } },
        execute: async () => ({
          type: 'ok',
          changed: true,
          outcome: { type: 'task', task: snapshot },
        }),
      }),
    };
    const root = activeDocument.body.createDiv();
    const captures = new CaptureSessions({
      state: new AppState(),
      settings: DEFAULT_SETTINGS,
      application,
      listNodes: () => [],
      root: () => root,
      captureReveal: () => ({
        forSubmission: () => ({
          isCurrent: () => true,
          reveal: (_ref, request) => {
            forwarded = request;
            return held.promise;
          },
        }),
      }),
      onCreationResult: (_result, _description, authority) => {
        revealing = authority?.reveal(snapshot.ref, {
          signal: parent.signal,
          isCurrent: () => current,
        });
      },
    });
    const host = root.createDiv();
    const placement = { type: 'list', selectionKey: 'inbox' } as const;
    captures.renderCaptureHost(host, placement);
    captures.openCapture(placement, { type: 'default', source: 'search' });
    await flushMicrotasks();
    const input = expectDefined(host.querySelector<HTMLInputElement>('.abyss-capture-input'));
    input.value = 'Created';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushMicrotasks();
    expect(forwarded?.isCurrent()).toBe(true);
    current = false;
    expect(forwarded?.isCurrent()).toBe(false);
    current = true;
    if (cause === 'blur') input.blur();
    if (cause === 'input') {
      input.value = 'Next draft';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (cause === 'unmount') captures.unmountActiveCapture();
    if (cause === 'parent') parent.abort();
    expect(forwarded?.signal.aborted).toBe(true);
    if (cause === 'input') expect(input.value).toBe('Next draft');
    expect(await revealing).toBeUndefined();
    held.resolve(undefined);
    await flushMicrotasks();
    captures.cancelActiveCapture();
  },
);

async function dateCaptureHarness() {
  const app = await createAppWithFiles({ 'capture.md': '' });
  const settings = { ...DEFAULT_SETTINGS, taskFilePath: 'capture.md' };
  const parts = configuredTaskApplication(app, settings, { authority: true });
  await parts.index.initialize();
  const state = new AppState();
  state.set('selectedList', { type: 'tag', tag: '#focus' });
  const root = activeDocument.body.createDiv();
  const captures = new CaptureSessions({
    state,
    settings,
    application: parts.tasks,
    listNodes: () => parts.index.listNodes(),
    onCreationResult: () => {},
    root: () => root,
  });
  const placement = { type: 'list', selectionKey: 'tag:#focus' } as const;
  const host = root.createDiv();
  captures.renderCaptureHost(host, placement);
  return {
    ...parts,
    app,
    state,
    root,
    host,
    captures,
    placement,
    input: () => expectDefined(root.querySelector<HTMLInputElement>('.abyss-capture-input')),
    close: () => {
      captures.cancelActiveCapture();
      parts.index.destroy();
      root.remove();
    },
  };
}
function editDateCapture(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function enterDateCapture(input: HTMLInputElement): void {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
}

it('switches pristine seeds, preserves an edited draft and remounts its exact seed after success', async () => {
  const h = await dateCaptureHarness();
  try {
    h.captures.openDateCapture(localDate('2026-10-10'));
    await flushMicrotasks();
    h.captures.openDateCapture(localDate('2026-10-11'));
    await flushMicrotasks();
    const input = h.input();
    expect(input.value).toBe(' 📅 2026-10-11');
    editDateCapture(input, 'Keep 📅 2026-10-12');
    h.captures.openDateCapture(localDate('2026-10-13'));
    await flushMicrotasks();
    expect(h.input()).toBe(input);
    expect(input.value).toBe('Keep 📅 2026-10-12');
    expect(activeDocument.activeElement).toBe(input);
    h.captures.unmountActiveCapture();
    h.captures.remountActiveCapture();
    expect(h.input()).not.toBe(input);
    expect(h.input().value).toBe('Keep 📅 2026-10-12');
    enterDateCapture(h.input());
    await flushMicrotasks();
    expect(h.input().value).toBe(' 📅 2026-10-11');
    const file = expectDefined(h.app.vault.getFileByPath('capture.md'));
    expect(await h.app.vault.read(file)).toContain('Keep #focus');
    expect(await h.app.vault.read(file)).toContain('📅 2026-10-12');
    h.input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.root.querySelector('.abyss-capture-input')).toBeNull();
    expect(activeDocument.activeElement).toBe(h.host.querySelector('.abyss-add-task-trigger'));
  } finally {
    h.close();
  }
});

it('retains a blur-started pending write and its retry draft when another date is requested', async () => {
  const h = await dateCaptureHarness();
  const pending = deferred<TaskCommandResult>();
  const originalPlan = h.tasks.planCreate.bind(h.tasks);
  vi.spyOn(h.tasks, 'planCreate').mockImplementation(async (...args) => {
    const session = await originalPlan(...args);
    let first = true;
    return {
      ...session,
      execute: async (command) => {
        if (first) {
          first = false;
          return await pending.promise;
        }
        return await session.execute(command);
      },
    };
  });
  const header = mountGroupHeader(
    h.root,
    {
      kind: 'group',
      key: 'later',
      label: 'Later',
      count: 1,
      first: true,
      dateGroup: { date: localDate('2026-10-14') },
    },
    (date) => {
      h.captures.openDateCapture(date);
    },
  );
  const plus = expectDefined(header.element.querySelector('button'));
  try {
    h.captures.openDateCapture(localDate('2026-10-10'));
    await flushMicrotasks();
    const input = h.input();
    editDateCapture(input, 'Retry 📅 2026-10-12');
    input.dispatchEvent(new Event('blur'));
    expect(input.readOnly).toBe(true);
    plus.focus();
    await flushMicrotasks();
    plus.click();
    expect(h.input()).toBe(input);
    expect(input.value).toBe('Retry 📅 2026-10-12');
    pending.resolve({ type: 'io-error', cause: 'repository-error', contentState: 'unchanged' });
    await flushMicrotasks();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    plus.focus();
    await flushMicrotasks();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    plus.click();
    expect(h.input()).toBe(input);
    enterDateCapture(input);
    await flushMicrotasks();
    const file = expectDefined(h.app.vault.getFileByPath('capture.md'));
    const written = await h.app.vault.read(file);
    expect(written).toContain('Retry #focus');
    expect(written).toContain('📅 2026-10-12');
    expect(written.split('- [ ]')).toHaveLength(2);
    expect(input.value).toBe(' 📅 2026-10-10');
  } finally {
    header.destroy();
    h.close();
  }
});

it('ignores late date planning after a newer date and after list navigation', async () => {
  const h = await dateCaptureHarness();
  const originalPlan = h.tasks.planCreate.bind(h.tasks);
  const pending = deferred<TaskCreateSession>();
  vi.spyOn(h.tasks, 'planCreate').mockImplementationOnce(() => pending.promise);
  try {
    h.captures.openDateCapture(localDate('2026-10-10'));
    h.captures.openDateCapture(localDate('2026-10-11'));
    await flushMicrotasks();
    const input = h.input();
    pending.resolve(await originalPlan({ type: 'configured-default' }));
    await flushMicrotasks();
    expect(h.input()).toBe(input);
    expect(input.value).toBe(' 📅 2026-10-11');
    const next = deferred<TaskCreateSession>();
    vi.spyOn(h.tasks, 'planCreate').mockImplementationOnce(() => next.promise);
    h.captures.openDateCapture(localDate('2026-10-12'));
    h.state.set('selectedList', 'today');
    h.captures.cancelStaleListCapture();
    next.resolve(await originalPlan({ type: 'configured-default' }));
    await flushMicrotasks();
    expect(h.root.querySelector('.abyss-capture-input')).toBeNull();
    const file = expectDefined(h.app.vault.getFileByPath('capture.md'));
    expect(await h.app.vault.read(file)).toBe('');
  } finally {
    h.close();
  }
});

it.each(['other-panel', 'retired'] as const)(
  'does not suppress ordinary capture blur for a %s date button',
  async (kind) => {
    const h = await dateCaptureHarness();
    const otherRoot = activeDocument.body.createDiv();
    const header = mountGroupHeader(
      kind === 'other-panel' ? otherRoot : h.root,
      {
        kind: 'group',
        key: 'test-date',
        label: 'Date',
        count: 1,
        first: true,
        dateGroup: { date: localDate('2026-10-11') },
      },
      (date) => {
        h.captures.openDateCapture(date);
      },
    );
    const button = expectDefined(header.element.querySelector('button'));
    try {
      if (kind === 'retired') {
        header.destroy();
        // Reattached stale DOM must not regain capture-preservation authority.
        h.root.append(button);
      }
      h.captures.openDateCapture(localDate('2026-10-10'));
      await flushMicrotasks();
      editDateCapture(h.input(), 'Outside 📅 2026-10-12');
      button.focus();
      await flushMicrotasks();
      const file = expectDefined(h.app.vault.getFileByPath('capture.md'));
      const written = await h.app.vault.read(file);
      expect(written).toContain('Outside #focus');
      expect(written).toContain('📅 2026-10-12');
      expect(written.split('- [ ]')).toHaveLength(2);
      expect(h.root.querySelector('.abyss-capture-input')).toBeNull();
    } finally {
      header.destroy();
      otherRoot.remove();
      h.close();
    }
  },
);
