import { MockLanguageModelV4 } from 'ai/test';
import { MarkdownRenderer, Menu } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import type { ContentPlanV1, ProjectDtoV1, TaskContentOperationV1, TasksApiV1 } from '../api';
import { CommandAgent } from '../src/ai/CommandAgent';
import { configureCommandLocale } from '../src/ai/commandMessages';
import { canonicalCommandPlan } from '../src/ai/commandReads';
import { commandReferences } from '../src/ai/commandReferences';
import { record } from '../src/ai/commandReferenceShapes';
import { prepareSchema } from '../src/ai/commandSchemas';
import { CommandSession } from '../src/ai/CommandSession';
import { CommandSessionOwner } from '../src/ai/CommandSessionOwner';
import { CommandSessionStore } from '../src/ai/CommandSessionStore';
import type { CommandAgentPort, CommandSessionSnapshot } from '../src/ai/commandTypes';
import { NativeProviderTransport } from '../src/ai/providers/NativeProviderTransport';
import { ProviderConnections } from '../src/ai/providers/ProviderConnections';
import { ProviderSecrets } from '../src/ai/providers/ProviderSecrets';
import type { CommandTranscriptionPort } from '../src/ai/voice/ProviderTranscription';
import TaskCalendarPlugin from '../src/main';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type { TaskCreateSession } from '../src/tasks';
import {
  CommandModeSurface,
  type CommandSurfaceMemory,
} from '../src/ui/commandMode/CommandModeSurface';
import { InteractionRegistry } from '../src/ui/interactionOwnership';
import { CaptureSurface } from '../src/ui/taskCapture/CaptureSurface';
import { QuickCaptureCoordinator } from '../src/ui/taskCapture/QuickCaptureCoordinator';
import { TaskCaptureController } from '../src/ui/taskCapture/TaskCaptureController';
import { describeTaskCreationResult } from '../src/ui/taskCommandResult';
import * as textFieldPosition from '../src/ui/textFieldAnchor';
import { createAppWithFiles, deferred, expectDefined, flushMicrotasks, methodOf } from './helpers';
import { commandSessionStorage } from './support/commandSessionStorage';
import { captureMenus, mockReadingView } from './support/linkEditHarness';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';
import { scriptedWriteReview } from './support/scriptedWriteReview';
import { voiceMediaHarness } from './support/voiceMediaHarness';
const cleanups: Array<() => void> = [];
it('keeps the running timer across phases and remount, then retires it on completion', async () => {
  const h = await setup();
  const surface = h.mount();
  await flushMicrotasks(0);
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  h.session.status('thinking', 'Thinking…');
  const timer = (target = surface) =>
    expectDefined(target.element.querySelector('.abyss-command-elapsed'));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(timer().textContent).toBe('5s');
  h.session.status('searching', 'Searching notes…');
  await vi.advanceTimersByTimeAsync(56_000);
  expect(timer().textContent).toBe('1:01');
  surface.destroy();
  await vi.advanceTimersByTimeAsync(4_000);
  const reopened = h.mount();
  expect(timer(reopened).textContent).toBe('1:05');
  h.session.status('ready', 'Ready.');
  expect(timer(reopened).hasAttribute('hidden')).toBe(true);
  expect(reopened.element.querySelector('.abyss-command-phase')?.textContent).toBe('Ready.');
  h.session.status('thinking', 'Thinking…');
  await vi.advanceTimersByTimeAsync(1_000);
  expect(timer(reopened).textContent).toBe('1s');
  reopened.destroy();
  expect(vi.getTimerCount()).toBe(0);
});
it('grows the shared composer for retained multiline text and width changes without moving selection', async () => {
  let resized: ResizeObserverCallback | undefined;
  const disconnect = vi.fn();
  let frame: FrameRequestCallback | undefined;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frame = callback;
    return 7;
  });
  const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame');
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resized = callback;
      }
      observe() {}
      unobserve() {}
      disconnect = disconnect;
    },
  );
  const h = await setup();
  const surface = h.mount();
  await flushMicrotasks();
  const input = surface.input as HTMLTextAreaElement;
  let height = 72;
  Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => height });
  vi.spyOn(input.win, 'getComputedStyle').mockReturnValue({
    lineHeight: '24px',
    fontSize: '16px',
    paddingTop: '0px',
    paddingBottom: '0px',
  } as CSSStyleDeclaration);
  h.owner.setInput('Retained draft');
  input.setSelectionRange(2, 6);
  h.owner.setInput('Retained draft\nRecognized first line\nRecognized second line');
  expect(input.rows).toBe(3);
  expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6]);
  height = 240;
  resized?.([], {} as ResizeObserver);
  expect(input.rows).toBe(3);
  frame?.(0);
  expect(input.rows).toBe(6);
  expect(input.value).toBe('Retained draft\nRecognized first line\nRecognized second line');
  Object.defineProperty(input, 'clientWidth', { configurable: true, value: 390 });
  resized?.([], {} as ResizeObserver);
  surface.destroy();
  expect(disconnect).toHaveBeenCalled();
  expect(cancelFrame).toHaveBeenCalledWith(7);
});

it('keeps duplicate note basenames compact and visibly attributes each exact nested path', async () => {
  const paths = ['Long/Nested/First/Research.md', 'Other/Deeper/Research.md'];
  const h = await setup(Object.fromEntries(paths.map((path) => [path, 'Body'])));
  const surface = h.mount();
  await flushMicrotasks();
  for (const path of paths) {
    const page = await expectDefined(h.api.notes).read({ selector: { path } });
    if (!page.ok) throw new Error(page.error.code);
    h.session.observeNote(page.value);
  }
  await h.session.focus(
    h.session.snapshot().entities.notes.map((page) => ({
      kind: 'note',
      target: page.note.target,
      revision: page.note.revision,
    })),
  );
  expect(
    [...surface.element.querySelectorAll('.abyss-command-note-title')].map((el) => el.textContent),
  ).toEqual(['Research', 'Research']);
  expect(
    [...surface.element.querySelectorAll('.abyss-command-note-path')].map((el) => el.textContent),
  ).toEqual(paths);
});
afterEach(() => {
  configureCommandLocale('en');
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => {
      cleanup();
    });
  document.body.empty();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('localizes fixed Russian chrome while preserving the exact agent and user text', async () => {
  configureCommandLocale('ru');
  const h = await setup();
  const surface = h.mount();
  await flushMicrotasks();
  expect(surface.element.querySelector('[aria-label="История"]')).not.toBeNull();
  expect(surface.input.getAttribute('aria-label')).toBe('Команда');
  h.owner.setInput('Ready for review.');
  h.session.status('ready', 'Model supplied English phrase.');
  expect(surface.input.value).toBe('Ready for review.');
  expect(surface.element.querySelector('.abyss-command-phase')?.textContent).toBe(
    'Model supplied English phrase.',
  );
});
async function setup(
  files: Record<string, string> = {},
  configureApi: (api: TasksApiV1) => TasksApiV1 = (api) => api,
  now: () => number = () => Date.UTC(2026, 7, 1, 12),
) {
  const h: PublicApiHarness = await publicApiHarness({
    'a.md': '- [ ] Existing\n',
    'Folder/Tasks.md': '',
    'Other/Details.md': 'Existing detail',
    ...files,
  });
  cleanups.push(() => {
    h.dispose();
  });
  const api = configureApi(h.client());
  const projectSettings = structuredClone(DEFAULT_SETTINGS.projects);
  let session!: CommandSession;
  let sequence = 0;
  const persisted = commandSessionStorage();
  let override: CommandAgentPort['run'] | undefined;
  const notify = vi.fn();
  const owner = new CommandSessionOwner({
    notify,
    store: await CommandSessionStore.open({ ...persisted, now }),
    schedule: () => () => {},
    createSession: (journal, transitions) =>
      (session = new CommandSession({
        api,
        journal,
        transitions,
        now,
        id: () => `ui-${++sequence}`,
        agent: {
          run: async (input) => {
            if (override !== undefined) return override(input);
            const result = await expectDefined(api.tasks.prepare)({
              kind: 'create',
              destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
              tree: {
                markdownTitle: 'Parent',
                children: [
                  { markdownTitle: 'Duplicate' },
                  { markdownTitle: 'Duplicate', comments: [{ text: 'Second child only' }] },
                ],
              },
            });
            if (!result.ok) throw new Error(result.error.message);
            session.stage({
              kind: 'task',
              plan: await canonicalCommandPlan(api, result.value, new AbortController().signal, {
                now: () => Date.UTC(2026, 7, 1, 12),
                deadline: Date.UTC(2026, 7, 1, 12) + 5000,
              }),
            });
          },
        },
      })),
  });
  cleanups.push(() => {
    owner.dispose();
  });
  const memory: CommandSurfaceMemory = {
    active: true,
    selectionStart: 0,
    selectionEnd: 0,
    scrollTop: 0,
  };
  const host = document.body.createDiv();
  let closeCount = 0;
  const navigate = vi.fn<
    (target: string, revision: string, intent: 'feedback' | 'reveal') => boolean
  >(() => true);
  const resolveOwner = vi.fn(() => owner);
  const ordinaryExecute = vi.fn<TaskCreateSession['execute']>(async () => {
    throw new Error('Ordinary capture leaked');
  });
  const mount = (
    transcription?: CommandTranscriptionPort,
    availability?: () => { agent: boolean; voice: boolean },
    interactionOwnership?: InteractionRegistry<string>,
    mountHost: HTMLElement = host,
  ) => {
    const controller = new TaskCaptureController({
      target: {
        label: 'Inbox',
        context: { type: 'list', selection: 'inbox' },
        markdownPrefix: '',
        markdownSuffixes: [],
        session: {
          type: 'ready',
          destination: { filePath: 'a.md', insertion: { type: 'append' } },
          preview: () => ({ type: 'unavailable', cause: 'preview-capability' }),
          execute: ordinaryExecute,
        },
      },
      describe: describeTaskCreationResult,
      onResult: () => {},
      onRequestClose: () => {},
    });
    const surface = new CaptureSurface(mountHost, controller, {
      ...(interactionOwnership === undefined ? {} : { interactionOwnership }),
      extend: (capture) =>
        new CommandModeSurface(capture, {
          app: h.app,
          ...(transcription === undefined ? {} : { transcription }),
          ...(availability === undefined ? {} : { availability }),
          owner: resolveOwner,
          memory,
          context: () => 'Tasks view',
          registry: new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
          projectSettings: () => projectSettings,
          close: () => {
            closeCount++;
            surface.destroy();
          },
          navigate,
        }),
    });
    cleanups.push(() => {
      surface.destroy();
      controller.destroy();
    });
    return surface;
  };
  const mountCoordinator = async (
    transcription?: CommandTranscriptionPort,
    availability?: () => { agent: boolean; voice: boolean },
  ) => {
    const coordinatedHost = document.body.createDiv();
    const coordinator = new QuickCaptureCoordinator({
      app: h.app,
      host: coordinatedHost,
      context: () => ({ type: 'list', selection: 'inbox' }),
      resolveTarget: async (context) => ({
        label: 'Inbox',
        context,
        markdownPrefix: '',
        markdownSuffixes: [],
        session: {
          type: 'ready',
          destination: { filePath: 'a.md', insertion: { type: 'append' } },
          preview: () => ({ type: 'unavailable', cause: 'preview-capability' }),
          execute: ordinaryExecute,
        },
      }),
      interactionOwnership: new InteractionRegistry(),
      command: {
        active: () => memory.active,
        hide: () => {
          owner.hide().catch(() => {});
        },
        mount: (capture, close) =>
          new CommandModeSurface(capture, {
            app: h.app,
            ...(transcription === undefined ? {} : { transcription }),
            ...(availability === undefined ? {} : { availability }),
            owner: resolveOwner,
            memory,
            context: () => 'Tasks view',
            registry: new StatusRegistry(DEFAULT_SETTINGS.taskStatuses),
            projectSettings: () => projectSettings,
            close,
            navigate,
          }),
      },
    });
    cleanups.push(() => {
      coordinator.destroy();
    });
    coordinator.openOrFocus();
    await flushMicrotasks(0);
    return {
      coordinator,
      host: coordinatedHost,
      element: expectDefined(coordinatedHost.querySelector<HTMLElement>('.abyss-capture-surface')),
      input: expectDefined(
        coordinatedHost.querySelector<HTMLTextAreaElement>('.abyss-capture-input'),
      ),
    };
  };
  return {
    ...h,
    api,
    owner,
    notify,
    mountCoordinator,
    get session() {
      return session;
    },
    memory,
    projectSettings,
    persisted,
    resolveOwner,
    ordinaryExecute,
    allowOrdinaryWrites: () =>
      ordinaryExecute.mockImplementation(async (request) => {
        const create = await h.service.planCreate({
          type: 'explicit',
          destination: { filePath: 'a.md', insertion: { type: 'append' } },
        });
        return create.execute(request);
      }),
    mount,
    navigate,
    confirmInSession: (surface: CaptureSurface) => {
      const previous = override;
      // Simulate a semantic confirmation while exercising the real surface review token and writer.
      override = async ({ session: basis, signal }) => {
        override = previous;
        await session.confirmFromTurn(basis.proposal.revision, signal);
      };
      enter(surface, 'Save the current proposal');
    },
    setRun: (run: CommandAgentPort['run']) => {
      override = run;
    },
    closeCount: () => closeCount,
  };
}
function enter(surface: Pick<CaptureSurface, 'input'>, text: string) {
  surface.input.value = text;
  surface.input.dispatchEvent(new Event('input', { bubbles: true }));
  surface.input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
}
it('orders the four native toolbar controls and renders one canonical owner tree without ordinary writes', async () => {
  const h = await setup();
  const surface = h.mount();
  expect(
    [...surface.element.querySelectorAll('.abyss-command-toolbar button')].map((button) =>
      button.getAttribute('aria-label'),
    ),
  ).toEqual(['History', 'CommandMode', 'Microphone', 'Send']);
  enter(surface, 'Create parent');
  await flushMicrotasks(0);
  await new Promise((resolve) => window.setTimeout(resolve, 20));
  expect(h.owner.snapshot().status).toEqual({ kind: 'ready', message: 'Ready for review.' });
  expect(surface.element.querySelectorAll('.abyss-subtask-row')).toHaveLength(2);
  const children = surface.element.querySelectorAll(
    '.abyss-command-tree .abyss-subtask-content[data-task-display-key]',
  );
  expect(children[0]?.textContent).not.toContain('Second child only');
  expect(children[1]?.textContent).toContain('Second child only');
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  expect(surface.input.value).toBe('');
  const completedSession = h.owner.snapshot().id;
  enter(surface, '');
  await new Promise((resolve) => window.setTimeout(resolve, 30));
  expect(await h.read('a.md')).toContain('Parent');
  expect(h.owner.snapshot().id).not.toBe(completedSession);
  expect(surface.element.querySelector('.abyss-command-tree')?.textContent).toBe('');
  expect(
    h.owner.recent().find((record) => record.snapshot.id === completedSession)?.snapshot.status
      .kind,
  ).toBe('saved');
});
it('hides unavailable agent and voice controls without opening the command owner in ordinary capture', async () => {
  const h = await setup();
  h.memory.active = false;
  const surface = h.mount(undefined, () => ({ agent: false, voice: false }));
  expect(
    surface.element.querySelector<HTMLButtonElement>('[aria-label="CommandMode"]')?.hidden,
  ).toBe(true);
  expect(
    surface.element.querySelector<HTMLButtonElement>('[aria-label="Microphone"]')?.hidden,
  ).toBe(true);
  expect(h.resolveOwner).not.toHaveBeenCalled();
  expect(surface.input.getAttribute('aria-label')).toBe('Add task');
  expect(surface.element.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.hidden).toBe(
    false,
  );
});
it('opens New session from the send context menu and keeps the command toggle a plain toggle', async () => {
  const h = await setup();
  const shown = captureMenus();
  const surface = h.mount();
  const previous = h.owner.snapshot().id;
  expectDefined(surface.element.querySelector('[aria-label="CommandMode"]')).dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
  );
  expect(shown).toHaveLength(0);
  expectDefined(surface.element.querySelector('[aria-label="Send"]')).dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
  );
  expectDefined(shown[0]).pick('New session');
  await flushMicrotasks(0);
  expect(h.owner.snapshot().id).not.toBe(previous);
});
it('restores unsent input and selection after Escape/Q while unresolved questions block empty confirmation', async () => {
  const h = await setup();
  const surface = h.mount();
  h.session.question('Which date?');
  h.session.status('ready', 'Ready.');
  expect(surface.element.querySelector('.abyss-command-phase')?.textContent).not.toContain('Ready');
  expect(surface.element.querySelector('.abyss-command-question')?.textContent).toBe('Which date?');
  enter(surface, '');
  await flushMicrotasks(0);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  surface.input.value = 'Unsent text';
  surface.input.dispatchEvent(new Event('input', { bubbles: true }));
  surface.input.setSelectionRange(2, 6);
  surface.input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  expect(h.closeCount()).toBe(1);
  const reopened = h.mount();
  reopened.focus();
  expect(reopened.input.value).toBe('Unsent text');
  expect(reopened.input.selectionStart).toBe(2);
  expect(reopened.input.selectionEnd).toBe(6);
});

it.each(['hide', 'retype'])(
  'clears accepted input after hidden work and preserves an explicit retype following %s',
  async (action) => {
    const h = await setup();
    const hold = deferred<void>();
    h.setRun(async () => {
      await hold.promise;
    });
    const surface = h.mount();
    enter(surface, 'Same command');
    await flushMicrotasks(0);
    if (action === 'hide')
      surface.input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    else {
      surface.input.value = 'Same command';
      surface.input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    hold.resolve();
    await flushMicrotasks(0);
    expect(h.owner.snapshot().input).toBe(action === 'hide' ? '' : 'Same command');
  },
);

it('retains duplicate-child ownership, comment DOM and focus through a date-only canonical append', async () => {
  const h = await setup();
  const surface = h.mount();
  enter(surface, 'Create');
  await flushMicrotasks(0);
  const change = h.owner.snapshot().proposal.changes[0];
  if (change?.kind !== 'task') throw new Error('Missing draft');
  const child = expectDefined(change.plan.after?.children[1]);
  const title = expectDefined(
    surface.element.querySelectorAll<HTMLElement>('.abyss-subtask-label')[1],
  );
  const comment = expectDefined(surface.element.querySelector<HTMLElement>('.abyss-comment-text'));
  expect(expectDefined(title.querySelector('ins.abyss-text-difference')).textContent).toBe(
    'Duplicate',
  );
  expect(expectDefined(comment.querySelector('ins.abyss-text-difference')).textContent).toBe(
    'Second child only',
  );
  expect(
    expectDefined(title.closest<HTMLElement>('.abyss-task-card-main-row')).style.getPropertyValue(
      '--abyss-command-task-depth',
    ),
  ).toBe('1');
  title.tabIndex = 0;
  title.focus();
  h.session.exchange('user', 'Change only the second child date');
  const request = {
    kind: 'append' as const,
    plan: change.plan.target,
    expectedPlanRevision: change.plan.revision,
    operation: {
      type: 'patch' as const,
      target: child.target,
      patch: { scheduled: { type: 'set' as const, value: '2026-08-03' } },
    },
  };
  const result = await expectDefined(h.api.tasks.prepare)(request);
  if (!result.ok) throw new Error(result.error.message);
  h.session.prepared({ kind: 'task', input: prepareSchema.parse(request) });
  h.session.stage({
    kind: 'task',
    plan: await canonicalCommandPlan(h.api, result.value, new AbortController().signal, {
      now: () => Date.UTC(2026, 7, 1, 12),
      deadline: Date.UTC(2026, 7, 1, 12) + 5000,
    }),
  });
  await flushMicrotasks(0);
  expect(surface.element.querySelectorAll('.abyss-subtask-label')[1]).toBe(title);
  expect(surface.element.querySelector('.abyss-comment-text')).toBe(comment);
  expect(comment.closest('[data-change="added"]')).toBeNull();
  expect(document.activeElement).toBe(title);
  expect(title.closest('.abyss-subtask-row')?.textContent).toContain('2026-08-03');
  expect(
    title
      .closest('.abyss-subtask-row')
      ?.querySelector('.abyss-task-date-part')
      ?.getAttribute('data-change'),
  ).toBe('changed');
  const latest = currentTaskChange(h.owner.snapshot());
  await h.owner.focus({
    kind: 'task',
    target: child.target,
    plan: latest.plan.target,
    expectedPlanRevision: latest.plan.revision,
  });
  surface.input.focus();
  h.confirmInSession(surface);
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('saved');
  });
  expect(surface.element.querySelectorAll('.abyss-subtask-label')[1]).toBe(title);
  expect(surface.element.querySelector('.abyss-comment-text')?.textContent).toBe(
    'Second child only',
  );
  expect(
    surface.element.querySelector('.abyss-comment-text')?.closest('[data-change="added"]'),
  ).toBeNull();
  const savedFocus = expectDefined(h.owner.snapshot().focus[0]);
  expect(savedFocus.target).not.toBe(child.target);
  expect(
    h.provider.nativeTaskTarget(savedFocus.target, expectDefined(savedFocus.revision)),
  ).toBeDefined();
});
it('keeps a proposed accepted child deletion identifiable and inert through unrelated publications', async () => {
  const h = await setup();
  await h.external('a.md', '- [ ] Existing\n\t- [ ] Keep\n\t- [ ] Remove\n');
  const tasks = await h.api.tasks.list({});
  if (!tasks.ok) throw new Error(tasks.error.message);
  const root = expectDefined(tasks.value.items.find((task) => task.title === 'Existing'));
  const result = await expectDefined(h.api.tasks.prepare)({
    kind: 'edit',
    target: root.target,
    expectedRevision: root.revision,
  });
  if (!result.ok) throw new Error(result.error.message);
  const plan = await canonicalCommandPlan(h.api, result.value, new AbortController().signal, {
    now: () => Date.UTC(2026, 7, 1, 12),
    deadline: Date.UTC(2026, 7, 1, 12) + 5000,
  });
  h.session.stage({ kind: 'task', plan });
  const surface = h.mount();
  await flushMicrotasks(0);
  const child = expectDefined(plan.after?.children[1]);
  const removed = await expectDefined(h.api.tasks.prepare)({
    kind: 'append',
    plan: plan.target,
    expectedPlanRevision: plan.revision,
    operation: { type: 'remove', target: child.target },
  });
  if (!removed.ok) throw new Error(removed.error.message);
  h.session.stage({
    kind: 'task',
    plan: await canonicalCommandPlan(h.api, removed.value, new AbortController().signal, {
      now: () => Date.UTC(2026, 7, 1, 12),
      deadline: Date.UTC(2026, 7, 1, 12) + 5000,
    }),
  });
  await flushMicrotasks(0);
  h.owner.setInput('Later');
  await new Promise((resolve) => window.setTimeout(resolve, 470));
  const row = expectDefined(
    [...surface.element.querySelectorAll<HTMLElement>('[data-change="removed"]')].find((element) =>
      element.textContent.includes('Remove'),
    ),
  );
  expect(row.inert).toBe(true);
  expect(await h.read('a.md')).toContain('- [ ] Remove');
});

it('blocks owned missing basename links before native navigation and preserves existing same-name links', async () => {
  mockReadingView();
  const h = await setup();
  const note = await expectDefined(h.api.notes).prepare({
    kind: 'create',
    path: 'Folder/Details.md',
    title: 'Details',
    text: 'New detail',
  });
  if (!note.ok) throw new Error(note.error.message);
  h.session.stage({ kind: 'note', plan: note.value });
  const draft = await expectDefined(h.api.tasks.prepare)({
    kind: 'create',
    destination: { type: 'note', path: 'Folder/Tasks.md', insertion: { type: 'append' } },
    tree: { markdownTitle: 'Parent [[Details#Heading|Details]] [[Other/Details]]' },
  });
  if (!draft.ok) throw new Error(draft.error.message);
  h.session.stage({ kind: 'task', plan: draft.value });
  const existing = h.app.vault.getAbstractFileByPath('Other/Details.md');
  const resolve = vi
    .spyOn(h.app.metadataCache, 'getFirstLinkpathDest')
    .mockImplementation((path, source) => {
      if (path === 'Other/Details')
        return existing as ReturnType<typeof h.app.metadataCache.getFirstLinkpathDest>;
      expect(source).toBe('Folder/Tasks.md');
      return null;
    });
  const opened: string[] = [];
  vi.spyOn(h.app.workspace, 'openLinkText').mockImplementation(async (path) => {
    opened.push(path);
  });
  const surface = h.mount();
  await flushMicrotasks(0);
  const links = surface.element.querySelectorAll<HTMLAnchorElement>('.abyss-command-tree a');
  expect(links).toHaveLength(2);
  links[0]?.click();
  await flushMicrotasks(0);
  expect(opened).toEqual([]);
  expect(resolve).toHaveBeenCalledWith('Details', 'Folder/Tasks.md');
  links[1]?.click();
  await flushMicrotasks(0);
  expect(opened).toEqual(['Other/Details']);
  expect(h.app.vault.getAbstractFileByPath('Folder/Details.md')).toBeNull();
});
it('offers new session through the send context menu and retains a dirty tree until disposition', async () => {
  const h = await setup();
  const shown = captureMenus();
  const surface = h.mount();
  enter(surface, 'Create');
  await flushMicrotasks(0);
  openActions(surface);
  expectDefined(shown[0]).pick('New session');
  await flushMicrotasks(0);
  expect(h.owner.snapshot().pendingTransition?.kind).toBe('new-session');
  expect(surface.element.querySelector('.abyss-task-title')?.textContent).toBe('Parent');
  openActions(surface);
  expectDefined(shown[1]).pick('Keep for later');
  await flushMicrotasks(0);
  expect(h.owner.snapshot().proposal.changes).toHaveLength(0);
  expect(h.owner.recent().some((record) => record.snapshot.proposal.changes.length > 0)).toBe(true);
});

async function noteFocusTransition() {
  mockNativeBlocks();
  const h = await setup({ 'a.md': '- [ ] First focus\n- [ ] Other focus\n' });
  const notes = expectDefined(h.api.notes);
  const prepared = await notes.prepare({
    kind: 'create',
    path: 'Review.md',
    title: 'Review',
    text: '# Agreed note',
  });
  if (!prepared.ok) throw new Error(prepared.error.code);
  h.session.stage({ kind: 'note', plan: prepared.value });
  const listed = await h.api.tasks.list();
  if (!listed.ok) throw new Error(listed.error.code);
  const target = expectDefined(listed.value.items[0]);
  const other = expectDefined(listed.value.items[1]);
  await h.owner.focus({ kind: 'task', target: target.target, revision: target.revision });
  return { ...h, notes, plan: prepared.value, target, other };
}
function openActions(surface: CaptureSurface) {
  expectDefined(
    surface.element.querySelector<HTMLButtonElement>('.abyss-command-toolbar button:last-child'),
  ).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}
function actionsMenu(surface: CaptureSurface, shown: ReturnType<typeof captureMenus>) {
  openActions(surface);
  return expectDefined(shown[shown.length - 1]);
}
it('saves a rendered note and changes focus through the actual Save and continue menu once', async () => {
  const h = await noteFocusTransition();
  const shown = captureMenus();
  const surface = h.mount();
  await flushMicrotasks(0);
  expect(surface.element.querySelector('.abyss-command-note-body')?.textContent).toContain(
    'Agreed note',
  );
  const menu = actionsMenu(surface, shown);
  menu.pick('Save and continue');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().focus[0]?.target).toBe(h.target.target);
  });
  expect(await h.read('Review.md')).toContain('Agreed note');
  expect(h.owner.snapshot().pendingTransition).toBeNull();
  expect(h.owner.snapshot().proposal.changes).toHaveLength(0);
  expect(h.owner.snapshot().journal).toHaveLength(1);
  menu.pick('Save and continue');
  await flushMicrotasks(0);
  expect(h.owner.snapshot().journal).toHaveLength(1);
});
it.each(['pending', 'failed'] as const)(
  'rejects Save and continue from a %s note surface even if another surface is ready',
  async (fault) => {
    const h = await noteFocusTransition();
    const shown = captureMenus();
    h.mount();
    await flushMicrotasks(0);
    const waiting = deferred<void>();
    vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (...args) => {
      if (fault === 'failed') throw new Error('Native rendering failed');
      await waiting.promise;
      return renderNativeBlocks(...args);
    });
    let surface = h.mount();
    await flushMicrotasks(0);
    actionsMenu(surface, shown).pick('Save and continue');
    await flushMicrotasks(0);
    expect(h.app.vault.getFileByPath('Review.md')).toBeNull();
    expect(h.owner.snapshot().journal).toHaveLength(0);
    expect(h.owner.snapshot().pendingTransition?.kind).toBe('focus');
    mockNativeBlocks();
    waiting.resolve();
    if (fault === 'failed') {
      surface.destroy();
      surface = h.mount();
    }
    await flushMicrotasks(0);
    actionsMenu(surface, shown).pick('Save and continue');
    await vi.waitFor(() => {
      expect(h.owner.snapshot().focus[0]?.target).toBe(h.target.target);
    });
    expect(h.owner.snapshot().journal).toHaveLength(1);
  },
);
it('rejects a retired surface menu even when a new surface displays the same note proposal', async () => {
  const h = await noteFocusTransition();
  const shown = captureMenus();
  const original = h.mount();
  await flushMicrotasks(0);
  const retired = actionsMenu(original, shown);
  original.destroy();
  const current = h.mount();
  await flushMicrotasks(0);
  retired.pick('Save and continue');
  await flushMicrotasks(0);
  expect(h.app.vault.getFileByPath('Review.md')).toBeNull();
  expect(h.owner.snapshot().journal).toHaveLength(0);
  actionsMenu(current, shown).pick('Save and continue');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().focus[0]?.target).toBe(h.target.target);
  });
  expect(h.owner.snapshot().journal).toHaveLength(1);
});
it.each(['proposal', 'session', 'transition'] as const)(
  'rejects a menu captured before the %s changed and permits a new deliberate menu action',
  async (stale) => {
    const h = await noteFocusTransition();
    const shown = captureMenus();
    const surface = h.mount();
    await flushMicrotasks(0);
    const old = actionsMenu(surface, shown);
    if (stale === 'session') {
      await h.owner.newSession('keep');
      const created = await h.notes.prepare({
        kind: 'create',
        path: 'Review.md',
        title: 'Review',
        text: '# Current note',
      });
      if (!created.ok) throw new Error(created.error.code);
      h.session.stage({ kind: 'note', plan: created.value });
    } else if (stale === 'proposal') {
      await h.owner.resolveTransition('cancel');
      const refined = await h.notes.prepare({
        kind: 'refine',
        plan: h.plan.target,
        expectedPlanRevision: h.plan.revision,
        operation: { type: 'replace-body', text: '# Current note' },
      });
      if (!refined.ok) throw new Error(refined.error.code);
      h.session.stage({ kind: 'note', plan: refined.value });
    }
    await h.owner.focus({ kind: 'task', target: h.other.target, revision: h.other.revision });
    await flushMicrotasks(0);
    old.pick('Save and continue');
    await flushMicrotasks(0);
    expect(h.app.vault.getFileByPath('Review.md')).toBeNull();
    expect(h.owner.snapshot().journal).toHaveLength(0);
    expect(h.owner.snapshot().pendingTransition).toMatchObject({
      kind: 'focus',
      target: [{ target: h.other.target }],
    });
    actionsMenu(surface, shown).pick('Save and continue');
    await vi.waitFor(() => {
      expect(h.owner.snapshot().focus[0]?.target).toBe(h.other.target);
    });
    expect(h.owner.snapshot().journal).toHaveLength(1);
    expect(await h.read('Review.md')).toContain(
      stale === 'transition' ? 'Agreed note' : 'Current note',
    );
  },
);

it('marks exact saved-child comment edits and retains removed description/comment until save', async () => {
  const h = await setup();
  await h.external(
    'a.md',
    '- [ ] Existing\n\t- [ ] Child 📅 2026-08-03 #stable\n\t\t- > Keep description\n\t\t- 2026-08-01: First comment\n',
  );
  const listed = await h.api.tasks.list({});
  if (!listed.ok) throw new Error(listed.error.message);
  const root = expectDefined(listed.value.items.find((task) => task.title === 'Existing'));
  let result = await expectDefined(h.api.tasks.prepare)({
    kind: 'edit',
    target: root.target,
    expectedRevision: root.revision,
  });
  if (!result.ok) throw new Error(result.error.message);
  let plan = await canonicalCommandPlan(h.api, result.value, new AbortController().signal, {
    now: () => Date.UTC(2026, 7, 1, 12),
    deadline: Date.UTC(2026, 7, 1, 12) + 5000,
  });
  h.session.stage({ kind: 'task', plan });
  const surface = h.mount();
  await flushMicrotasks(0);
  const refine = async (basis: ContentPlanV1, operation: TaskContentOperationV1) => {
    const request = {
      kind: 'append' as const,
      plan: basis.target,
      expectedPlanRevision: basis.revision,
      operation,
    };
    result = await expectDefined(h.api.tasks.prepare)(request);
    if (!result.ok) throw new Error(result.error.message);
    h.session.prepared({ kind: 'task', input: prepareSchema.parse(request) });
    const next = await canonicalCommandPlan(h.api, result.value, new AbortController().signal, {
      now: () => Date.UTC(2026, 7, 1, 12),
      deadline: Date.UTC(2026, 7, 1, 12) + 5000,
    });
    h.session.stage({ kind: 'task', plan: next });
    await flushMicrotasks(0);
    return next;
  };
  const child = expectDefined(plan.after?.children[0]);
  plan = await refine(plan, { type: 'add-comment', target: child.target, text: 'Second comment' });
  let second = expectDefined(
    [...surface.element.querySelectorAll<HTMLElement>('.abyss-comment-row')].find(
      (row) => row.textContent === 'Second comment',
    ),
  );
  expect(second.dataset['change']).toBe('added');
  const target = expectDefined(plan.after?.children[0]?.comments[1]).target;
  plan = await refine(plan, { type: 'update-comment', target, text: 'Rewritten second' });
  second = expectDefined(
    [...surface.element.querySelectorAll<HTMLElement>('.abyss-comment-row')].find(
      (row) => row.querySelector('ins')?.textContent === 'Rewritten second',
    ),
  );
  expect(second.dataset['change']).toBe('changed');
  const original = expectDefined(plan.after?.children[0]?.comments[0]).target;
  plan = await refine(plan, { type: 'remove-comment', target: original });
  const removed = expectDefined(
    [...surface.element.querySelectorAll<HTMLElement>('.abyss-comment-row')].find(
      (row) => row.textContent === 'First comment',
    ),
  );
  expect(removed.dataset['change']).toBe('removed');
  expect(removed.inert).toBe(true);
  plan = await refine(plan, { type: 'description', target: child.target, text: null });
  const description = expectDefined(surface.element.querySelector<HTMLElement>('.abyss-task-desc'));
  expect(description.textContent).toBe('Keep description');
  expect(description.dataset['change']).toBe('removed');
  await refine(plan, {
    type: 'patch',
    target: child.target,
    patch: { due: { type: 'clear' } },
  });
  expect(surface.element.querySelector('.abyss-task-tag')?.getAttribute('data-change')).not.toBe(
    'changed',
  );
  expect(surface.element.textContent).toContain('2026-08-03');
  expect(await h.read('a.md')).toContain('First comment');
  surface.destroy();
  const reopened = h.mount();
  await flushMicrotasks(0);
  const retainedRemoval = [
    ...reopened.element.querySelectorAll<HTMLElement>('.abyss-comment-row'),
  ].find((row) => row.textContent === 'First comment');
  expect(expectDefined(retainedRemoval).dataset['change']).toBe('removed');
  expect(expectDefined(retainedRemoval).inert).toBe(true);
});

it('expands saved descendants beyond the first bounded page and focuses the exact duplicate child', async () => {
  const h = await setup();
  const comments = Array.from(
    { length: 65 },
    (_, index) => `\t\t- 2026-08-01: Comment ${index}\n`,
  ).join('');
  await h.external('a.md', `- [ ] Existing\n\t- [ ] Duplicate\n\t- [ ] Duplicate\n${comments}`);
  const listed = await h.api.tasks.list({});
  if (!listed.ok) throw new Error(listed.error.message);
  const root = expectDefined(listed.value.items.find((task) => task.title === 'Existing'));
  const surface = h.mount();
  await h.owner.focus({ kind: 'task', target: root.target, revision: root.revision });
  await vi.waitFor(() => {
    expect(surface.element.querySelectorAll('.abyss-comment-row')).toHaveLength(65);
  });
  const titles = surface.element.querySelectorAll<HTMLElement>('.abyss-subtask-label');
  const second = expectDefined(titles[1]);
  second.click();
  await flushMicrotasks(0);
  const focus = expectDefined(h.owner.snapshot().focus[0]);
  expect(focus.target).not.toBe(root.target);
  expect(surface.element.querySelector('.abyss-task-title')?.textContent).toBe('Existing');
  expect(surface.element.querySelectorAll('.abyss-subtask-label')).toHaveLength(2);
  expect(second.closest('.abyss-task-card-main-row')?.getAttribute('aria-current')).toBe('true');
  const page = [...h.owner.snapshot().entities.tasks]
    .reverse()
    .find((page) => page.tree.target === focus.target);
  expect(page?.tree.commentCount).toBe(65);
  expect(await h.read('a.md')).not.toContain('[x]');
});

it('stages draft checkbox status with retained comments and saves only after empty Enter', async () => {
  const h = await setup();
  const surface = h.mount();
  enter(surface, 'Create');
  await flushMicrotasks(0);
  const comment = expectDefined(surface.element.querySelector('.abyss-comment-text'));
  expectDefined(surface.element.querySelectorAll<HTMLElement>('[role="checkbox"]')[2]).click();
  await flushMicrotasks(0);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  expect(surface.element.querySelector('.abyss-comment-text')).toBe(comment);
  expect(
    surface.element.querySelectorAll('[role="checkbox"]')[2]?.getAttribute('aria-checked'),
  ).toBe('true');
  enter(surface, '');
  await vi.waitFor(async () => {
    expect(await h.read('a.md')).toContain('[x] Duplicate');
  });
});

it('applies a saved checkbox immediately while leaving an unrelated proposal staged', async () => {
  const h = await setup();
  const surface = h.mount();
  const listed = await h.api.tasks.list({});
  if (!listed.ok) throw new Error(listed.error.message);
  const root = expectDefined(listed.value.items[0]);
  await h.owner.focus({ kind: 'task', target: root.target, revision: root.revision });
  enter(surface, 'Create');
  await flushMicrotasks(0);
  const saved = expectDefined(
    [...surface.element.querySelectorAll<HTMLElement>('.abyss-task-card-main-row')].find(
      (row) => row.querySelector('.abyss-task-title')?.textContent === 'Existing',
    ),
  );
  expectDefined(saved.querySelector<HTMLElement>('[role="checkbox"]')).click();
  await vi.waitFor(async () => {
    expect(await h.read('a.md')).toContain('[x] Existing');
  });
  expect(h.owner.snapshot().proposal.changes.some((change) => change.kind === 'task')).toBe(true);
  expect(await h.read('a.md')).not.toContain('Parent');
});

it('renders configured project status, absent/unknown values and authored dates without moving related task content', async () => {
  const h = await setup();
  const surface = h.mount();
  h.projectSettings.propertyDefinitions['property:Effort'] = { type: 'number' };
  const configured = expectDefined(DEFAULT_SETTINGS.projects.statuses[0]);
  const project: ProjectDtoV1 = {
    target: 'project',
    revision: 'project-revision',
    path: 'Project.md',
    name: 'Project',
    status: { state: 'configured', id: configured.id },
    tags: [],
    stats: {
      total: 1,
      done: 0,
      cancelled: 0,
      inProgress: 0,
      tracked: { closedMs: 0, openStartsMs: [] },
    },
    fields: [
      { fieldId: 'start', state: 'value', value: '2026-08-03' },
      { fieldId: 'end', state: 'value', value: 'authored-invalid-date' },
      { fieldId: 'description', state: 'value', value: 'Keep the project context' },
      { fieldId: 'property:Effort', state: 'value', value: 2 },
      { fieldId: 'property:Unrequested', state: 'value', value: 'Hidden unrelated field' },
    ],
  };
  const listed = await h.api.tasks.list({});
  if (!listed.ok) throw new Error(listed.error.message);
  const task = expectDefined(listed.value.items[0]);
  await h.owner.focus({ kind: 'task', target: task.target, revision: task.revision });
  h.session.stage({
    kind: 'project',
    before: project,
    fields: [
      { fieldId: 'start', value: null },
      { fieldId: 'property:Effort', value: 5 },
    ],
  });
  await flushMicrotasks(0);
  expect(surface.element.querySelector('.abyss-project-dashboard-status')?.textContent).toBe(
    configured.name,
  );
  expect(surface.element.querySelector('[aria-label^="Start:"]')?.getAttribute('data-change')).toBe(
    'removed',
  );
  expect(surface.element.querySelector('[aria-label^="End:"]')?.textContent).toContain(
    'authored-invalid-date',
  );
  expect(surface.element.querySelector('.abyss-task-title')?.textContent).toBe('Existing');
  expect(surface.element.querySelector('.abyss-project-description')?.textContent).toBe(
    'Keep the project context',
  );
  const effort = expectDefined(
    surface.element.querySelector('[data-project-field="property:Effort"]'),
  );
  expect(effort.textContent).toContain('Effort');
  expect(effort.textContent).toContain('5');
  expect(effort.getAttribute('data-change')).toBe('changed');
  h.session.exchange('user', 'Keep the project context');
  await flushMicrotasks(0);
  expect(effort.getAttribute('data-change')).toBe('');
  expect(surface.element.textContent).not.toContain('Hidden unrelated field');
  h.session.stage({
    kind: 'project',
    before: { ...project, target: 'absent-project', status: { state: 'absent' } },
  });
  expect(
    [...surface.element.querySelectorAll('.abyss-project-dashboard-status')].map(
      (el) => el.textContent,
    ),
  ).toContain('No status');
  h.session.stage({
    kind: 'project',
    before: {
      ...project,
      target: 'unknown-project',
      status: { state: 'unrecognized', value: 'Authored custom status' },
    },
  });
  expect(
    [...surface.element.querySelectorAll('.abyss-project-dashboard-status')].map(
      (el) => el.textContent,
    ),
  ).toContain('Authored custom status');
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
});

it('retains selection and scroll when the active surface remounts', async () => {
  const h = await setup();
  const first = h.mount();
  first.input.value = 'Retained command';
  first.input.dispatchEvent(new Event('input', { bubbles: true }));
  first.input.setSelectionRange(3, 7);
  const content = expectDefined(first.element.querySelector<HTMLElement>('.abyss-command-content'));
  content.scrollTop = 41;
  first.destroy();
  const second = h.mount();
  second.focus();
  expect(second.input.value).toBe('Retained command');
  expect(second.input.selectionStart).toBe(3);
  expect(second.input.selectionEnd).toBe(7);
  expect(second.element.querySelector<HTMLElement>('.abyss-command-content')?.scrollTop).toBe(41);
});

it('uses one primary button for send, ready confirmation and stopping, while busy empty Enter is inert', async () => {
  const h = await setup();
  const surface = h.mount();
  const primary = expectDefined(
    surface.element.querySelector<HTMLButtonElement>('.abyss-command-toolbar button:last-child'),
  );
  enter(surface, 'Create');
  await flushMicrotasks(0);
  expect(primary.getAttribute('aria-label')).toBe('Save proposal');
  expect(surface.element.querySelector('.abyss-command-phase')?.textContent).toContain(
    'Enter to save',
  );
  h.session.question('Which child?');
  expect(primary.disabled).toBe(true);
  expect(primary.getAttribute('aria-label')).toBe('Send');
  const hold = deferred<void>();
  let signal: AbortSignal | undefined;
  h.setRun(async (input) => {
    signal = input.signal;
    await hold.promise;
  });
  enter(surface, 'Answer');
  await flushMicrotasks(0);
  surface.input.value = '';
  surface.input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(primary.getAttribute('aria-label')).toBe('Stop');
  surface.input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  expect(signal?.aborted).toBe(false);
  primary.click();
  expect(signal?.aborted).toBe(true);
  hold.resolve();
  await flushMicrotasks(0);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  expect(h.owner.snapshot().proposal.changes).toHaveLength(1);
});

it('toggles an existing planned node from its staged lifecycle status without writing source', async () => {
  const h = await setup();
  const listed = await h.api.tasks.list({});
  if (!listed.ok) throw new Error(listed.error.message);
  const root = expectDefined(listed.value.items[0]);
  const edit = await expectDefined(h.api.tasks.prepare)({
    kind: 'edit',
    target: root.target,
    expectedRevision: root.revision,
  });
  if (!edit.ok) throw new Error(edit.error.message);
  h.session.stage({ kind: 'task', plan: edit.value });
  const surface = h.mount();
  await flushMicrotasks(0);
  const checkbox = expectDefined(surface.element.querySelector<HTMLElement>('[role="checkbox"]'));
  checkbox.click();
  await flushMicrotasks(0);
  expect(checkbox.getAttribute('aria-checked')).toBe('true');
  checkbox.click();
  await flushMicrotasks(0);
  expect(checkbox.getAttribute('aria-checked')).toBe('false');
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
});

it('keeps ordinary ready selection quiet and acknowledges only explicit reveal requests', async () => {
  const h = await setup();
  const listed = await h.api.tasks.list({});
  if (!listed.ok) throw new Error(listed.error.code);
  const task = expectDefined(listed.value.items[0]);
  const surface = h.mount();
  h.setRun(async ({ signal }) => {
    await h.session.focus({ kind: 'task', target: task.target, revision: task.revision }, signal);
  });
  surface.focus();
  enter(surface, 'Select this task');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('ready');
  });
  expect(h.navigate).not.toHaveBeenCalled();
  h.setRun(async ({ signal }) => {
    expect(await h.session.requestReveal(task, signal)).toBe(true);
  });
  enter(surface, 'Open this task');
  await vi.waitFor(() => {
    expect(h.navigate).toHaveBeenCalledExactlyOnceWith(task.target, task.revision, 'reveal');
  });
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('ready');
  });
  expect(h.owner.snapshot().reveal).toBeUndefined();
  expect(document.activeElement).toBe(surface.input);
});

function toolReferences(
  message: Parameters<MockLanguageModelV4['doGenerate']>[0]['prompt'][number],
): unknown {
  if (message.role !== 'tool') return undefined;
  for (const result of [...message.content].reverse()) {
    if (result.type !== 'tool-result' || result.output.type !== 'json') continue;
    const references = record(result.output.value)?.['references'];
    if (references !== undefined) return references;
  }
  return undefined;
}
function surfaceReferences(
  prompt: Parameters<MockLanguageModelV4['doGenerate']>[0]['prompt'],
): unknown {
  for (const message of [...prompt].reverse()) {
    const references = toolReferences(message);
    if (references !== undefined) return references;
    if (message.role !== 'user') continue;
    const text = message.content.find((part) => part.type === 'text');
    if (text?.type === 'text')
      return record(record(JSON.parse(text.text))?.['visibleSession'])?.['references'];
  }
  throw Error('Missing current references');
}
function referenceRows(value: unknown, family: string): Array<Record<string, unknown>> {
  const rows = record(value)?.[family];
  return Array.isArray(rows) ? rows.map((row: unknown) => expectDefined(record(row))) : [];
}
function currentSelection(h: Awaited<ReturnType<typeof setup>>) {
  const state = h.owner.snapshot();
  const rows = referenceRows(commandReferences(state), 'taskReferences');
  return state.focus.map((focus) => {
    const basis = record(rows.find((row) => row['target'] === focus.target)?.['editBasis']);
    if (focus.kind !== 'task' || basis?.['kind'] !== 'append') return focus;
    return {
      kind: 'task',
      target: focus.target,
      plan: basis['plan'],
      expectedPlanRevision: basis['expectedPlanRevision'],
    };
  });
}
function surfaceEdit(
  h: Awaited<ReturnType<typeof setup>>,
  references: unknown,
  target: string,
): string {
  const canonical = commandReferences(h.owner.snapshot());
  const family = referenceRows(canonical, 'commentReferences').some(
    (row) => row['target'] === target,
  )
    ? 'commentReferences'
    : 'taskReferences';
  const index = referenceRows(canonical, family).findIndex((row) => row['target'] === target);
  if (index < 0) throw Error('Missing exact editable owner');
  return String(expectDefined(referenceRows(references, family)[index]?.['edit']));
}

function scriptedAgent(
  h: Awaited<ReturnType<typeof setup>>,
  calls: Array<{ tool: string; input: unknown }>,
): void {
  let sequence = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async ({ prompt }) => {
      const call = expectDefined(calls.shift());
      const references = surfaceReferences(prompt);
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `surface-${++sequence}`,
            toolName: call.tool,
            input: JSON.stringify(
              typeof call.input === 'function'
                ? (call.input as (references: unknown) => unknown)(references)
                : call.input,
            ),
          },
          ...(call.tool === 'interpret' && (call.input as { intent?: string }).intent !== 'confirm'
            ? [
                {
                  type: 'tool-call' as const,
                  toolCallId: `surface-${++sequence}`,
                  toolName: 'expand',
                  input: JSON.stringify({
                    capabilities: ['read', 'task', 'note', 'project', 'link', 'cleanup', 'status'],
                  }),
                },
              ]
            : []),
        ],
        finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const agent = new CommandAgent({
    reviewWrite: scriptedWriteReview,
    api: h.api,
    session: h.session,
    connections: { model: () => model },
    settings: () => ({}),
    now: () => Date.UTC(2026, 7, 1, 12),
  });
  h.setRun((input) => agent.run(input));
}

it('proves the first saved-comment rewrite through the real tool path and restores cumulative changes under the exact duplicate owner', async () => {
  const h = await setup();
  await h.external(
    'a.md',
    '- [ ] Existing\n\t- [ ] Duplicate\n\t\t- 2026-08-01: Bring red pen\n\t- [ ] Duplicate\n\t\t- 2026-08-01: Bring red pen\n',
  );
  const listed = await h.api.tasks.list({});
  if (!listed.ok) throw new Error(listed.error.code);
  const root = expectDefined(listed.value.items[0]);
  const read = await expectDefined(h.api.tasks.tree)({ target: root.target, limit: 500 });
  if (!read.ok) throw new Error(read.error.code);
  const second = expectDefined(read.value.tree.children[1]);
  const detail = await expectDefined(h.api.tasks.tree)({ target: second.target, limit: 500 });
  if (!detail.ok) throw new Error(detail.error.code);
  const comment = expectDefined(detail.value.tree.comments[0]);
  const calls: Array<{ tool: string; input: unknown }> = [
    { tool: 'interpret', input: { intent: 'plan', research: false } },
    { tool: 'read', input: { input: { kind: 'tree', target: second.target, limit: 500 } } },
    {
      tool: 'change_task',
      input: (references: unknown) => ({
        edit: surfaceEdit(h, references, comment.target),
        operation: { type: 'update-comment', text: 'Bring blue pen' },
      }),
    },
    { tool: 'finish', input: { state: 'ready', message: 'Ready.' } },
  ];
  scriptedAgent(h, calls);
  const observations: Array<{ preparations: number; plans: number }> = [];
  const unsubscribe = h.session.subscribe((state) => {
    observations.push({
      preparations: state.preparations?.length ?? 0,
      plans: state.proposal.changes.length,
    });
  });
  const surface = h.mount();
  enter(surface, 'Change only the second child comment');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().input).toBe('');
    expect(h.owner.snapshot().status.kind, h.owner.snapshot().status.message).toBe('ready');
  });
  const rows = surface.element.querySelectorAll<HTMLElement>('.abyss-comment-row');
  expect(expectDefined(rows[0]).textContent).toBe('Bring red pen');
  const changed = expectDefined(rows[1]);
  expect(changed.querySelector('del')?.textContent).toBe('red');
  expect(changed.querySelector('ins')?.textContent).toBe('blue');
  expect(observations.some((value) => value.preparations === 1 && value.plans === 0)).toBe(false);
  unsubscribe();
  calls.push(
    { tool: 'interpret', input: { intent: 'plan', research: false } },
    {
      tool: 'finish',
      input: () => ({
        state: 'ready',
        message: 'All changes.',
        presentation: 'cumulative',
        selection: currentSelection(h),
      }),
    },
  );
  enter(surface, 'Show all changes');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().input).toBe('');
    expect(h.owner.snapshot().status.kind, h.owner.snapshot().status.message).toBe('ready');
  });
  expect(changed.querySelector('del')?.textContent).toBe('red');
  surface.destroy();
  const reopened = h.mount();
  await flushMicrotasks(0);
  expect(reopened.element.querySelector('del')?.textContent).toBe('red');
  calls.push(
    { tool: 'interpret', input: { intent: 'plan', research: false } },
    {
      tool: 'finish',
      input: () => ({
        state: 'ready',
        message: 'Selection retained.',
        selection: currentSelection(h),
      }),
    },
  );
  enter(reopened, 'Keep that selection');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().input).toBe('');
    expect(h.owner.snapshot().status.kind, h.owner.snapshot().status.message).toBe('ready');
  });
  expect(reopened.element.querySelector('del')).toBeNull();
  expect(h.owner.snapshot().presentation).toBeUndefined();
  expect(await h.read('a.md')).not.toContain('blue');
});

it('marks a direct saved-child link after two note-only turns and retains its iteration cue on remount', async () => {
  mockReadingView();
  const original =
    '- [ ] Parent\n  - [ ] Duplicate\n    - First authored\n  - [ ] Duplicate\n    - Second authored\n    - Keep sibling\n';
  const h = await setup({ 'a.md': original });
  const listed = await h.api.tasks.list({ path: 'a.md' });
  if (!listed.ok) throw new Error(listed.error.code);
  const root = expectDefined(listed.value.items[0]);
  const page = await expectDefined(h.api.tasks.tree)({ target: root.target, limit: 500 });
  if (!page.ok) throw new Error(page.error.code);
  const child = expectDefined(page.value.tree.children[1]);
  const calls: Array<{ tool: string; input: unknown }> = [
    { tool: 'interpret', input: { intent: 'plan', research: false } },
    {
      tool: 'note',
      input: {
        input: {
          kind: 'create',
          path: 'Research.md',
          title: 'Research',
          text: 'Long conclusions.',
        },
      },
    },
    { tool: 'finish', input: { state: 'ready', message: 'Note prepared.' } },
  ];
  scriptedAgent(h, calls);
  let surface = h.mount();
  enter(surface, 'Prepare a research note');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.message).toBe('Ready. Enter to save.');
  });
  const note = expectDefined(
    h.owner.snapshot().proposal.changes.find((change) => change.kind === 'note'),
  );
  calls.push(
    { tool: 'interpret', input: { intent: 'plan', research: false } },
    {
      tool: 'note',
      input: {
        input: {
          kind: 'refine',
          plan: note.plan.target,
          expectedPlanRevision: note.plan.revision,
          operation: { type: 'replace-body', text: 'Short conclusions.' },
        },
      },
    },
    { tool: 'finish', input: { state: 'ready', message: 'Note shortened.' } },
  );
  enter(surface, 'Shorten the note');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.message).toBe('Ready. Enter to save.');
  });
  expect(h.owner.snapshot().entities.tasks).toHaveLength(0);
  expect(surface.element.querySelectorAll('.abyss-comment-row')).toHaveLength(0);
  calls.push(
    { tool: 'interpret', input: { intent: 'plan', research: false } },
    {
      tool: 'link',
      input: {
        notePlan: note.plan.target,
        target: child.target,
        expectedRevision: child.revision,
        field: 'comment',
        template: 'Details: {{link}}',
        alias: 'Comparison',
      },
    },
    {
      tool: 'finish',
      input: () => {
        const task = expectDefined(
          h.owner.snapshot().proposal.changes.find((change) => change.kind === 'task'),
        );
        return {
          state: 'ready',
          message: 'Link prepared.',
          selection: [
            {
              kind: 'task',
              target: expectDefined(task.plan.after).target,
              plan: task.plan.target,
              expectedPlanRevision: task.plan.revision,
            },
          ],
        };
      },
    },
  );
  enter(surface, 'Link the note under the second child');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.message).toBe('Ready. Enter to save.');
  });
  await flushMicrotasks(0);
  const rows = [...surface.element.querySelectorAll<HTMLElement>('.abyss-comment-row')];
  expect(rows.map((row) => row.textContent)).toEqual([
    'First authored',
    'Second authored',
    'Keep sibling',
    'Details: Comparison',
  ]);
  expect(rows.map((row) => row.dataset['change'])).toEqual(['', '', '', 'added']);
  expect(h.owner.snapshot().focus).toHaveLength(1);
  surface.destroy();
  surface = h.mount();
  await flushMicrotasks(0);
  expect(surface.element.querySelectorAll('.abyss-comment-row[data-change="added"]')).toHaveLength(
    1,
  );
  calls.push(
    { tool: 'interpret', input: { intent: 'plan', research: false } },
    {
      tool: 'finish',
      input: () => ({
        state: 'ready',
        message: 'Selection retained.',
        selection: currentSelection(h),
      }),
    },
  );
  enter(surface, 'Keep this selection');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().input).toBe('');
    expect(h.owner.snapshot().status.kind, h.owner.snapshot().status.message).toBe('ready');
  });
  expect(surface.element.querySelectorAll('.abyss-comment-row[data-change="added"]')).toHaveLength(
    0,
  );
  expect(await h.read('a.md')).toBe(original);
  expect(h.app.vault.getFileByPath('Research.md')).toBeNull();
});

it('resolves detached existing-edit child links from the exact write-owner note', async () => {
  mockReadingView();
  const h = await setup({
    'Folder/Details.md': 'Near detail',
    'Folder/Tasks.md': '- [ ] Relative root\n\t- [ ] Child\n',
  });
  const listed = await h.api.tasks.list({});
  if (!listed.ok) throw new Error(listed.error.code);
  const root = expectDefined(listed.value.items.find((task) => task.title === 'Relative root'));
  const page = await expectDefined(h.api.tasks.tree)({ target: root.target, limit: 500 });
  if (!page.ok) throw new Error(page.error.code);
  const child = expectDefined(page.value.tree.children[0]);
  const prepared = await expectDefined(h.api.tasks.prepare)({
    kind: 'edit',
    target: root.target,
    expectedRevision: root.revision,
    operation: {
      type: 'description',
      target: child.target,
      text: 'Read [[Details#Section|the nearby detail]]',
    },
  });
  if (!prepared.ok) throw new Error(prepared.error.code);
  const plan = await canonicalCommandPlan(h.api, prepared.value, new AbortController().signal, {
    now: () => Date.UTC(2026, 7, 1, 12),
    deadline: Date.UTC(2026, 7, 1, 12) + 5000,
  });
  h.session.stage({ kind: 'task', plan });
  const resolve = vi
    .spyOn(h.app.metadataCache, 'getFirstLinkpathDest')
    .mockImplementation(
      (_path, source) =>
        h.app.vault.getAbstractFileByPath(
          source === 'Folder/Tasks.md' ? 'Folder/Details.md' : 'Other/Details.md',
        ) as ReturnType<typeof h.app.metadataCache.getFirstLinkpathDest>,
    );
  const open = vi.spyOn(h.app.workspace, 'openLinkText').mockResolvedValue();
  const surface = h.mount();
  await flushMicrotasks(0);
  const description = expectDefined(surface.element.querySelector<HTMLElement>('.abyss-task-desc'));
  expect(description.dataset['taskSourcePath']).toBe('Folder/Tasks.md');
  expectDefined(description.querySelector('a')).click();
  await flushMicrotasks(0);
  expect(resolve).toHaveBeenCalledWith('Details', 'Folder/Tasks.md');
  expect(open).toHaveBeenCalledWith('Details#Section', 'Folder/Tasks.md', false);
  expect(await h.read('Folder/Tasks.md')).not.toContain('Read');
});

function currentTaskChange(
  state: CommandSessionSnapshot,
): Extract<CommandSessionSnapshot['proposal']['changes'][number], { kind: 'task' }> {
  const change = state.proposal.changes[0];
  if (change?.kind !== 'task') throw new Error('Expected task proposal');
  return change;
}

it.each(['', ' ⏰ 10:00'])(
  'shows duration set/change/removal and a scheduled date masked by due (%s)',
  async (time) => {
    const h = await setup({ 'a.md': `- [ ] Timed 📅 2026-08-10 ⏱️ 30m${time}\n` });
    const listed = await h.api.tasks.list({});
    if (!listed.ok) throw new Error(listed.error.code);
    const root = expectDefined(listed.value.items[0]);
    const prepared = await expectDefined(h.api.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
    });
    if (!prepared.ok) throw new Error(prepared.error.code);
    let plan = await canonicalCommandPlan(h.api, prepared.value, new AbortController().signal, {
      now: () => Date.UTC(2026, 7, 1, 12),
      deadline: Date.UTC(2026, 7, 1, 12) + 5000,
    });
    h.session.stage({ kind: 'task', plan });
    const surface = h.mount();
    await flushMicrotasks(0);
    expect(surface.element.textContent).toContain('30m');
    plan = await refineCommand(h, plan, {
      type: 'patch',
      target: root.target,
      patch: {
        durationMinutes: { type: 'set', value: 45 },
        scheduled: { type: 'set', value: '2026-08-03' },
      },
    });
    const duration = [
      ...surface.element.querySelectorAll<HTMLElement>('[data-change="changed"]'),
    ].find((element) => element.querySelector('ins')?.textContent === '45m');
    expect(duration).toBeDefined();
    expect(
      [...surface.element.querySelectorAll('.abyss-task-meta-right del')].some(
        (element) => element.textContent === '30m',
      ),
    ).toBe(true);
    expect(duration?.querySelector('del')?.textContent).toBe('30m');
    expect(surface.element.textContent).toContain('2026-08-03');
    expect(surface.element.textContent).toContain('2026-08-10');
    await refineCommand(h, plan, {
      type: 'patch',
      target: root.target,
      patch: { durationMinutes: { type: 'clear' } },
    });
    const removed = [
      ...surface.element.querySelectorAll<HTMLElement>('[data-change="removed"]'),
    ].find((element) => element.textContent === '30m');
    expect(removed).toBeDefined();
    expect(surface.element.querySelector('[data-change="changed"]')?.textContent).not.toBe('10:00');
    expect(await h.read('a.md')).toContain('30m');
  },
);
it('shows removals from an earlier draft iteration, then retires their ghosts', async () => {
  const h = await setup();
  let surface = h.mount();
  enter(surface, 'Create');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('ready');
  });
  let plan = currentPlan(h);
  const first = expectDefined(plan.after?.children[0]);
  const second = expectDefined(plan.after?.children[1]);
  h.session.exchange('user', 'Remove the first child and the comment under the second');
  plan = await refineCommand(h, plan, {
    type: 'remove-comment',
    target: expectDefined(second.comments[0]).target,
  });
  await refineCommand(h, plan, { type: 'remove', target: first.target });
  expect(
    surface.element.querySelector('.abyss-comment-row[data-change="removed"]')?.textContent,
  ).toBe('Second child only');
  expect(
    surface.element.querySelector(
      '.abyss-subtask-content[data-change="removed"] .abyss-subtask-label',
    )?.textContent,
  ).toBe('Duplicate');
  surface.destroy();
  surface = h.mount();
  await flushMicrotasks(0);
  expect(surface.element.querySelector('.abyss-comment-row[data-change="removed"]')).not.toBeNull();
  h.session.exchange('user', 'Continue');
  await flushMicrotasks(0);
  expect(surface.element.querySelector('[data-change="removed"]')).toBeNull();
});

async function refineCommand(
  h: Awaited<ReturnType<typeof setup>>,
  plan: ContentPlanV1,
  operation: TaskContentOperationV1,
): Promise<ContentPlanV1> {
  const request = {
    kind: 'append' as const,
    plan: plan.target,
    expectedPlanRevision: plan.revision,
    operation,
  };
  const result = await expectDefined(h.api.tasks.prepare)(request);
  if (!result.ok) throw new Error(result.error.code);
  const next = await canonicalCommandPlan(h.api, result.value, new AbortController().signal, {
    now: () => Date.UTC(2026, 7, 1, 12),
    deadline: Date.UTC(2026, 7, 1, 12) + 5000,
  });
  h.session.stage({ kind: 'task', plan: next }, 1, [
    { kind: 'task', input: prepareSchema.parse(request) },
  ]);
  await flushMicrotasks(0);
  return next;
}

it('coalesces transient phase updates while questions and errors replace them immediately', async () => {
  const h = await setup();
  const surface = h.mount();
  const phase = expectDefined(
    surface.element.querySelector<HTMLElement>('.abyss-command-phase > span'),
  );
  vi.useFakeTimers();
  try {
    h.session.status('thinking', 'Planning…');
    h.session.status('searching', 'Looking up tasks…');
    expect(phase.textContent).not.toBe('Looking up tasks…');
    await vi.advanceTimersByTimeAsync(150);
    expect(phase.textContent).toBe('Looking up tasks…');
    h.session.status('thinking', 'Planning again…');
    h.session.question('Which date?');
    expect(phase.textContent).toBe('Needs your answer.');
    await vi.advanceTimersByTimeAsync(150);
    expect(phase.textContent).toBe('Needs your answer.');
    h.session.status('error', 'Read failed.');
    expect(phase.textContent).toBe('Read failed.');
    h.session.status('thinking', 'Late phase');
    surface.destroy();
    await vi.advanceTimersByTimeAsync(200);
    expect(phase.textContent).not.toBe('Late phase');
  } finally {
    vi.useRealTimers();
  }
});

it.each(['stale', 'unknown'])(
  'keeps the merge source visible and retained when the destination is %s',
  async (failure) => {
    const h = await setup({ 'a.md': '- [ ] Source\n- [ ] Destination\n' }, (api) => ({
      ...api,
      tasks: {
        ...api.tasks,
        apply: async (input) => {
          const result = await expectDefined(api.tasks.apply)(input);
          return failure === 'unknown'
            ? {
                ok: false as const,
                error: { code: 'LOST', category: 'io' as const, message: 'Lost receipt' },
                effects: 'unknown' as const,
                recovery: 'reconcile' as const,
              }
            : result;
        },
      },
    }));
    const listed = await h.api.tasks.list({});
    if (!listed.ok) throw new Error(listed.error.code);
    const source = expectDefined(listed.value.items.find((task) => task.title === 'Source'));
    const destination = expectDefined(
      listed.value.items.find((task) => task.title === 'Destination'),
    );
    scriptedAgent(h, [
      { tool: 'interpret', input: { intent: 'plan', research: false } },
      {
        tool: 'task',
        input: {
          input: {
            kind: 'edit',
            target: destination.target,
            expectedRevision: destination.revision,
            operation: { type: 'description', target: destination.target, text: 'Source' },
          },
        },
      },
      {
        tool: 'task',
        input: () => {
          const { plan } = currentTaskChange(h.owner.snapshot());
          return {
            input: {
              kind: 'append',
              plan: plan.target,
              expectedPlanRevision: plan.revision,
              operation: {
                type: 'assess-merge',
                source: source.target,
                expectedSourceRevision: source.revision,
                target: destination.target,
              },
            },
          };
        },
      },
      {
        tool: 'cleanup',
        input: () => {
          const { plan } = currentTaskChange(h.owner.snapshot());
          return { destinationPlan: plan.target, destinationRevision: plan.revision };
        },
      },
      { tool: 'finish', input: { state: 'ready', message: 'Ready.' } },
    ]);
    const surface = h.mount();
    enter(surface, 'Merge both tasks');
    await vi.waitFor(() => {
      expect(h.owner.snapshot().input).toBe('');
      expect(h.owner.snapshot().status.kind, h.owner.snapshot().status.message).toBe('ready');
    });
    expect(surface.element.querySelectorAll('.abyss-task-title')).toHaveLength(2);
    const removed = expectDefined(
      [...surface.element.querySelectorAll<HTMLElement>('.abyss-task-card')].find(
        (row) => row.dataset['change'] === 'removed',
      ),
    );
    expect(removed.textContent).toContain('Source');
    expect(removed.inert).toBe(true);
    if (failure === 'stale')
      await h.external('a.md', '- [ ] Source\n- [ ] Destination changed externally\n');
    enter(surface, '');
    await vi.waitFor(() => {
      expect(h.owner.snapshot().status.kind).toBe('error');
    });
    expect(await h.read('a.md')).toContain('- [ ] Source');
    expect(surface.element.contains(removed)).toBe(true);
    expect(removed.inert).toBe(true);
  },
);

async function projectSetup(
  source = '---\nEffort: 2\n---\nProject body\n',
  other: Record<string, string> = {},
) {
  const app = await createAppWithFiles({
    ...other,
    'projects/Project.md': source,
  });
  await app.vault.adapter.mkdir(`${app.vault.configDir}/plugins/abyss-tasks`);
  const plugin = new TaskCalendarPlugin(app, {
    id: 'abyss-tasks',
    name: 'Abyss Tasks',
    version: 'test',
  } as ConstructorParameters<typeof TaskCalendarPlugin>[1]);
  await plugin.onload();
  cleanups.push(() => {
    plugin.onunload();
  });
  Object.assign(plugin.settings.projects, {
    membershipQuery: 'projects/',
    createFolder: 'projects',
    propertyDefinitionsVersion: 1,
    propertyDefinitions: { 'property:Effort': { type: 'number' } },
  });
  await plugin.saveSettings();
  (app.workspace as unknown as { setLayoutReady__(): void }).setLayoutReady__();
  const issued = plugin.getApi(1, { consumerId: 'project-ui' });
  if (!issued.ok) throw new Error(issued.error.code);
  const api = issued.value;
  await api.ready();
  const projects = expectDefined(api.projects);
  const listed = await projects.list();
  if (!listed.ok) throw new Error(listed.error.code);
  const read = await projects.get(expectDefined(listed.value.items[0]).target);
  if (!read.ok) throw new Error(read.error.code);
  const project = read.value;
  const h = await setup(
    {},
    () => api,
    () => Date.now(),
  );
  h.projectSettings.propertyDefinitions['property:Effort'] = { type: 'number' };
  await h.owner.focus({ kind: 'project', target: project.target, revision: project.revision });
  return { h, project, projects, api };
}

it('keeps the session gutter after a new project saves and remounts', async () => {
  const { h, projects } = await projectSetup();
  const schema = await projects.schema();
  if (!schema.ok) throw new Error(schema.error.code);
  h.setRun(async ({ text, signal, session }) => {
    if (text === 'Save') await h.session.confirmFromTurn(session.proposal.revision, signal);
    else
      h.session.stage({
        kind: 'project-create',
        id: 'new-project-preview',
        name: 'Created project',
        schema: schema.value,
      });
  });
  let surface = h.mount();
  enter(surface, 'Create');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('ready');
  });
  const row = () =>
    expectDefined(
      [...surface.element.querySelectorAll<HTMLElement>('[data-session-changed]')].find((element) =>
        element.textContent.includes('Created project'),
      ),
    );
  expect(row().dataset['sessionChanged']).toBe('true');
  enter(surface, 'Save');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('saved');
  });
  expect(h.owner.snapshot().proposal.changes).toHaveLength(0);
  expect(row().dataset['sessionChanged']).toBe('true');
  expect(row().querySelector('ins, del')).toBeNull();
  surface.destroy();
  surface = h.mount();
  expect(row().dataset['sessionChanged']).toBe('true');
});

it.each([true, false])(
  'keeps project changes while selecting its member task (related=%s)',
  async (related) => {
    const { h, project, api } = await projectSetup('---\nEffort: 2\n---\n- [ ] Member\n', {
      'Other.md': '- [ ] Unrelated\n',
    });
    h.session.stage({
      kind: 'project',
      before: project,
      fields: [{ fieldId: 'start', value: '2026-08-03' }],
    });
    const pending = h.owner.snapshot().proposal.changes;
    const surface = h.mount();
    const listed = await api.tasks.list();
    if (!listed.ok) throw new Error(listed.error.code);
    const task = expectDefined(
      listed.value.items.find((item) => item.title === (related ? 'Member' : 'Unrelated')),
    );
    expect(
      await h.owner.focus({ kind: 'task', target: task.target, revision: task.revision }),
    ).toBe(related);
    expect(h.owner.snapshot().proposal.changes).toEqual(pending);
    if (related) {
      expect(h.owner.snapshot().pendingTransition ?? null).toBeNull();
      await vi.waitFor(() => {
        expect(surface.element.textContent).toContain('Member');
      });
      expect(surface.element.textContent).toContain('Project');
    } else expect(h.owner.snapshot().pendingTransition?.kind).toBe('focus');
  },
);

it('keeps only this project iteration highlighted across remount and shows cumulative fields on request until verified save', async () => {
  const { h, project, projects } = await projectSetup();
  h.setRun(async ({ text, signal }) => {
    if (text === 'All changes') h.session.showChanges(signal);
    else {
      h.session.stage({
        kind: 'project',
        before: project,
        fields:
          text === 'Effort'
            ? [{ fieldId: 'property:Effort', value: 5 }]
            : [{ fieldId: 'start', value: '2026-08-03' }],
      });
      if (text === 'Start')
        h.session.stage({
          kind: 'project',
          before: project,
          fields: [{ fieldId: 'end', value: '2026-08-04' }],
        });
    }
  });
  let surface = h.mount();
  const field = () =>
    expectDefined(surface.element.querySelector('[data-project-field="property:Effort"]'));
  const start = () => expectDefined(surface.element.querySelector('[aria-label^="Start:"]'));
  const command = async (text: string) => {
    enter(surface, text);
    await vi.waitFor(() => {
      expect(h.owner.snapshot().status.kind).toBe('ready');
      expect(surface.input.value).toBe('');
    });
  };
  await command('Effort');
  expect(field().closest('[data-session-changed="true"]')).not.toBeNull();
  expect(field().getAttribute('data-change')).toBe('changed');
  const retainedProperty = field();
  await command('Start');
  expect(field().closest('[data-session-changed="true"]')).not.toBeNull();
  expect(field()).toBe(retainedProperty);
  expect(start().compareDocumentPosition(field()) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  expect(field().getAttribute('data-change')).toBe('');
  expect(start().getAttribute('data-change')).toBe('changed');
  expect(surface.element.querySelector('[aria-label^="End:"]')?.getAttribute('data-change')).toBe(
    'changed',
  );
  h.session.status('ready', 'Still ready.');
  surface.destroy();
  surface = h.mount();
  expect(field().getAttribute('data-change')).toBe('');
  expect(start().getAttribute('data-change')).toBe('changed');
  await command('All changes');
  expect(field().getAttribute('data-change')).toBe('changed');
  expect(start().getAttribute('data-change')).toBe('changed');
  surface.destroy();
  surface = h.mount();
  expect(field().getAttribute('data-change')).toBe('changed');
  expect(start().getAttribute('data-change')).toBe('changed');
  h.confirmInSession(surface);
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind, h.owner.snapshot().status.message).toBe('saved');
  });
  expect(
    surface.element.querySelector('[data-change="changed"], [data-change="removed"]'),
  ).toBeNull();
  expect(surface.element.querySelector('.abyss-project-dashboard-title')?.textContent).toBe(
    project.name,
  );
  const saved = await projects.get(project.target);
  if (!saved.ok) throw new Error(saved.error.code);
  expect(saved.value.fields).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ fieldId: 'property:Effort', value: 5 }),
      expect.objectContaining({ fieldId: 'start', value: '2026-08-03' }),
    ]),
  );
});

it('removes cleared project fields after their iteration and restores them only for cumulative review', async () => {
  const { h, project } = await projectSetup(
    '---\nstart: 2026-08-03\ndescription: Original description\n---\nProject body\n',
  );
  h.session.stage({
    kind: 'project',
    before: project,
    fields: [
      { fieldId: 'start', value: null },
      { fieldId: 'description', value: null },
    ],
  });
  const surface = h.mount();
  await flushMicrotasks(0);
  expect(surface.element.querySelector('[aria-label^="Start:"]')?.getAttribute('data-change')).toBe(
    'removed',
  );
  expect(
    surface.element
      .querySelector('[data-project-field="description"]')
      ?.getAttribute('data-change'),
  ).toBe('removed');
  expect(surface.element.querySelector('[aria-label^="Start:"] del')).not.toBeNull();
  expect(surface.element.querySelector('[data-project-field="description"] del')?.textContent).toBe(
    'Original description',
  );
  h.session.exchange('user', 'Continue with another detail');
  await flushMicrotasks(0);
  expect(surface.element.querySelector('[aria-label^="Start:"]')).toBeNull();
  expect(surface.element.querySelector('[data-project-field="description"]')).toBeNull();
  h.setRun(async ({ signal }) => {
    h.session.showChanges(signal);
  });
  enter(surface, 'All changes');
  await vi.waitFor(() => {
    expect(h.session.snapshot().status.kind).toBe('ready');
  });
  await flushMicrotasks(0);
  expect(surface.element.querySelector('[aria-label^="Start:"]')?.getAttribute('data-change')).toBe(
    'removed',
  );
  expect(
    surface.element.querySelector('[data-project-field="description"]')?.textContent,
  ).toContain('Original description');
});

it('shows the most recently reviewed project description when it is removed', async () => {
  const { h, project } = await projectSetup('---\ndescription: Original\n---\nProject body\n');
  const surface = h.mount();
  h.session.stage({
    kind: 'project',
    before: project,
    fields: [{ fieldId: 'description', value: 'Refined description' }],
  });
  await flushMicrotasks(0);
  h.session.exchange('user', 'Remove the description');
  h.session.stage({
    kind: 'project',
    before: project,
    fields: [{ fieldId: 'description', value: null }],
  });
  await flushMicrotasks(0);
  expect(surface.element.querySelector('[data-project-field="description"] del')?.textContent).toBe(
    'Refined description',
  );
});

it('reveals a changed project only after its native Markdown is ready', async () => {
  const { h, project } = await projectSetup();
  const waiting = deferred<void>();
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (...args) => {
    if (args[1].includes('Long updated description')) await waiting.promise;
    return renderNativeBlocks(...args);
  });
  h.session.stage({
    kind: 'project',
    before: project,
    fields: [{ fieldId: 'description', value: 'Long updated description with [[Details]]' }],
  });
  const surface = h.mount();
  const content = expectDefined(
    surface.element.querySelector<HTMLElement>('.abyss-command-content'),
  );
  const scroll = vi.fn();
  content.scrollTo = scroll;
  vi.spyOn(content, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 400 } as DOMRect);
  const property = expectDefined(
    content.querySelector<HTMLElement>('[data-project-field="description"]'),
  );
  vi.spyOn(property, 'getBoundingClientRect').mockReturnValue({ top: 600, bottom: 640 } as DOMRect);
  await flushMicrotasks(0);
  expect(scroll).not.toHaveBeenCalled();
  waiting.resolve();
  await flushMicrotasks(0);
  expect(property.textContent).toContain('Long updated description');
  expect(scroll).toHaveBeenCalledWith({ top: 248, behavior: 'smooth' });
});
it('waits for a focused project field to commit before revealing its change', async () => {
  const { h, project } = await projectSetup(
    '---\ndescription: "Original [[Details]]"\n---\nProject body\n',
  );
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, text, holder) => {
    const paragraph = holder.createEl('p', { text: text.replace('[[Details]]', '') });
    paragraph.createEl('a', { text: 'Details', href: 'https://example.test/details' });
  });
  const surface = h.mount();
  await flushMicrotasks(0);
  const content = expectDefined(
    surface.element.querySelector<HTMLElement>('.abyss-command-content'),
  );
  const property = expectDefined(
    content.querySelector<HTMLElement>('[data-project-field="description"]'),
  );
  const link = expectDefined(property.querySelector<HTMLAnchorElement>('a'));
  link.tabIndex = 0;
  link.focus();
  const scroll = vi.fn();
  content.scrollTo = scroll;
  vi.spyOn(content, 'getBoundingClientRect').mockReturnValue({ top: 100, bottom: 400 } as DOMRect);
  vi.spyOn(property, 'getBoundingClientRect').mockReturnValue({ top: 600, bottom: 640 } as DOMRect);
  h.session.stage({
    kind: 'project',
    before: project,
    fields: [{ fieldId: 'description', value: 'Updated [[Details]]' }],
  });
  await flushMicrotasks(0);
  expect(scroll).not.toHaveBeenCalled();
  expect(property.textContent).toContain('Original');
  surface.input.focus();
  await flushMicrotasks(0);
  expect(property.textContent).toContain('Updated');
  expect(scroll).toHaveBeenCalledWith({ top: 248, behavior: 'smooth' });
});

it('omits an absent project date after adding and clearing it in a cumulative preview', async () => {
  const { h, project } = await projectSetup('Project body\n');
  const surface = h.mount();
  h.session.stage({
    kind: 'project',
    before: project,
    fields: [{ fieldId: 'start', value: '2026-08-03' }],
  });
  await flushMicrotasks(0);
  h.session.exchange('user', 'Remove the new start');
  h.session.stage({
    kind: 'project',
    before: project,
    fields: [{ fieldId: 'start', value: null }],
  });
  await flushMicrotasks(0);
  expect(surface.element.querySelector('[aria-label^="Start:"] del')).not.toBeNull();
  h.setRun(async ({ signal }) => {
    h.session.showChanges(signal);
  });
  enter(surface, 'All changes');
  await vi.waitFor(() => {
    expect(h.session.snapshot().status.kind).toBe('ready');
  });
  await flushMicrotasks(0);
  expect(surface.element.querySelector('[aria-label^="Start:"]')).toBeNull();
});

it('retires a verified project description clear before and after remount', async () => {
  const { h, project, projects } = await projectSetup(
    '---\ndescription: Accepted description\n---\nProject body\n',
  );
  expect(project.fields).toContainEqual({
    fieldId: 'description',
    state: 'value',
    value: 'Accepted description',
  });
  scriptedAgent(h, [
    { tool: 'interpret', input: { intent: 'plan', research: false } },
    {
      tool: 'project',
      input: {
        target: project.target,
        expectedRevision: project.revision,
        fields: [{ fieldId: 'description', value: null }],
      },
    },
    { tool: 'finish', input: { state: 'ready', message: 'Ready.' } },
  ]);
  let surface = h.mount();
  enter(surface, 'Clear the description');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().input).toBe('');
    expect(h.owner.snapshot().status.kind, h.owner.snapshot().status.message).toBe('ready');
  });
  const removed = expectDefined(
    surface.element.querySelector<HTMLElement>('[data-project-field="description"]'),
  );
  expect(removed.textContent).toContain('Accepted description');
  expect(removed.dataset['change']).toBe('removed');
  expect(removed.inert).toBe(true);
  h.confirmInSession(surface);
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('saved');
  });
  const saved = await projects.get(project.target);
  if (!saved.ok) throw new Error(saved.error.code);
  expect(saved.value.fields).toContainEqual({ fieldId: 'description', state: 'absent' });
  expect(h.owner.snapshot().proposal.changes).toEqual([]);
  expect(surface.element.querySelector('[data-project-field="description"]')).toBeNull();
  expect(removed.isConnected).toBe(false);
  surface.destroy();
  surface = h.mount();
  expect(surface.element.querySelector('[data-project-field="description"]')).toBeNull();
});

function currentPlan(h: Awaited<ReturnType<typeof setup>>): ContentPlanV1 {
  const change = h.owner.snapshot().proposal.changes.find((entry) => entry.kind === 'task');
  if (change?.kind !== 'task') throw new Error('Missing canonical task plan');
  return change.plan;
}
function appendCall(
  h: Awaited<ReturnType<typeof setup>>,
  operation: (plan: ContentPlanV1) => TaskContentOperationV1,
) {
  return {
    tool: 'change_task',
    input: (references: unknown) => {
      const next = operation(currentPlan(h));
      const { target, ...change } = next;
      return { edit: surfaceEdit(h, references, target), operation: change };
    },
  };
}

it.each([
  ['B', 'A', 'Child C'],
  ['Child C', 'A', 'B'],
])('keeps owner comments before children through removals and remount (%j)', async (...order) => {
  const h = await setup({
    'a.md':
      '- [ ] Root\n\t- 2026-08-01T10:00:00+00:00 → 2026-08-01T10:30:00+00:00\n\t- 2026-08-01: A\n\t- 2026-08-01: B\n\t- [ ] Child C\n\t- 2026-08-01T11:00:00+00:00 → 2026-08-01T11:30:00+00:00\n\t- 2026-08-01: D\n\t- [ ] Child E\n\t\t- 2026-08-01: A\n',
  });
  const listed = await h.api.tasks.list();
  if (!listed.ok) throw new Error(listed.error.code);
  const root = expectDefined(listed.value.items[0]);
  await h.owner.focus({ kind: 'task', target: root.target, revision: root.revision });
  scriptedAgent(h, [
    { tool: 'interpret', input: { intent: 'plan', research: false } },
    {
      tool: 'task',
      input: { input: { kind: 'edit', target: root.target, expectedRevision: root.revision } },
    },
    ...order.map((label) =>
      appendCall(h, (plan) =>
        label === 'Child C'
          ? {
              type: 'remove',
              target: expectDefined(
                plan.after?.children.find((child) => child.markdownTitle === label),
              ).target,
            }
          : {
              type: 'remove-comment',
              target: expectDefined(plan.after?.comments.find((comment) => comment.text === label))
                .target,
            },
      ),
    ),
    { tool: 'finish', input: { state: 'ready', message: 'Ready.' } },
  ]);
  let surface = h.mount();
  enter(surface, 'Remove these exact comments and child');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().input).toBe('');
    expect(h.owner.snapshot().status.kind, h.owner.snapshot().status.message).toBe('ready');
  });
  const display = () => {
    const host = expectDefined(
      surface.element.querySelector('.abyss-command-tree > .abyss-task-card'),
    );
    return [...host.children]
      .filter((element) => element.matches('.abyss-comment-row, .abyss-subtask-content'))
      .map((element) => ({
        text: element.matches('.abyss-comment-row')
          ? element.textContent
          : element.querySelector('.abyss-subtask-label')?.textContent,
        removed: element.getAttribute('data-change') === 'removed',
      }));
  };
  const expected = [
    { text: 'A', removed: true },
    { text: 'B', removed: true },
    { text: 'D', removed: false },
    { text: 'Child C', removed: true },
    { text: 'Child E', removed: false },
  ];
  expect(display()).toEqual(expected);
  const nested = expectDefined(
    surface.element.querySelector('.abyss-subtask-content:last-child .abyss-comment-row'),
  );
  expect(nested.textContent).toBe('A');
  expect(nested.getAttribute('data-change')).not.toBe('removed');
  surface.destroy();
  surface = h.mount();
  await flushMicrotasks(0);
  expect(display()).toEqual(expected);
  h.confirmInSession(surface);
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('saved');
  });
  const saved = await expectDefined(h.api.tasks.tree)({ target: root.target, limit: 500 });
  if (!saved.ok) throw new Error(saved.error.code);
  expect(saved.value.tree.comments.map((comment) => comment.text)).toEqual(['D']);
  expect(saved.value.tree.children.map((child) => child.markdownTitle)).toEqual(['Child E']);
  expect(saved.value.tree.timeEntries).toHaveLength(2);
});

it.each([true, false])(
  'keeps the right removed-comment baseline when rewrite and removal share an iteration: %s',
  async (sameIteration) => {
    const h = await setup({ 'a.md': '- [ ] Original root\n\t- 2026-08-01: Original comment\n' });
    const listed = await h.api.tasks.list();
    if (!listed.ok) throw new Error(listed.error.code);
    const root = expectDefined(listed.value.items[0]);
    await h.owner.focus({ kind: 'task', target: root.target, revision: root.revision });
    const remove = () =>
      appendCall(h, (plan) => ({
        type: 'remove-comment',
        target: expectDefined(plan.after?.comments[0]).target,
      }));
    scriptedAgent(h, [
      { tool: 'interpret', input: { intent: 'plan', research: false } },
      {
        tool: 'task',
        input: { input: { kind: 'edit', target: root.target, expectedRevision: root.revision } },
      },
      appendCall(h, (plan) => ({
        type: 'update-comment',
        target: expectDefined(plan.after?.comments[0]).target,
        text: 'Refined comment',
      })),
      ...(sameIteration ? [remove()] : []),
      { tool: 'finish', input: { state: 'ready', message: 'Ready.' } },
    ]);
    let surface = h.mount();
    enter(surface, 'Refine the comment');
    await vi.waitFor(() => {
      expect(h.session.snapshot().status.kind).toBe('ready');
    });
    await flushMicrotasks(0);
    if (!sameIteration) {
      scriptedAgent(h, [
        { tool: 'interpret', input: { intent: 'plan', research: false } },
        remove(),
        { tool: 'finish', input: { state: 'ready', message: 'Ready.' } },
      ]);
      enter(surface, 'Remove that comment');
      await vi.waitFor(() => {
        expect(h.session.snapshot().status.kind).toBe('ready');
        expect(currentPlan(h).after?.comments).toEqual([]);
      });
    }
    await flushMicrotasks(0);
    expect(
      surface.element.querySelector('.abyss-comment-row[data-change="removed"]')?.textContent,
    ).toBe(sameIteration ? 'Original comment' : 'Refined comment');
    scriptedAgent(h, [
      { tool: 'interpret', input: { intent: 'plan', research: false } },
      {
        tool: 'finish',
        input: () => ({
          state: 'ready',
          message: 'All changes.',
          presentation: 'cumulative',
          selection: currentSelection(h),
        }),
      },
    ]);
    enter(surface, 'Show all changes');
    await vi.waitFor(() => {
      expect(h.session.snapshot().status.kind).toBe('ready');
    });
    await flushMicrotasks(0);
    expect(surface.element.querySelector('.abyss-comment-row del')?.textContent).toBe(
      'Original comment',
    );
    surface.destroy();
    surface = h.mount();
    await flushMicrotasks(0);
    expect(surface.element.querySelector('.abyss-comment-row del')?.textContent).toBe(
      'Original comment',
    );
  },
);

it('retains every task and comment change in one user iteration while keeping latest and cumulative review separate', async () => {
  const h = await setup({ 'a.md': '- [ ] Original root\n\t- 2026-08-01: Original comment\n' });
  const listed = await h.api.tasks.list();
  if (!listed.ok) throw new Error(listed.error.code);
  const root = expectDefined(listed.value.items[0]);
  await h.owner.focus({ kind: 'task', target: root.target, revision: root.revision });
  const calls: Array<{ tool: string; input: unknown }> = [
    { tool: 'interpret', input: { intent: 'plan', research: false } },
    {
      tool: 'task',
      input: {
        input: {
          kind: 'edit',
          target: root.target,
          expectedRevision: root.revision,
          operation: {
            type: 'patch',
            target: root.target,
            patch: { markdownTitle: { type: 'set', value: 'Renamed root' } },
          },
        },
      },
    },
    appendCall(h, (plan) => ({
      type: 'update-comment',
      target: expectDefined(plan.after?.comments[0]).target,
      text: 'Changed comment',
    })),
    appendCall(h, (plan) => ({
      type: 'patch',
      target: expectDefined(plan.after).target,
      patch: { due: { type: 'set', value: '2026-08-03' } },
    })),
    appendCall(h, (plan) => ({
      type: 'update-comment',
      target: expectDefined(plan.after?.comments[0]).target,
      text: 'Final comment',
    })),
    { tool: 'finish', input: { state: 'ready', message: 'Ready.' } },
  ];
  scriptedAgent(h, calls);
  let surface = h.mount();
  const title = () => expectDefined(surface.element.querySelector('.abyss-task-title'));
  const comment = () => expectDefined(surface.element.querySelector('.abyss-comment-row'));
  const row = () => expectDefined(title().closest('.abyss-task-card-main-row'));
  await flushMicrotasks(0);
  expect(row().getAttribute('data-session-changed')).not.toBe('true');
  expect(row().classList.contains('is-selected')).toBe(false);
  const checkFirst = () => {
    expect(
      surface.element.querySelector('.abyss-command-latest')?.closest('.abyss-command-content'),
    ).toBeNull();
    expect(row().getAttribute('data-session-changed')).toBe('true');
    expect(title().querySelector('del')?.textContent).toBe('Original');
    expect(title().querySelector('ins')?.textContent).toBe('Renamed');
    expect(comment().getAttribute('data-change')).toBe('changed');
    expect(comment().querySelector('del')?.textContent).toBe('Original');
    expect(comment().querySelector('ins')?.textContent).toBe('Final');
    expect(surface.element.querySelector('[aria-label^="due:"]')?.getAttribute('data-change')).toBe(
      'changed',
    );
  };
  enter(surface, 'Rename, rewrite comment, and set the date');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().input).toBe('');
    expect(h.owner.snapshot().status.kind, h.owner.snapshot().status.message).toBe('ready');
  });
  checkFirst();
  surface.destroy();
  surface = h.mount();
  await flushMicrotasks(0);
  checkFirst();
  calls.push(
    { tool: 'interpret', input: { intent: 'plan', research: false } },
    appendCall(h, (plan) => ({
      type: 'patch',
      target: expectDefined(plan.after).target,
      patch: { time: { type: 'set', value: '10:00' } },
    })),
    { tool: 'finish', input: { state: 'ready', message: 'Only time.' } },
  );
  enter(surface, 'Change only time');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.message).toBe('Ready. Enter to save.');
  });
  const checkLatest = () => {
    expect(row().getAttribute('data-session-changed')).toBe('true');
    expect(title().textContent).toBe('Renamed root');
    expect(comment().textContent).toBe('Final comment');
    expect(comment().getAttribute('data-change')).toBe('');
    expect(surface.element.querySelector('del')).toBeNull();
    expect(surface.element.querySelector('[aria-label^="due:"]')?.getAttribute('data-change')).toBe(
      '',
    );
    expect(
      surface.element.querySelector('.abyss-task-time-part')?.getAttribute('data-change'),
    ).toBe('changed');
  };
  checkLatest();
  surface.destroy();
  surface = h.mount();
  await flushMicrotasks(0);
  checkLatest();
  calls.push(
    { tool: 'interpret', input: { intent: 'plan', research: false } },
    {
      tool: 'finish',
      input: () => ({
        state: 'ready',
        message: 'All changes.',
        presentation: 'cumulative',
        selection: currentSelection(h),
      }),
    },
  );
  enter(surface, 'Show cumulative changes');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().input).toBe('');
    expect(h.owner.snapshot().status.kind, h.owner.snapshot().status.message).toBe('ready');
  });
  checkFirst();
  surface.destroy();
  surface = h.mount();
  await flushMicrotasks(0);
  checkFirst();
  h.confirmInSession(surface);
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('saved');
  });
  expect(surface.element.querySelector('del, [data-change="changed"]')).toBeNull();
  expect(row().getAttribute('data-session-changed')).toBe('true');
  surface.destroy();
  surface = h.mount();
  await flushMicrotasks(0);
  expect(row().getAttribute('data-session-changed')).toBe('true');
  expect(await h.read('a.md')).toContain('Renamed root');
  expect(await h.read('a.md')).toContain('Final comment');
});

it.each(['short', 'late'] as const)(
  'reviews a %s note-only section diff before confirmation and retains fresh current note content after save/remount',
  async (position) => {
    mockReadingView();
    const prefix =
      position === 'late'
        ? `---\nkeep: original\n---\n${'Unchanged prose. '.repeat(850)}\n- [ ] Earlier protected task\n\n`
        : '';
    const h = await setup({
      'Folder/Research.md': `${prefix}# Findings\nOld choice.\n\n- [ ] Protected\n\n# Keep\nUnrelated text.\n`,
    });
    const notes = expectDefined(h.api.notes);
    const read = await notes.read({ selector: { path: 'Folder/Research.md' } });
    if (!read.ok) throw new Error(read.error.code);
    h.session.observeNote(read.value);
    await h.session.focus([
      { kind: 'note', target: read.value.note.target, revision: read.value.note.revision },
    ]);
    const selected = expectDefined(
      read.value.segments.find((segment) => segment.text.includes('Old choice')),
    );
    const section = selected.section;
    expect(section.canReplace, JSON.stringify(section)).toBe(true);
    h.setRun(async () => {
      const plan = await notes.prepare({
        kind: 'edit',
        target: read.value.note.target,
        expectedRevision: read.value.note.revision,
        operation: {
          type: 'replace-section',
          section: section.target,
          text: selected.text.replace('Old choice.', 'New choice with [[Details|source]].'),
        },
      });
      if (!plan.ok) throw new Error(plan.error.code);
      h.session.stage({ kind: 'note', plan: plan.value });
    });
    const surface = h.mount();
    enter(surface, 'Revise the findings');
    await vi.waitFor(() => {
      expect(h.owner.snapshot().status.kind).toBe('ready');
    });
    const note = expectDefined(surface.element.querySelector<HTMLElement>('.abyss-command-note'));
    expect((note as HTMLDetailsElement).open).toBe(true);
    expect(note.textContent).toContain('Folder/Research.md');
    expect(
      note.querySelector('.abyss-text-difference-removed')?.textContent ??
        note.querySelector('del')?.textContent,
    ).toContain('Old');
    expect(note.querySelector('ins')?.textContent).toContain('New');
    expect(note.querySelector('input[type="checkbox"]')).toBeNull();
    expect(await h.read('Folder/Research.md')).toContain('Old choice');
    h.confirmInSession(surface);
    await vi.waitFor(() => {
      expect(h.owner.snapshot().status.kind).toBe('saved');
    });
    await flushMicrotasks(0);
    expect(await h.read('Folder/Research.md')).toContain('New choice');
    expect((await h.read('Folder/Research.md')).startsWith(prefix)).toBe(true);
    expect(await h.read('Folder/Research.md')).toContain('# Keep\nUnrelated text.');
    expect(surface.element.querySelector('.abyss-command-note')?.textContent).toContain(
      'New choice',
    );
    expect(surface.element.querySelector('.abyss-command-note del')).toBeNull();
    surface.destroy();
    const resumed = h.mount();
    await flushMicrotasks(0);
    expect(resumed.element.querySelector('.abyss-command-note')?.textContent).toContain(
      'New choice',
    );
  },
);
it('renders honest focused note excerpts and complete reads with native source-path wiki navigation', async () => {
  mockReadingView();
  const h = await setup({
    'Folder/Research.md': '# Findings\nRead [[Details#Section|source]] and [[Missing]].\n',
    'Folder/Details.md': '# Section\nRight\n',
  });
  const notes = expectDefined(h.api.notes);
  const first = await notes.read({ selector: { path: 'Folder/Research.md' }, limitCharacters: 10 });
  if (!first.ok) throw new Error(first.error.code);
  await h.session.focus([
    { kind: 'note', target: first.value.note.target, revision: first.value.note.revision },
  ]);
  h.session.observeNote(first.value);
  const surface = h.mount();
  await flushMicrotasks(0);
  expect(surface.element.querySelector('.abyss-command-note')?.textContent).toContain(
    'More content remains',
  );
  const full = await notes.read({
    selector: { path: 'Folder/Research.md' },
    limitCharacters: 12000,
  });
  if (!full.ok) throw new Error(full.error.code);
  h.session.observeNote(full.value);
  await flushMicrotasks(0);
  const note = expectDefined(surface.element.querySelector<HTMLElement>('.abyss-command-note'));
  expect(note.textContent).toContain('Full note');
  const resolve = vi
    .spyOn(h.app.metadataCache, 'getFirstLinkpathDest')
    .mockImplementation((path, from) =>
      path === 'Details' && from === 'Folder/Research.md'
        ? h.app.vault.getFileByPath('Folder/Details.md')
        : null,
    );
  const open = vi.spyOn(h.app.workspace, 'openLinkText').mockResolvedValue();
  const anchors = note.querySelectorAll<HTMLAnchorElement>('a');
  expect(anchors).toHaveLength(2);
  anchors[0]?.click();
  await flushMicrotasks(0);
  expect(resolve).toHaveBeenCalledWith('Details', 'Folder/Research.md');
  expect(open).toHaveBeenCalledWith('Details#Section', 'Folder/Research.md', false);
  anchors[1]?.click();
  await flushMicrotasks(0);
  expect(open).toHaveBeenCalledTimes(1);
  expect(surface.element.querySelector('.abyss-command-phase')?.textContent).toContain(
    'does not exist',
  );
  expect(h.owner.snapshot().proposal.changes).toEqual([]);
});
it('keeps native task DOM while a background research note proposal updates', async () => {
  const h = await setup();
  const surface = h.mount();
  enter(surface, 'Draft task');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('ready');
  });
  const title = expectDefined(surface.element.querySelector('.abyss-task-title'));
  const child = expectDefined(surface.element.querySelectorAll('.abyss-subtask-label')[1]);
  const note = await expectDefined(h.api.notes).prepare({
    kind: 'create',
    path: 'Research.md',
    title: 'Research',
    text: 'Sourced findings',
  });
  if (!note.ok) throw new Error(note.error.code);
  h.session.stage({ kind: 'note', plan: note.value });
  await flushMicrotasks(0);
  expect(surface.element.querySelector('.abyss-command-note')?.textContent).toContain(
    'Sourced findings',
  );
  expect(surface.element.querySelector('.abyss-task-title')).toBe(title);
  expect(surface.element.querySelectorAll('.abyss-subtask-label')[1]).toBe(child);
  expect(h.app.vault.getFileByPath('Research.md')).toBeNull();
  const disclosure = expectDefined(
    surface.element.querySelector<HTMLDetailsElement>('.abyss-command-note'),
  );
  expect(disclosure.tagName).toBe('DETAILS');
  expect(disclosure.open).toBe(false);
  expect(disclosure.querySelector('summary ins')?.textContent).toBe('Research');
  expect(disclosure.dataset['change']).toBe('added');
  expectDefined(disclosure.querySelector('summary')).click();
  expect(disclosure.open).toBe(true);
  expect(disclosure.textContent).toContain('Sourced findings');
  const refined = await expectDefined(h.api.notes).prepare({
    kind: 'refine',
    plan: note.value.target,
    expectedPlanRevision: note.value.revision,
    operation: { type: 'replace-body', text: 'Updated sourced findings' },
  });
  if (!refined.ok) throw new Error(refined.error.code);
  h.session.stage({ kind: 'note', plan: refined.value });
  await flushMicrotasks(0);
  expect(surface.element.querySelector('.abyss-command-note')).toBe(disclosure);
  expect(disclosure.open).toBe(true);
  expect(disclosure.textContent).toContain('Updated sourced findings');
  expect(surface.element.querySelector('.abyss-task-title')).toBe(title);
});
it('collapses an initially note-only proposal when its related task arrives later', async () => {
  mockReadingView();
  const h = await setup({ 'Tasks.md': '- [ ] Existing\n' });
  const prepared = await expectDefined(h.api.notes).prepare({
    kind: 'create',
    path: 'Details.md',
    title: 'Details',
    text: 'Full details',
  });
  if (!prepared.ok) throw new Error(prepared.error.code);
  h.session.stage({ kind: 'note', plan: prepared.value });
  const surface = h.mount();
  await flushMicrotasks(0);
  const row = expectDefined(
    surface.element.querySelector<HTMLDetailsElement>('.abyss-command-note'),
  );
  expect(row.open).toBe(true);
  const listed = await h.api.tasks.list();
  if (!listed.ok) throw new Error(listed.error.code);
  const root = expectDefined(listed.value.items[0]);
  const task = await expectDefined(h.api.tasks.prepare)({
    kind: 'edit',
    target: root.target,
    expectedRevision: root.revision,
    operation: { type: 'add-comment', target: root.target, text: 'Conclusion [[Details]]' },
  });
  if (!task.ok) throw new Error(task.error.code);
  h.session.stage({ kind: 'task', plan: task.value });
  await flushMicrotasks(0);
  expect(surface.element.querySelector('.abyss-command-note')).toBe(row);
  expect(row.open).toBe(false);
  expect(row.textContent).toContain('Full details');
});

it('retains exact receipt-section continuation after finish and remount without claiming a full note', async () => {
  mockReadingView();
  const h = await setup({ 'Long.md': 'Original prose\n\n- [ ] Keep\n' });
  const notes = expectDefined(h.api.notes);
  const read = await notes.read({ selector: { path: 'Long.md' } });
  if (!read.ok) throw new Error(read.error.code);
  const section = expectDefined(read.value.segments.find((part) => part.section.canReplace));
  h.setRun(async () => {
    const plan = await notes.prepare({
      kind: 'edit',
      target: read.value.note.target,
      expectedRevision: read.value.note.revision,
      operation: {
        type: 'replace-section',
        section: section.section.target,
        text: `New beginning\n${'Review detail. '.repeat(900)}\nFinal addition.\n\n`,
      },
    });
    if (!plan.ok) throw new Error(plan.error.code);
    h.session.stage({ kind: 'note', plan: plan.value });
  });
  let surface = h.mount();
  enter(surface, 'Expand this section');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('ready');
  });
  expect(surface.element.querySelector('.abyss-command-note')?.textContent).toContain(
    'Final addition.',
  );
  h.confirmInSession(surface);
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('saved');
  });
  const first = expectDefined(h.owner.snapshot().entities.notes[0]);
  expect(first.selection).toBe('section');
  expect(first.complete).toBe(false);
  const request = expectDefined(first.request);
  expect(request.selector).toHaveProperty('section');
  expect(surface.element.querySelector('.abyss-command-note')?.textContent).toContain(
    'New beginning',
  );
  expect(surface.element.querySelector('.abyss-command-note')?.textContent).toContain(
    'More content remains',
  );
  await h.owner.flush();
  surface.destroy();
  surface = h.mount();
  await flushMicrotasks(0);
  expect(h.owner.snapshot().entities.notes[0]?.request).toEqual(request);
  h.setRun(async () => {
    const continued = await notes.read({ ...request, cursor: expectDefined(first.nextCursor) });
    if (!continued.ok) throw new Error(continued.error.code);
    h.session.observeNote({ ...continued.value, request, continued: true });
  });
  enter(surface, 'Continue this section');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('ready');
  });
  await flushMicrotasks(0);
  const current = expectDefined(surface.element.querySelector('.abyss-command-note'));
  expect(current.textContent).toContain('Final addition.');
  expect(current.textContent).toContain('Continuation · End of selection.');
  expect(current.textContent).not.toContain('Full note');
  expect(await h.read('Long.md')).toContain('- [ ] Keep');
});

function mockNativeBlocks(): void {
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(renderNativeBlocks);
}
const renderNativeBlocks: typeof MarkdownRenderer.render = async (_app, text, holder) => {
  for (const block of text.trim().split(/\n\n+/u)) {
    if (block.startsWith('# ') || block.startsWith('## ')) {
      const [heading = '', ...rest] = block.split('\n');
      const level = heading.startsWith('## ') ? 'h2' : 'h1';
      holder.createEl(level, { text: heading.slice(level === 'h2' ? 3 : 2) });
      if (rest.length > 0) holder.createEl('p', { text: rest.join('\n') });
    } else if (block.startsWith('- [ ] '))
      holder.createEl('ul').createEl('li').createEl('input', { type: 'checkbox' });
    else holder.createEl('p', { text: block });
  }
};
it.each(['pending', 'failed'] as const)(
  'blocks Enter and semantic confirmation while the matching note preview is %s',
  async (fault) => {
    mockNativeBlocks();
    const original = '# Original\n\nKeep this.\n';
    const h = await setup({ 'Note.md': original });
    const notes = expectDefined(h.api.notes);
    const page = await notes.read({ selector: { path: 'Note.md' } });
    if (!page.ok) throw new Error(page.error.code);
    const plan = await notes.prepare({
      kind: 'edit',
      target: page.value.note.target,
      expectedRevision: page.value.note.revision,
      operation: {
        type: 'append',
        section: expectDefined(page.value.segments.find((part) => part.section.canAppend)).section
          .target,
        text: 'More details.',
      },
    });
    if (!plan.ok) throw new Error(plan.error.code);
    h.session.stage({ kind: 'note', plan: plan.value });
    const waiting = deferred<void>();
    const render = renderNativeBlocks;
    const failed = vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (...args) => {
      if (fault === 'failed') throw new Error('Native rendering failed');
      await waiting.promise;
      return render(...args);
    });
    let surface = h.mount();
    await flushMicrotasks(0);
    expect(
      surface.element.querySelector<HTMLButtonElement>('[aria-label="Save proposal"]')?.disabled,
    ).toBe(true);
    enter(surface, '');
    await flushMicrotasks(0);
    expect(await h.read('Note.md')).toBe(original);
    expect(h.owner.snapshot().journal).toHaveLength(0);
    scriptedAgent(h, [
      {
        tool: 'interpret',
        input: { intent: 'confirm', approval: 'Yes, save these changes', research: false },
      },
    ]);
    enter(surface, 'Yes, save these changes');
    await vi.waitFor(() => {
      expect(h.owner.snapshot().status.kind).not.toBe('thinking');
    });
    expect(await h.read('Note.md')).toBe(original);
    expect(h.owner.snapshot().journal).toHaveLength(0);
    failed.mockRestore();
    mockNativeBlocks();
    waiting.resolve();
    if (fault === 'failed') {
      surface.destroy();
      surface = h.mount();
    }
    await vi.waitFor(() => {
      expect(surface.element.querySelector('.abyss-command-note-body')?.textContent).toContain(
        'More details.',
      );
    });
    h.confirmInSession(surface);
    await vi.waitFor(() => {
      expect(h.owner.snapshot().status.kind).toBe('saved');
    });
    expect(await h.read('Note.md')).toContain('More details.');
    expect(h.owner.snapshot().journal).toHaveLength(1);
  },
);

it.each(['pending', 'failed'] as const)(
  'keeps a %s replacement unconfirmable despite an older ready surface, and accepts further edits',
  async (fault) => {
    mockNativeBlocks();
    const h = await setup();
    const notes = expectDefined(h.api.notes);
    const prepared = await notes.prepare({
      kind: 'create',
      path: 'Review.md',
      title: 'Review',
      text: '# First draft',
    });
    if (!prepared.ok) throw new Error(prepared.error.code);
    h.session.stage({ kind: 'note', plan: prepared.value });
    const first = h.mount();
    await flushMicrotasks(0);
    expect(first.element.querySelector('.abyss-command-note-body')?.textContent).toContain(
      'First draft',
    );
    const waiting = deferred<void>();
    const current = deferred<void>();
    const render = renderNativeBlocks;
    const renderer = vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (...args) => {
      if (fault === 'failed' && !args[1].includes('Latest draft'))
        throw new Error('Native render failed');
      await (args[1].includes('Latest draft') ? current.promise : waiting.promise);
      return render(...args);
    });
    let second = h.mount();
    await flushMicrotasks(0);
    enter(second, '');
    await flushMicrotasks(0);
    expect(h.app.vault.getFileByPath('Review.md')).toBeNull();
    expect(h.owner.snapshot().journal).toHaveLength(0);
    scriptedAgent(h, [
      { tool: 'interpret', input: { intent: 'plan', research: false } },
      {
        tool: 'note',
        input: {
          input: {
            kind: 'refine',
            plan: prepared.value.target,
            expectedPlanRevision: prepared.value.revision,
            operation: { type: 'replace-body', text: '# Latest draft' },
          },
        },
      },
      { tool: 'finish', input: { state: 'ready', message: 'Revised.' } },
    ]);
    enter(second, 'Replace this with the latest draft');
    await vi.waitFor(() => {
      expect(h.owner.snapshot().status.message).toBe('Ready. Enter to save.');
    });
    expect(first.element.querySelector('.abyss-command-note-body')?.textContent).toContain(
      'First draft',
    );
    waiting.resolve(); // A stale render may finish, but it cannot authorize the replacement.
    await flushMicrotasks(0);
    enter(second, '');
    await flushMicrotasks(0);
    expect(h.app.vault.getFileByPath('Review.md')).toBeNull();
    expect(h.owner.snapshot().journal).toHaveLength(0);
    first.destroy();
    renderer.mockRestore();
    mockNativeBlocks();
    current.resolve();
    // A failed historical comparison is part of the review; reopening retries
    // that render after the host renderer has recovered.
    if (fault === 'failed') {
      second.destroy();
      second = h.mount();
    }
    await vi.waitFor(() => {
      expect(second.element.querySelector('.abyss-command-note-body')?.textContent).toContain(
        'Latest draft',
      );
    });
    h.confirmInSession(second);
    await vi.waitFor(() => {
      expect(h.owner.snapshot().status.kind).toBe('saved');
    });
    expect(await h.read('Review.md')).toContain('Latest draft');
    expect(await h.read('Review.md')).not.toContain('First draft');
  },
);

it('keeps receipt-bound note content current when a later task write fails, including remount', async () => {
  mockNativeBlocks();
  const h = await setup({}, (api) => ({
    ...api,
    tasks: {
      ...api.tasks,
      create: async () => {
        throw new Error('Task write unavailable');
      },
    },
  }));
  const note = await expectDefined(h.api.notes).prepare({
    kind: 'create',
    path: 'Review.md',
    title: 'Review',
    text: '# Current body',
  });
  if (!note.ok) throw new Error(note.error.code);
  h.session.stage({ kind: 'note', plan: note.value });
  const task = await expectDefined(h.api.tasks.prepare)({
    kind: 'create',
    destination: { type: 'note', path: 'a.md', insertion: { type: 'append' } },
    tree: { markdownTitle: 'Pending task' },
  });
  if (!task.ok) throw new Error(task.error.code);
  h.session.stage({ kind: 'task', plan: task.value });
  let surface = h.mount();
  await flushMicrotasks(0);
  enter(surface, '');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('error');
  });
  const check = () => {
    const card = expectDefined(surface.element.querySelector('.abyss-command-note'));
    expect(card.querySelector('.abyss-command-note-scope')?.textContent).toBe('Full note');
    expect(card.textContent).toContain('Current body');
    expect(card.querySelectorAll('[data-change="added"], ins, del')).toHaveLength(0);
  };
  check();
  await h.owner.flush();
  surface.destroy();
  surface = h.mount();
  await flushMicrotasks(0);
  check();
  expect(await h.read('Review.md')).toContain('Current body');
  expect(await h.read('a.md')).not.toContain('Pending task');
});

it('waits for every edited note range before enabling confirmation', async () => {
  mockNativeBlocks();
  const original = 'First section.\n\n- [ ] Protected\n\nSecond section.\n';
  const h = await setup({ 'Note.md': original });
  const notes = expectDefined(h.api.notes);
  const read = await notes.read({ selector: { path: 'Note.md' } });
  if (!read.ok) throw new Error(read.error.code);
  const sections = read.value.segments.filter((segment) => segment.section.canAppend);
  const prepared = await notes.prepare({
    kind: 'edit',
    target: read.value.note.target,
    expectedRevision: read.value.note.revision,
    operation: {
      type: 'append',
      section: expectDefined(sections[0]).section.target,
      text: 'First addition.',
    },
  });
  if (!prepared.ok) throw new Error(prepared.error.code);
  const refined = await notes.prepare({
    kind: 'refine',
    plan: prepared.value.target,
    expectedPlanRevision: prepared.value.revision,
    operation: {
      type: 'append',
      section: expectDefined(sections[1]).section.target,
      text: 'Second addition.',
    },
  });
  if (!refined.ok) throw new Error(refined.error.code);
  h.session.stage({ kind: 'note', plan: refined.value });
  const waiting = deferred<void>();
  vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (...args) => {
    if (args[1].includes('Second addition')) await waiting.promise;
    return renderNativeBlocks(...args);
  });
  const surface = h.mount();
  await flushMicrotasks(0);
  expect(surface.element.querySelector('.abyss-command-note-body')?.textContent).toContain(
    'First addition',
  );
  enter(surface, '');
  await flushMicrotasks(0);
  expect(await h.read('Note.md')).toBe(original);
  expect(h.owner.snapshot().journal).toHaveLength(0);
  waiting.resolve();
  await flushMicrotasks(0);
  h.confirmInSession(surface);
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('saved');
  });
  expect(await h.read('Note.md')).toContain('First addition.');
  expect(await h.read('Note.md')).toContain('Second addition.');
  expect(await h.read('Note.md')).toContain('- [ ] Protected');
  expect(h.owner.snapshot().journal).toHaveLength(1);
});

it('renders the earlier source again when refinement returns to it after a failed replacement', async () => {
  mockNativeBlocks();
  const h = await setup();
  const notes = expectDefined(h.api.notes);
  const created = await notes.prepare({
    kind: 'create',
    path: 'Review.md',
    title: 'Review',
    text: '# First draft',
  });
  if (!created.ok) throw new Error(created.error.code);
  h.session.stage({ kind: 'note', plan: created.value });
  const surface = h.mount();
  await flushMicrotasks(0);
  expect(surface.element.querySelector('.abyss-command-note-body')?.textContent).toContain(
    'First draft',
  );
  vi.spyOn(MarkdownRenderer, 'render').mockRejectedValue(new Error('Native rendering failed'));
  const changed = await notes.prepare({
    kind: 'refine',
    plan: created.value.target,
    expectedPlanRevision: created.value.revision,
    operation: { type: 'replace-body', text: '# Failed draft' },
  });
  if (!changed.ok) throw new Error(changed.error.code);
  h.session.stage({ kind: 'note', plan: changed.value });
  await flushMicrotasks(0);
  expect(surface.element.querySelector('.abyss-command-note-body')?.textContent).toBe(
    'Could not display note content.',
  );
  mockNativeBlocks();
  const restored = await notes.prepare({
    kind: 'refine',
    plan: changed.value.target,
    expectedPlanRevision: changed.value.revision,
    operation: { type: 'replace-body', text: '# First draft' },
  });
  if (!restored.ok) throw new Error(restored.error.code);
  h.session.stage({ kind: 'note', plan: restored.value });
  await flushMicrotasks(0);
  expect(surface.element.querySelector('.abyss-command-note-body')?.textContent).toContain(
    'First draft',
  );
  h.confirmInSession(surface);
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('saved');
  });
  expect(await h.read('Review.md')).toContain('First draft');
  expect(await h.read('Review.md')).not.toContain('Failed draft');
});

it.each(['failed', 'concurrent'] as const)(
  'does not present the retained full note as current after %s readback, including remount',
  async (fault) => {
    mockNativeBlocks();
    const original = '# Original\n\nKeep this.\n';
    let wrote = false;
    const h = await setup({ 'Note.md': original }, (api) => ({
      ...api,
      notes: {
        ...expectDefined(api.notes),
        read: async (input, options) => {
          if (wrote && fault === 'failed') throw new Error('Readback unavailable');
          return expectDefined(api.notes).read(input, options);
        },
      },
    }));
    const notes = expectDefined(h.api.notes);
    const page = await notes.read({ selector: { path: 'Note.md' } });
    if (!page.ok) throw new Error(page.error.code);
    await h.owner.focus({
      kind: 'note',
      target: page.value.note.target,
      revision: page.value.note.revision,
    });
    const plan = await notes.prepare({
      kind: 'edit',
      target: page.value.note.target,
      expectedRevision: page.value.note.revision,
      operation: {
        type: 'append',
        section: expectDefined(page.value.segments.find((part) => part.section.canAppend)).section
          .target,
        text: 'More details.',
      },
    });
    if (!plan.ok) throw new Error(plan.error.code);
    h.session.stage({ kind: 'note', plan: plan.value });
    const process = h.app.vault.process.bind(h.app.vault);
    vi.spyOn(h.app.vault, 'process').mockImplementationOnce(async (file, callback) => {
      const result = await process(file, callback);
      wrote = true;
      if (fault === 'concurrent') await h.app.vault.modify(file, 'Concurrent content\n');
      return result;
    });
    let surface = h.mount();
    await flushMicrotasks(0);
    enter(surface, '');
    await vi.waitFor(() => {
      expect(h.owner.snapshot().status.kind).toBe('error');
    });
    expect(h.owner.snapshot().journal[0]?.effects).toBe('committed');
    const check = () => {
      const card = expectDefined(surface.element.querySelector('.abyss-command-note'));
      expect(card.querySelector('.abyss-command-note-scope')?.textContent).toContain('unverified');
      expect(card.textContent).not.toContain('Full note');
      expect(card.textContent).toContain('More details.');
    };
    check();
    await h.owner.flush();
    surface.destroy();
    surface = h.mount();
    await flushMicrotasks(0);
    check();
    const completed = h.owner.snapshot();
    enter(surface, '');
    await flushMicrotasks(0);
    const retained = h.owner
      .recent()
      .find((record) => record.snapshot.id === completed.id)?.snapshot;
    expect(retained?.journal).toHaveLength(1);
    expect(await h.read('Note.md')).toBe(
      fault === 'concurrent' ? 'Concurrent content\n' : '# Original\n\nKeep this.\nMore details.',
    );
  },
);

it.each([false, true])(
  'shows a later complete current read once receipt readback failed=%s without duplicate cards',
  async (failReadback) => {
    mockNativeBlocks();
    let rejectReadback = failReadback;
    const h = await setup({ 'Note.md': '# Original\n\nKeep this.\n' }, (api) => ({
      ...api,
      notes: {
        ...expectDefined(api.notes),
        read: async (input, options) => {
          if (rejectReadback && 'section' in input.selector)
            throw new Error('Readback unavailable');
          return expectDefined(api.notes).read(input, options);
        },
      },
    }));
    const notes = expectDefined(h.api.notes);
    const read = await notes.read({ selector: { path: 'Note.md' } });
    if (!read.ok) throw new Error(read.error.code);
    h.session.observeNote(read.value);
    const prepared = await notes.prepare({
      kind: 'edit',
      target: read.value.note.target,
      expectedRevision: read.value.note.revision,
      operation: {
        type: 'append',
        section: expectDefined(read.value.segments.find((segment) => segment.section.canAppend))
          .section.target,
        text: 'Added detail.',
      },
    });
    if (!prepared.ok) throw new Error(prepared.error.code);
    h.session.stage({ kind: 'note', plan: prepared.value });
    let surface = h.mount();
    await flushMicrotasks(0);
    h.confirmInSession(surface);
    await vi.waitFor(() => {
      expect(h.owner.snapshot().status.kind).toBe(failReadback ? 'error' : 'saved');
    });
    rejectReadback = false;
    scriptedAgent(h, [
      { tool: 'interpret', input: { intent: 'plan', research: false } },
      { tool: 'read', input: { input: { kind: 'note', selector: { path: 'Note.md' } } } },
      { tool: 'finish', input: { state: 'ready', message: 'Read current note.' } },
    ]);
    enter(surface, 'Read the full current note');
    await vi.waitFor(() => {
      expect(h.owner.snapshot().input).toBe('');
      expect(h.owner.snapshot().status.kind, h.owner.snapshot().status.message).toBe('ready');
    });
    const check = () => {
      expect(surface.element.querySelectorAll('.abyss-command-note')).toHaveLength(1);
      expect(surface.element.querySelector('.abyss-command-note-scope')?.textContent).toBe(
        'Full note',
      );
      expect(surface.element.querySelector('.abyss-command-note-body')?.textContent).toContain(
        'Added detail.',
      );
    };
    check();
    surface.destroy();
    surface = h.mount();
    await flushMicrotasks(0);
    check();
    const completedSession = h.owner.snapshot().id;
    enter(surface, '');
    await flushMicrotasks(0);
    expect(
      h.owner.recent().find((record) => record.snapshot.id === completedSession)?.snapshot.journal,
    ).toHaveLength(1);
  },
);

it('shows a note display error when the prior Markdown comparison fails', async () => {
  mockNativeBlocks();
  const original = '# Original\n\nKeep this.\n';
  const h = await setup({ 'Note.md': original });
  const notes = expectDefined(h.api.notes);
  const page = await notes.read({ selector: { path: 'Note.md' } });
  if (!page.ok) throw new Error(page.error.code);
  const plan = await notes.prepare({
    kind: 'edit',
    target: page.value.note.target,
    expectedRevision: page.value.note.revision,
    operation: {
      type: 'append',
      section: expectDefined(page.value.segments.find((part) => part.section.canAppend)).section
        .target,
      text: 'More details.',
    },
  });
  if (!plan.ok) throw new Error(plan.error.code);
  h.session.stage({ kind: 'note', plan: plan.value });
  vi.spyOn(MarkdownRenderer, 'render').mockRejectedValueOnce(new Error('Native comparison failed'));
  const surface = h.mount();
  await flushMicrotasks(0);
  expect(surface.element.querySelector('.abyss-command-note-body')?.textContent).toBe(
    'Could not display note content.',
  );
  expect(h.owner.snapshot().proposal.changes).toHaveLength(1);
  expect(await h.read('Note.md')).toBe(original);
});
it.each(['description', 'comment'] as const)(
  'compares native task %s blocks without marking the unchanged heading',
  async (kind) => {
    mockNativeBlocks();
    const original = '- [ ] Existing\n\t- > # Description\n\t- 2026-08-01: # Comment\n';
    const h = await setup({ 'a.md': original });
    const listed = await h.api.tasks.list({});
    if (!listed.ok) throw new Error(listed.error.code);
    const target = expectDefined(listed.value.items.find((task) => task.title === 'Existing'));
    const prepared = await expectDefined(h.api.tasks.prepare)({
      kind: 'edit',
      target: target.target,
      expectedRevision: target.revision,
    });
    if (!prepared.ok) throw new Error(prepared.error.code);
    const options = {
      now: () => Date.UTC(2026, 7, 1, 12),
      deadline: Date.UTC(2026, 7, 1, 12) + 5000,
    };
    const plan = await canonicalCommandPlan(
      h.api,
      prepared.value,
      new AbortController().signal,
      options,
    );
    h.session.stage({ kind: 'task', plan });
    const surface = h.mount();
    await flushMicrotasks(0);
    const node = expectDefined(plan.after);
    const operation: TaskContentOperationV1 =
      kind === 'description'
        ? { type: 'description', target: node.target, text: '# Description\n\nAdded detail.' }
        : {
            type: 'update-comment',
            target: expectDefined(node.comments[0]).target,
            text: '# Comment\nAdded detail.',
          };
    const request = {
      kind: 'append' as const,
      plan: plan.target,
      expectedPlanRevision: plan.revision,
      operation,
    };
    const changed = await expectDefined(h.api.tasks.prepare)(request);
    if (!changed.ok) throw new Error(changed.error.code);
    h.session.prepared({ kind: 'task', input: prepareSchema.parse(request) });
    h.session.stage({
      kind: 'task',
      plan: await canonicalCommandPlan(h.api, changed.value, new AbortController().signal, options),
    });
    await flushMicrotasks(0);
    const field = expectDefined(
      surface.element.querySelector(
        kind === 'description' ? '.abyss-task-desc' : '.abyss-comment-row',
      ),
    );
    expect(field.querySelector('h1')?.textContent).toBe(
      kind === 'description' ? 'Description' : 'Comment',
    );
    expect(field.querySelector('h1 ins')).toBeNull();
    expect(field.querySelector('h1 del')).toBeNull();
    expect(field.querySelector('del')).toBeNull();
    expect(field.querySelector('ins')?.textContent).toContain('Added detail.');
    expect(await h.read('a.md')).toBe(original);
  },
);
it('compares native note blocks without raw heading deletion and keeps rendered task inputs readonly', async () => {
  mockNativeBlocks();
  const original =
    '# Contact\n\n## Clinic\n\nPhone 7719.\n\n## Personal\n\nKeep personal.\n\n- [ ] Protected\n';
  const h = await setup({ 'Contact.md': original });
  const notes = expectDefined(h.api.notes);
  const page = await notes.read({ selector: { path: 'Contact.md' } });
  if (!page.ok) throw new Error(page.error.code);
  await h.session.focus([
    { kind: 'note', target: page.value.note.target, revision: page.value.note.revision },
  ]);
  let surface = h.mount();
  await flushMicrotasks(0);
  const checkbox = expectDefined(
    surface.element.querySelector<HTMLInputElement>('.abyss-command-note input[type=checkbox]'),
  );
  expect(checkbox.disabled).toBe(true);
  checkbox.click();
  expect(checkbox.checked).toBe(false);
  expect(await h.read('Contact.md')).toBe(original);
  const section = expectDefined(page.value.segments.find((part) => part.section.canReplace));
  h.setRun(async () => {
    const appended = await notes.prepare({
      kind: 'edit',
      target: page.value.note.target,
      expectedRevision: page.value.note.revision,
      operation: {
        type: 'append',
        section: section.section.target,
        text: 'Wrong duplicated content',
      },
    });
    if (!appended.ok) throw new Error(appended.error.code);
    h.session.stage({ kind: 'note', plan: appended.value });
    const corrected = await notes.prepare({
      kind: 'refine',
      plan: appended.value.target,
      expectedPlanRevision: appended.value.revision,
      operation: {
        type: 'replace-section',
        section: section.section.target,
        text: section.text.replace('Phone 7719.', 'Phone 7719.\n\nVisits on Tuesday.'),
      },
    });
    if (!corrected.ok) throw new Error(corrected.error.code);
    h.session.stage({ kind: 'note', plan: corrected.value });
  });
  enter(surface, 'Add Tuesday hours');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('ready');
  });
  await flushMicrotasks(0);
  expect(h.owner.snapshot().proposal.changes).toHaveLength(1);
  expect(surface.element.querySelectorAll('.abyss-command-note')).toHaveLength(1);
  expect(surface.element.querySelector('.abyss-command-note h1 ins')).toBeNull();
  expect(surface.element.querySelector('.abyss-command-note h1 del')).toBeNull();
  expect(surface.element.querySelector('.abyss-command-note del')).toBeNull();
  expect(
    [...surface.element.querySelectorAll('.abyss-command-note ins')]
      .map((node) => node.textContent)
      .join(''),
  ).toContain('Visits on Tuesday.');
  surface.destroy();
  surface = h.mount();
  await flushMicrotasks(0);
  expect(surface.element.querySelector('.abyss-command-note h1 ins')).toBeNull();
  h.confirmInSession(surface);
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('saved');
  });
  expect(await h.read('Contact.md')).toBe(
    original.replace('Phone 7719.', 'Phone 7719.\n\nVisits on Tuesday.'),
  );
});

it('keeps note session marks while comparing only the latest refinement across remount', async () => {
  mockNativeBlocks();
  const h = await setup();
  const notes = expectDefined(h.api.notes);
  h.setRun(async ({ text }) => {
    if (text === 'Wait') return;
    const previous = h.session.snapshot().proposal.changes.find((change) => change.kind === 'note');
    const prepared = await notes.prepare(
      previous === undefined
        ? {
            kind: 'create',
            path: 'Research.md',
            title: 'Research',
            text: '# Research\n\nCheck dark theme.',
          }
        : {
            kind: 'refine',
            plan: previous.plan.target,
            expectedPlanRevision: previous.plan.revision,
            operation: { type: 'replace-body', text: '# Research\n\nCheck light theme.' },
          },
    );
    if (!prepared.ok) throw new Error(prepared.error.code);
    h.session.stage({ kind: 'note', plan: prepared.value });
  });
  let surface = h.mount();
  const command = async (text: string) => {
    enter(surface, text);
    await vi.waitFor(() => {
      expect(h.owner.snapshot().input).toBe('');
      expect(h.owner.snapshot().status.kind, h.owner.snapshot().status.message).toBe('ready');
    });
    await flushMicrotasks(0);
  };
  await command('Create');
  expect(surface.element.querySelector('summary ins')?.textContent).toBe('Research');
  await command('Light');
  expect(surface.element.querySelector('summary ins')).toBeNull();
  expect(surface.element.querySelector('.abyss-command-note-body del')?.textContent).toBe('dark');
  expect(surface.element.querySelector('.abyss-command-note-body ins')?.textContent).toBe('light');
  surface.destroy();
  surface = h.mount();
  await flushMicrotasks(0);
  expect(surface.element.querySelector('.abyss-command-note-body ins')?.textContent).toBe('light');
  await command('Wait');
  expect(
    surface.element.querySelector('.abyss-command-note ins, .abyss-command-note del'),
  ).toBeNull();
  expect(
    surface.element.querySelector('.abyss-command-note')?.getAttribute('data-session-changed'),
  ).toBe('true');
});

it('reviews independent note ranges as fields in one card and commits them together', async () => {
  mockReadingView();
  const original = 'First prose\n\n- [ ] Keep task\n\nSecond prose\n';
  const h = await setup({ 'Note.md': original });
  const notes = expectDefined(h.api.notes);
  const read = await notes.read({ selector: { path: 'Note.md' } });
  if (!read.ok) throw new Error(read.error.code);
  const first = expectDefined(
    read.value.segments.find((part) => part.text.includes('First prose')),
  );
  const second = expectDefined(
    read.value.segments.find((part) => part.text.includes('Second prose')),
  );
  h.setRun(async () => {
    const plan = await notes.prepare({
      kind: 'edit',
      target: read.value.note.target,
      expectedRevision: read.value.note.revision,
      operation: {
        type: 'replace-section',
        section: first.section.target,
        text: first.text.replace('First', 'Changed first'),
      },
    });
    if (!plan.ok) throw new Error(plan.error.code);
    h.session.stage({ kind: 'note', plan: plan.value });
    const next = await notes.prepare({
      kind: 'refine',
      plan: plan.value.target,
      expectedPlanRevision: plan.value.revision,
      operation: {
        type: 'replace-section',
        section: second.section.target,
        text: second.text.replace('Second', 'Changed second'),
      },
    });
    if (!next.ok) throw new Error(next.error.code);
    h.session.stage({ kind: 'note', plan: next.value });
  });
  let surface = h.mount();
  enter(surface, 'Revise both prose sections');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('ready');
  });
  await flushMicrotasks(0);
  expect(surface.element.querySelectorAll('.abyss-command-note')).toHaveLength(1);
  expect(surface.element.querySelectorAll('.abyss-command-note-body')).toHaveLength(2);
  expect(surface.element.querySelector('.abyss-command-note')?.textContent).toContain(
    'Changed first',
  );
  expect(surface.element.querySelector('.abyss-command-note')?.textContent).toContain(
    'Changed second',
  );
  expect(await h.read('Note.md')).toBe(original);
  surface.destroy();
  surface = h.mount();
  await flushMicrotasks(0);
  expect(surface.element.querySelectorAll('.abyss-command-note-body')).toHaveLength(2);
  const write = vi.spyOn(h.app.vault, 'process');
  h.confirmInSession(surface);
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('saved');
  });
  expect(write).toHaveBeenCalledTimes(1);
  expect(await h.read('Note.md')).toBe(
    original.replace('First', 'Changed first').replace('Second', 'Changed second'),
  );
});

it.each(['microphone'])(
  'manual voice finished with %s stays editable until the user sends it',
  async (action) => {
    const h = await setup();
    const media = voiceMediaWithSampleClock();
    const transcribe = vi.fn(async () => 'Recognized command');
    const surface = h.mount({ available: () => {}, transcribe });
    const microphone = expectDefined(
      surface.element.querySelector<HTMLButtonElement>('[aria-label="Microphone"]'),
    );
    microphone.click();
    await flushMicrotasks(0);
    expect(media.getUserMedia).toHaveBeenCalledOnce();
    await sampleUtterance(media);
    expect(transcribe).not.toHaveBeenCalled();
    if (action === 'microphone') microphone.click();
    else if (action === 'send')
      expectDefined(
        surface.element.querySelector<HTMLButtonElement>('[aria-label="Send"]'),
      ).click();
    else
      surface.input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    await vi.waitFor(() => {
      expect(surface.input.value).toBe('Recognized command');
    });
    expect(h.owner.snapshot().proposal.changes).toHaveLength(0);
    expect(h.owner.snapshot().exchanges).toHaveLength(0);
    enter(surface, 'Recognized command, edited');
    await vi.waitFor(() => {
      expect(h.owner.snapshot().proposal.changes).toHaveLength(1);
    });
    expect(
      h.owner
        .snapshot()
        .exchanges.filter((e) => e.role === 'user')
        .map((e) => e.text),
    ).toEqual(['Recognized command, edited']);
    expect(surface.element.querySelector('.abyss-command-latest')?.textContent).toBe(
      'Recognized command, edited',
    );
    expect(media.tracks[0]?.stop).toHaveBeenCalledOnce();
    expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  },
);

function voiceMediaWithSampleClock() {
  // Advance the analyser's interval and cue clock while the Q and storage callbacks run normally.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  return voiceMediaHarness(window);
}
async function sampleUtterance(media: ReturnType<typeof voiceMediaHarness>) {
  await vi.advanceTimersByTimeAsync(300);
  media.level(0.1);
  await vi.advanceTimersByTimeAsync(200);
  media.level(0);
}
async function spoken(surface: CaptureSurface, media: ReturnType<typeof voiceMediaHarness>) {
  expectDefined(
    surface.element.querySelector<HTMLButtonElement>('[aria-label="Microphone"]'),
  ).click();
  await finishSpoken(surface, media);
}
async function spokenCommand(
  h: Awaited<ReturnType<typeof setup>>,
  surface: CaptureSurface,
  media: ReturnType<typeof voiceMediaHarness>,
) {
  h.session.setVoiceMode('continuous');
  const microphone = expectDefined(
    surface.element.querySelector<HTMLButtonElement>('[aria-label="Microphone"]'),
  );
  if (microphone.getAttribute('aria-pressed') !== 'true') microphone.click();
  await flushMicrotasks(0);
  const track = expectDefined(media.tracks[media.tracks.length - 1]);
  await sampleUtterance(media);
  await vi.advanceTimersByTimeAsync(3500);
  expect(track.readyState).toBe('ended');
  await flushMicrotasks(0);
}
async function finishSpoken(surface: CaptureSurface, media: ReturnType<typeof voiceMediaHarness>) {
  await flushMicrotasks(0);
  await sampleUtterance(media);
  voiceButton(surface).click();
  await flushMicrotasks(0);
}
it('empty final speech never confirms the retained reviewed proposal', async () => {
  const h = await setup();
  const media = voiceMediaWithSampleClock();
  const surface = h.mount({ available: () => {}, transcribe: async () => '   ' });
  enter(surface, 'Create parent');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().proposal.changes).toHaveLength(1);
  });
  const proposal = h.owner.snapshot().proposal;
  await spoken(surface, media);
  expect(h.owner.snapshot().proposal).toEqual(proposal);
  expect(h.owner.snapshot().exchanges.filter((e) => e.role === 'user')).toHaveLength(1);
  expect(surface.element.querySelector('.abyss-command-phase')?.textContent).toMatch(/speech/i);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
});
it.each(['hide', 'session', 'unload', 'pagehide'])(
  'retires %s media and held final results without submitting on Q resume',
  async (action) => {
    const h = await setup();
    const media = voiceMediaWithSampleClock();
    const result = deferred<string>();
    const surface = h.mount({ available: () => {}, transcribe: () => result.promise });
    await spoken(surface, media);
    if (action === 'hide')
      surface.input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    else if (action === 'session') await h.owner.newSession();
    else if (action === 'unload') h.owner.dispose();
    else window.dispatchEvent(new Event('pagehide'));
    result.resolve('Late confirmation');
    await flushMicrotasks(0);
    expect(h.owner.snapshot().exchanges).toEqual([]);
    expect(await h.read('a.md')).toBe('- [ ] Existing\n');
    expect(media.tracks[0]?.stop).toHaveBeenCalledOnce();
    if (action === 'hide') {
      h.mount({ available: () => {}, transcribe: async () => '' });
      expect(media.getUserMedia).toHaveBeenCalledOnce();
    }
  },
);
it('retains both exact typed input and late voice text without submitting the combined composer', async () => {
  const h = await setup();
  const media = voiceMediaWithSampleClock();
  const result = deferred<string>();
  const surface = h.mount({ available: () => {}, transcribe: () => result.promise });
  await spokenCommand(h, surface, media);
  surface.input.value = '  My unsent text  ';
  surface.input.dispatchEvent(new Event('input', { bubbles: true }));
  result.resolve('Spoken command');
  await flushMicrotasks(0);
  expect(surface.input.value).toBe('  My unsent text  \n\nSpoken command');
  expect(h.owner.snapshot().exchanges).toEqual([]);
  expect(surface.element.querySelector('.abyss-command-phase')?.textContent).toMatch(
    /review before sending/i,
  );
});
it("retains another surface's exact draft when held voice recognition finishes", async () => {
  const h = await setup();
  const media = voiceMediaWithSampleClock();
  const result = deferred<string>();
  const origin = h.mount({ available: () => {}, transcribe: () => result.promise });
  const frame = document.body.createEl('iframe');
  const otherDocument = expectDefined(frame.contentDocument);
  const otherHost = document.body.createDiv();
  otherDocument.body.append(otherHost);
  const other = h.mount(undefined, undefined, undefined, otherHost);
  await flushMicrotasks(0);
  expect(origin.element.isConnected).toBe(true);
  expect(other.element.isConnected).toBe(true);
  await spokenCommand(h, origin, media);
  other.input.value = '  Unsent text from the other Q  ';
  other.input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(h.closeCount()).toBe(0);
  expect(origin.input.getAttribute('aria-label')).toBe('Command');
  result.resolve('Spoken command');
  await flushMicrotasks(0);
  expect(origin.input.value).toBe('  Unsent text from the other Q  \n\nSpoken command');
  expect(other.input.value).toBe(origin.input.value);
  expect(h.owner.snapshot().exchanges).toEqual([]);
  expect(h.owner.snapshot().journal).toEqual([]);
  expect(origin.element.querySelector('.abyss-command-phase')?.textContent).toMatch(
    /review before sending/i,
  );
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
});
it('an identical-byte edit in another surface invalidates pending voice and protects late clearing', async () => {
  const h = await setup();
  const media = voiceMediaWithSampleClock();
  const result = deferred<string>(),
    finish = deferred<void>();
  h.setRun(async () => finish.promise);
  const origin = h.mount({ available: () => {}, transcribe: () => result.promise });
  const other = h.mount();
  await spokenCommand(h, origin, media);
  enter(origin, 'Same command');
  expect(other.input.value).toBe('');
  h.owner.setInput('Same command');
  expect(other.input.value).toBe('Same command');
  other.input.dispatchEvent(new Event('input', { bubbles: true }));
  finish.resolve();
  await flushMicrotasks(0);
  expect(other.input.value).toBe('Same command');
  result.resolve('Spoken refinement');
  await flushMicrotasks(0);
  expect(origin.input.value).toBe('Same command\n\nSpoken refinement');
  expect(h.owner.snapshot().exchanges.filter((entry) => entry.role === 'user')).toEqual([
    { role: 'user', text: 'Same command' },
  ]);
  expect(h.owner.snapshot().journal).toEqual([]);
});
it('voice preserves retained nonempty input selected from history in an already mounted surface', async () => {
  const h = await setup();
  const media = voiceMediaWithSampleClock();
  const surface = h.mount({ available: () => {}, transcribe: async () => 'Spoken command' });
  const original = h.owner.snapshot().id;
  surface.input.value = '  Retained draft  ';
  surface.input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(await h.owner.newSession()).toBe(true);
  h.setRun(async () => {});
  enter(surface, 'Accepted command');
  await flushMicrotasks(0);
  expect(surface.input.value).toBe('');
  expect(await h.owner.select(original)).toBe(true);
  expect(surface.input.value).toBe('  Retained draft  ');
  await spokenCommand(h, surface, media);
  expect(surface.input.value).toBe('  Retained draft  \n\nSpoken command');
  expect(h.owner.snapshot().exchanges).toEqual([]);
  expect(h.owner.snapshot().journal).toEqual([]);
});
it("voice in a new empty session submits normally after another session's unsent draft", async () => {
  const h = await setup();
  const media = voiceMediaWithSampleClock();
  const surface = h.mount({ available: () => {}, transcribe: async () => 'Create parent' });
  surface.input.value = 'Prior unsent draft';
  surface.input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(await h.owner.newSession()).toBe(true);
  expect(surface.input.value).toBe('');
  expect(media.getUserMedia).not.toHaveBeenCalled();
  await spokenCommand(h, surface, media);
  await vi.waitFor(() => {
    expect(h.owner.snapshot().exchanges.filter((entry) => entry.role === 'user')).toEqual([
      { role: 'user', text: 'Create parent' },
    ]);
  });
  expect(h.owner.snapshot().proposal.changes).toHaveLength(1);
  expect(h.owner.snapshot().journal).toEqual([]);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
});
it('preserves a changed focus and proposal when a final acknowledgement was captured for another subject', async () => {
  const h = await setup();
  const media = voiceMediaWithSampleClock();
  const result = deferred<string>();
  const surface = h.mount({ available: () => {}, transcribe: () => result.promise });
  enter(surface, 'Create parent');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().proposal.changes).toHaveLength(1);
  });
  const change = h.owner.snapshot().proposal.changes[0];
  if (change?.kind !== 'task' || change.plan.after === null) throw new Error('Missing task');
  const child = expectDefined(change.plan.after.children[1]);
  await spokenCommand(h, surface, media);
  await h.owner.focus({
    kind: 'task',
    target: child.target,
    plan: change.plan.target,
    expectedPlanRevision: change.plan.revision,
  });
  const state = h.owner.snapshot();
  result.resolve('Yes, save it');
  await flushMicrotasks(0);
  expect(h.owner.snapshot().proposal).toEqual(state.proposal);
  expect(h.owner.snapshot().focus).toEqual(state.focus);
  expect(surface.input.value).toContain('Yes, save it');
  expect(h.owner.snapshot().exchanges.filter((e) => e.role === 'user')).toHaveLength(1);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
});
it('waits with all tracks stopped through ASR, research and a published result until the whole turn settles', async () => {
  const h = await setup(),
    media = voiceMediaHarness(window);
  const recognition = deferred<string>(),
    research = deferred<void>(),
    finish = deferred<void>();
  h.setRun(async ({ text, signal }) => {
    h.session.status('searching', 'Reading sources');
    await research.promise;
    h.session.question(text);
    await finish.promise;
    expect(signal.aborted).toBe(false);
  });
  const transcribe = vi.fn(() => recognition.promise);
  h.owner.setVoiceMode('continuous');
  vi.useFakeTimers();
  const surface = h.mount({ available: () => {}, transcribe });
  await vi.advanceTimersByTimeAsync(300);
  media.level(0.1);
  await vi.advanceTimersByTimeAsync(200);
  media.level(0);
  await vi.advanceTimersByTimeAsync(3500);
  expect(transcribe).toHaveBeenCalledOnce();
  expect(media.tracks[0]?.readyState).toBe('ended');
  expect(voiceButton(surface).getAttribute('aria-description')).toMatch(/recognizing/i);
  expect(voiceButton(surface).getAttribute('aria-description')).not.toMatch(/listening/i);
  await vi.advanceTimersByTimeAsync(5000);
  expect(media.getUserMedia).toHaveBeenCalledOnce();
  recognition.resolve('First voice command');
  await vi.advanceTimersByTimeAsync(200);
  expect(h.owner.snapshot().status.kind).toBe('searching');
  expect(voiceButton(surface).getAttribute('aria-description')).toMatch(/paused/i);
  research.resolve();
  await vi.advanceTimersByTimeAsync(5000);
  expect(h.owner.snapshot().activeQuestion).toBe('First voice command');
  expect(media.getUserMedia).toHaveBeenCalledOnce();
  finish.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(media.getUserMedia).toHaveBeenCalledTimes(2);
  expect(media.tracks[1]?.readyState).toBe('live');
  expect(voiceButton(surface).getAttribute('aria-description')).toMatch(/listening/i);
  expect(h.owner.snapshot().exchanges.filter((entry) => entry.role === 'user')).toEqual([
    { role: 'user', text: 'First voice command' },
  ]);
});
it('voice failure leaves typed input and proposal available for the next deliberate attempt', async () => {
  const h = await setup();
  const media = voiceMediaWithSampleClock();
  const transcribe = vi.fn(async () => 'Retried voice');
  transcribe.mockRejectedValueOnce(new Error('private provider detail'));
  const surface = h.mount({ available: () => {}, transcribe });
  enter(surface, 'Create parent');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().proposal.changes).toHaveLength(1);
  });
  surface.input.value = 'Typed draft';
  surface.input.dispatchEvent(new Event('input', { bubbles: true }));
  const before = h.owner.snapshot().proposal;
  await spoken(surface, media);
  expect(surface.input.value).toBe('Typed draft');
  expect(h.owner.snapshot().proposal).toEqual(before);
  expect(surface.element.querySelector('.abyss-command-phase')?.textContent).not.toContain(
    'private',
  );
  await spoken(surface, media);
  expect(surface.input.value).toBe('Typed draft\n\nRetried voice');
  expect(transcribe).toHaveBeenCalledTimes(2);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
});
it.each(['ready', 'pending'])(
  'spoken note confirmation uses the initiating %s render token',
  async (readiness) => {
    mockNativeBlocks();
    const h = await setup();
    const media = voiceMediaWithSampleClock();
    const prepared = await expectDefined(h.api.notes).prepare({
      kind: 'create',
      path: 'Voice.md',
      title: 'Voice',
      text: '# Reviewed voice note',
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    h.session.stage({ kind: 'note', plan: prepared.value });
    const wait = deferred<void>();
    if (readiness === 'pending')
      vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (...args) => {
        await wait.promise;
        await renderNativeBlocks(...args);
      });
    const surface = h.mount({ available: () => {}, transcribe: async () => 'Yes, save it' });
    scriptedAgent(h, [
      {
        tool: 'interpret',
        input: { intent: 'confirm', approval: 'Yes, save it', research: false },
      },
    ]);
    await spokenCommand(h, surface, media);
    await vi.waitFor(() => {
      expect(h.owner.snapshot().exchanges.filter((e) => e.role === 'user')).toHaveLength(1);
    });
    if (readiness === 'ready') {
      await vi.waitFor(() => {
        expect(h.owner.snapshot().status.kind).toBe('saved');
      });
      expect(await h.read('Voice.md')).toContain('# Reviewed voice note');
    } else {
      expect(h.app.vault.getFileByPath('Voice.md')).toBeNull();
      expect(h.owner.snapshot().journal).toEqual([]);
      wait.resolve();
      await flushMicrotasks(0);
    }
  },
);
it('speech captured before a proposal revision change cannot confirm the newer proposal', async () => {
  const h = await setup();
  const media = voiceMediaWithSampleClock();
  const result = deferred<string>();
  const surface = h.mount({ available: () => {}, transcribe: () => result.promise });
  enter(surface, 'Create parent');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().proposal.changes).toHaveLength(1);
  });
  await spokenCommand(h, surface, media);
  const original = h.owner.snapshot().proposal.changes[0];
  if (original?.kind !== 'task') throw new Error('No plan');
  h.session.stage(original);
  scriptedAgent(h, [
    { tool: 'interpret', input: { intent: 'confirm', approval: 'Confirm it', research: false } },
  ]);
  result.resolve('Confirm it');
  await vi.waitFor(() => {
    const state = h.owner.snapshot();
    expect(state.activeQuestion ?? '', state.status.message).toMatch(/proposal changed/i);
  });
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  expect(h.owner.snapshot().journal).toEqual([]);
  expect(surface.element.querySelector('.abyss-command-latest')?.textContent).toBe('Confirm it');
});
it('voice acquisition waits for an admitted write and captures the verified focus without replay', async () => {
  const admitted = deferred<void>(),
    release = deferred<void>();
  let writes = 0;
  const h = await setup({}, (api) => ({
    ...api,
    tasks: {
      ...api.tasks,
      create: async (...args: Parameters<NonNullable<TasksApiV1['tasks']['create']>>) => {
        writes++;
        const result = await expectDefined(api.tasks.create)(...args);
        admitted.resolve();
        await release.promise;
        return result;
      },
    },
  }));
  const media = voiceMediaWithSampleClock();
  const surface = h.mount({ available: () => {}, transcribe: async () => 'Refine after saving' });
  enter(surface, 'Create parent');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().proposal.changes).toHaveLength(1);
  });
  const change = h.owner.snapshot().proposal.changes[0];
  if (change?.kind !== 'task' || change.plan.after === null) throw new Error('No plan');
  await h.owner.focus({
    kind: 'task',
    target: change.plan.after.target,
    plan: change.plan.target,
    expectedPlanRevision: change.plan.revision,
  });
  h.confirmInSession(surface);
  await admitted.promise;
  let interpreted: CommandSessionSnapshot | undefined;
  h.setRun(async ({ session }) => {
    interpreted = session;
  });
  h.session.setVoiceMode('continuous');
  await flushMicrotasks(0);
  expect(media.getUserMedia).not.toHaveBeenCalled();
  expect(interpreted).toBeUndefined();
  expect(writes).toBe(1);
  release.resolve();
  await vi.waitFor(() => {
    expect(media.tracks[0]?.readyState).toBe('live');
  });
  const savedRevision = h.owner.snapshot().proposal.revision;
  await spokenCommand(h, surface, media);
  await vi.waitFor(() => {
    expect(interpreted).toBeDefined();
  });
  expect(writes).toBe(1);
  expect(interpreted?.focus[0]?.target).toBe(h.owner.snapshot().actual[0]?.target);
  expect(interpreted?.submissionBasis?.proposalRevision).toBe(savedRevision);
  expect((await h.read('a.md')).match(/Parent/g)).toHaveLength(1);
});
it('voice acquisition waits for a dispatched apply before its source effect, then previews a new refinement', async () => {
  const admitted = deferred<void>(),
    release = deferred<void>();
  let calls = 0;
  const h = await setup({}, (api) => ({
    ...api,
    tasks: {
      ...api.tasks,
      apply: async (...args: Parameters<NonNullable<TasksApiV1['tasks']['apply']>>) => {
        calls++;
        if (calls === 1) {
          admitted.resolve();
          await release.promise;
        }
        return expectDefined(api.tasks.apply)(...args);
      },
    },
  }));
  const listed = await h.api.tasks.list();
  if (!listed.ok) throw new Error(listed.error.code);
  const root = expectDefined(listed.value.items[0]);
  await h.owner.focus({ kind: 'task', target: root.target, revision: root.revision });
  const prepared = await expectDefined(h.api.tasks.prepare)({
    kind: 'edit',
    target: root.target,
    expectedRevision: root.revision,
    operation: {
      type: 'patch',
      target: root.target,
      patch: { markdownTitle: { type: 'set', value: 'Saved first' } },
    },
  });
  if (!prepared.ok) throw new Error(prepared.error.code);
  h.session.stage({ kind: 'task', plan: prepared.value });
  const media = voiceMediaWithSampleClock();
  const surface = h.mount({ available: () => {}, transcribe: async () => 'Set twenty minutes' });
  let interpreted: CommandSessionSnapshot | undefined;
  h.setRun(async ({ session }) => {
    interpreted = session;
    const focus = expectDefined(session.focus[0]);
    if (focus.kind !== 'task') throw new Error('Missing task focus');
    const next = await expectDefined(h.api.tasks.prepare)({
      kind: 'edit',
      target: focus.target,
      expectedRevision: expectDefined(focus.revision),
      operation: {
        type: 'patch',
        target: focus.target,
        patch: { durationMinutes: { type: 'set', value: 20 } },
      },
    });
    if (!next.ok) throw new Error(next.error.code);
    h.session.stage({ kind: 'task', plan: next.value });
  });
  h.confirmInSession(surface);
  await admitted.promise;
  expect(h.owner.snapshot().journal[0]?.state).toBe('admitted');
  h.session.setVoiceMode('continuous');
  await flushMicrotasks(0);
  expect(media.getUserMedia).not.toHaveBeenCalled();
  expect(interpreted).toBeUndefined();
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  release.resolve();
  await vi.waitFor(() => {
    expect(media.tracks[0]?.readyState).toBe('live');
  });
  const savedRevision = h.owner.snapshot().proposal.revision;
  await spokenCommand(h, surface, media);
  await vi.waitFor(() => {
    expect(h.owner.snapshot().journal[0]?.effects).toBe('committed');
  });
  await vi.waitFor(() => {
    expect(currentTaskChange(h.owner.snapshot()).plan.after?.durationMinutes).toBe(20);
  });
  expect(calls).toBe(1);
  expect(interpreted?.focus[0]?.target).toBe(h.owner.snapshot().actual[0]?.target);
  expect(interpreted?.submissionBasis?.proposalRevision).toBe(savedRevision);
  expect(
    h.owner
      .snapshot()
      .exchanges.filter((entry) => entry.role === 'user')
      .map((entry) => entry.text),
  ).toEqual(['Save the current proposal', 'Set twenty minutes']);
  expect(await h.read('a.md')).toBe('- [ ] Saved first\n');
  h.confirmInSession(surface);
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('saved');
  });
  expect(calls).toBe(2);
  expect(h.owner.snapshot().journal.map((entry) => entry.effects)).toEqual([
    'committed',
    'committed',
  ]);
  expect(h.owner.snapshot().actual[0]?.durationMinutes).toBe(20);
  expect((await h.read('a.md')).match(/Saved first/g)).toHaveLength(1);
});
it('a second Enter during recorder finalization or pending ASR cannot confirm the old proposal', async () => {
  const h = await setup();
  const media = voiceMediaWithSampleClock();
  const result = deferred<string>();
  const surface = h.mount({ available: () => {}, transcribe: () => result.promise });
  enter(surface, 'Create parent');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().proposal.changes).toHaveLength(1);
  });
  expectDefined(
    surface.element.querySelector<HTMLButtonElement>('[aria-label="Microphone"]'),
  ).click();
  await flushMicrotasks(0);
  await sampleUtterance(media);
  const recorder = expectDefined(media.recorders[0]),
    finish = recorder.stop.bind(recorder);
  vi.spyOn(recorder, 'stop').mockImplementation(() => {});
  const press = () =>
    surface.input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  press();
  press();
  await flushMicrotasks(0);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  finish();
  press();
  await flushMicrotasks(0);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  result.resolve('');
  await flushMicrotasks(0);
  expect(h.owner.snapshot().journal).toEqual([]);
});

it('keeps ordinary Q lazy even when the production transcription capability is wired', async () => {
  const h = await setup();
  h.memory.active = false;
  const available = vi.fn(),
    transcribe = vi.fn(async () => '');
  h.mount({ available, transcribe });
  expect(h.resolveOwner).not.toHaveBeenCalled();
  expect(available).not.toHaveBeenCalled();
  expect(transcribe).not.toHaveBeenCalled();
});
it('ends the owned transcription deadline without clearing the typed composer or proposal', async () => {
  const h = await setup();
  const media = voiceMediaHarness(window);
  const surface = h.mount({
    available: () => {},
    transcribe: (_audio, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            reject(new DOMException('Cancelled', 'AbortError'));
          },
          { once: true },
        );
      }),
  });
  enter(surface, 'Create parent');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().proposal.changes).toHaveLength(1);
  });
  const proposal = h.owner.snapshot().proposal;
  vi.useFakeTimers();
  expectDefined(
    surface.element.querySelector<HTMLButtonElement>('[aria-label="Microphone"]'),
  ).click();
  await vi.advanceTimersByTimeAsync(0);
  media.level(0.1);
  await vi.advanceTimersByTimeAsync(470);
  media.level(0);
  surface.input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  surface.input.value = 'Retain exact text';
  surface.input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(45000);
  expect(surface.input.value).toBe('Retain exact text');
  expect(h.owner.snapshot().proposal).toEqual(proposal);
  expect(surface.element.querySelector('.abyss-command-phase')?.textContent).toMatch(/too long/i);
  expect(h.owner.snapshot().journal).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
it('starts the selected continuous mode once on Q open and releases it before reopening', async () => {
  const h = await setup();
  const media = voiceMediaHarness(window);
  h.session.setVoiceMode('continuous');
  const surface = h.mount({ available: () => {}, transcribe: async () => '' });
  await flushMicrotasks(0);
  expect(media.getUserMedia).toHaveBeenCalledOnce();
  surface.destroy();
  expect(media.tracks[0]?.stop).toHaveBeenCalledOnce();
  const reopened = h.mount({ available: () => {}, transcribe: async () => '' });
  await flushMicrotasks(0);
  expect(media.getUserMedia).toHaveBeenCalledTimes(2);
  expect(h.owner.snapshot().voiceMode).toBe('continuous');
  expect(
    reopened.element.querySelector('[aria-label="Microphone"]')?.getAttribute('aria-description'),
  ).toMatch(/continuous/i);
});
it('transcribes in ordinary Q without an agent connection or switching capture mode', async () => {
  const h = await setup();
  h.memory.active = false;
  const media = voiceMediaWithSampleClock();
  const surface = h.mount(
    { available: () => {}, transcribe: async () => 'Ordinary dictation' },
    () => ({ agent: false, voice: true }),
  );
  await spoken(surface, media);
  await vi.waitFor(() => {
    expect(surface.input.value).toBe('Ordinary dictation');
  });
  expect(h.memory.active).toBe(false);
  expect(surface.input.getAttribute('aria-label')).toBe('Add task');
  expect(h.owner.snapshot().exchanges).toHaveLength(0);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
});
it.each(['stop and edit', 'one-click send'] as const)(
  'uses native task creation for standalone Voice (%s) despite a retained continuous command preference',
  async (gesture) => {
    const h = await setup(),
      media = voiceMediaHarness(window),
      transcript = deferred<string>();
    h.allowOrdinaryWrites();
    h.owner.setVoiceMode('continuous');
    h.owner.setInput('An older command draft');
    const run = vi.fn(async () => {});
    h.setRun(run);
    const transport = new NativeProviderTransport(
      async () => {
        throw new Error('No LLM requests for dictation');
      },
      () => () => {},
    );
    cleanups.push(() => {
      transport.dispose();
    });
    const connections = new ProviderConnections(
      new ProviderSecrets({
        getSecret: (id) => (id === 'abyss-tasks-openai-api-key' ? 'synthetic-speech' : null),
        setSecret: () => {},
      }),
      transport,
    );
    const surface = await h.mountCoordinator(
      { available: () => {}, transcribe: () => transcript.promise },
      () => connections.availability({ voice: 'openai', provider: 'disabled' }),
    );
    expect(surface.input.getAttribute('aria-label')).toBe('Add task');
    const mic = voiceButton(surface);
    expect(mic.hidden).toBe(false);
    expect(voiceButton(surface, 'CommandMode').hidden).toBe(true);
    expect(voiceButton(surface, 'History').hidden).toBe(false);
    const menus = captureMenus();
    for (const button of [mic, voiceButton(surface, 'Send')])
      button.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(menus).toHaveLength(0);
    expect(h.resolveOwner).not.toHaveBeenCalled();
    expect(media.getUserMedia).not.toHaveBeenCalled();
    vi.useFakeTimers();
    await startManualSpeech(surface, media);
    if (gesture === 'stop and edit') {
      mic.click();
      transcript.resolve('Spoken task');
      await vi.advanceTimersByTimeAsync(0);
      expect(surface.input.value).toBe('Spoken task');
      expect(h.ordinaryExecute).not.toHaveBeenCalled();
      surface.input.value = 'Edited spoken task';
      surface.input.dispatchEvent(new Event('input', { bubbles: true }));
      voiceButton(surface, 'Send').click();
    } else {
      voiceButton(surface, 'Send').click();
      transcript.resolve('Spoken task');
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.read('a.md')).toBe(
      gesture === 'stop and edit'
        ? '- [ ] Existing\n- [ ] Edited spoken task ➕ 2026-08-01\n'
        : '- [ ] Existing\n- [ ] Spoken task ➕ 2026-08-01\n',
    );
    expect(h.ordinaryExecute).toHaveBeenCalledOnce();
    expect(h.owner.snapshot()).toMatchObject({
      input: 'An older command draft',
      exchanges: [],
      voiceMode: 'continuous',
    });
    expect(run).not.toHaveBeenCalled();
  },
);
it.each(['recovered', 'terminal error', 'manual stop', 'hidden window'] as const)(
  'settles continuous capture after a failed task focus and SDK retry (%s)',
  async (outcome) => {
    const h = await setup(),
      media = voiceMediaHarness(window);
    const result = await h.api.tasks.list();
    if (!result.ok) throw new Error(result.error.code);
    const task = expectDefined(result.value.items[0]);
    h.owner.setVoiceMode('continuous');
    const surface = h.mount({ available: () => {}, transcribe: async () => '' });
    const voicePhase = expectDefined(surface.element.querySelector('.abyss-command-voice-phase'));
    await vi.waitFor(() => {
      expect(media.tracks[0]?.readyState).toBe('live');
    });
    const focus = { kind: 'task', target: task.target, revision: task.revision };
    let errorDuringTurn = false;
    let phaseDuringRetry = '';
    let tracksDuringRetry: string[] = [];
    cleanups.push(
      h.owner.subscribe((state) => {
        if (h.owner.commandPending() && state.status.kind === 'error') errorDuringTurn = true;
      }),
    );
    scriptedAgent(h, [
      { tool: 'find', input: { query: 'Existing', purpose: 'show-only' } },
      { tool: 'finish', input: { state: 'ready', selection: [{ ...focus, revision: 'expired' }] } },
      {
        tool: 'finish',
        input: () => {
          phaseDuringRetry = voicePhase.textContent;
          tracksDuringRetry = media.tracks.map((track) => track.readyState);
          if (outcome === 'terminal error')
            throw new Error('Provider could not complete the retry');
          if (outcome === 'manual stop') voiceButton(surface).click();
          if (outcome === 'hidden window') {
            vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
            document.dispatchEvent(new Event('visibilitychange'));
          }
          return { state: 'ready', selection: [focus] };
        },
      },
    ]);
    enter(surface, 'Show Existing');
    await vi.waitFor(() => {
      expect(h.owner.commandPending()).toBe(false);
      expect(h.owner.snapshot().status.kind).toBe(outcome === 'terminal error' ? 'error' : 'ready');
    });
    expect(errorDuringTurn).toBe(true);
    expect(phaseDuringRetry).toMatch(/paused/i);
    expect(tracksDuringRetry).toEqual(['ended']);
    expect(media.tracks[0]?.readyState).toBe('ended');
    if (outcome !== 'terminal error') expect(h.owner.snapshot().focus).toMatchObject([focus]);
    if (outcome === 'recovered') {
      expect(media.getUserMedia).toHaveBeenCalledTimes(2);
      expect(media.tracks[1]?.readyState).toBe('live');
      expect(voiceButton(surface).getAttribute('aria-description')).toMatch(/listening/i);
    } else {
      expect(media.getUserMedia).toHaveBeenCalledOnce();
      expect(voicePhase.textContent).toMatch(/stopped/i);
    }
  },
);
it('keeps agent phases and questions visible and retires continuous listening after an error', async () => {
  const h = await setup();
  const media = voiceMediaHarness(window);
  const surface = h.mount({ available: () => {}, transcribe: async () => '' });
  h.session.setVoiceMode('continuous');
  voiceButton(surface).click();
  await flushMicrotasks(0);
  const phase = expectDefined(surface.element.querySelector('.abyss-command-phase > span'));
  for (const [kind, message] of [
    ['thinking', 'Planning current command'],
    ['searching', 'Looking up sources'],
    ['writing', 'Saving accepted change'],
    ['ready', 'Ready for another refinement'],
    ['error', 'The note preview could not be rendered'],
  ] as const) {
    h.session.status(kind, message);
    await vi.waitFor(() => {
      expect(phase.textContent).toBe(message);
    });
  }
  h.session.question('Which duplicate child?');
  expect(phase.textContent).toBe('Needs your answer.');
  expect(surface.element.querySelector('.abyss-command-question')?.textContent).toBe(
    'Which duplicate child?',
  );
  expect(media.tracks.every((track) => track.readyState === 'ended')).toBe(true);
  expect(
    surface.element.querySelector('[aria-label="Microphone"]')?.getAttribute('aria-pressed'),
  ).toBe('false');
});

it('renders both native hierarchy roots with one moved child and its retained comment', async () => {
  const h = await setup({
    'a.md':
      '- [ ] Source\n  - [ ] Moving\n    - 2026-08-01: Owned comment\n  - [ ] Staying\n- [ ] Destination\n- [ ] Source\n  - > Unrelated source\n- [ ] Destination\n  - > Unrelated destination\n',
  });
  const surface = h.mount();
  const list = await h.api.tasks.list();
  if (!list.ok) throw new Error('list');
  const moving = expectDefined(list.value.items.find((node) => node.title === 'Moving'));
  const parent = expectDefined(list.value.items.find((node) => node.title === 'Destination'));
  const result = await expectDefined(h.api.tasks.prepare)({
    kind: 'hierarchy',
    operation: {
      type: 'reparent',
      source: moving.target,
      expectedSourceRevision: moving.revision,
      parent: parent.target,
      expectedParentRevision: parent.revision,
    },
  });
  if (!result.ok) throw new Error(result.error.code);
  h.session.stage({
    kind: 'task',
    plan: await canonicalCommandPlan(h.api, result.value, new AbortController().signal, {
      now: () => Date.UTC(2026, 7, 1, 12),
      deadline: Date.UTC(2026, 7, 1, 12) + 5000,
    }),
  });
  await flushMicrotasks(0);
  expect(surface.element.textContent).toContain('Source');
  expect(surface.element.textContent).toContain('Destination');
  expect(
    [...surface.element.querySelectorAll('.abyss-task-title')].map(
      (element) => element.textContent,
    ),
  ).toEqual(['Source', 'Destination']);
  const labels = [...surface.element.querySelectorAll('.abyss-subtask-label')].map(
    (element) => element.textContent,
  );
  expect(labels.filter((label) => label === 'Moving')).toHaveLength(1);
  expect(labels).toContain('Staying');
  const comments = [...surface.element.querySelectorAll('.abyss-comment-text')].map(
    (element) => element.textContent,
  );
  expect(comments).toEqual(['Owned comment']);
});

it('renders requested project creation values in the retained native project header without a saved DTO', async () => {
  const { h, projects } = await projectSetup();
  const result = await projects.schema();
  if (!result.ok) throw new Error(result.error.code);
  const schema = result.value,
    status = expectDefined(schema.statuses[1]);
  scriptedAgent(h, [
    { tool: 'interpret', input: { intent: 'plan', research: false } },
    {
      tool: 'project',
      input: {
        kind: 'create',
        name: 'Preview project',
        statusId: status.id,
        fields: [
          { fieldId: 'start', value: '2026-11-09' },
          { fieldId: 'end', value: '2026-11-12' },
        ],
      },
    },
    { tool: 'finish', input: { state: 'ready', message: 'Ready.' } },
  ]);
  const surface = h.mount();
  enter(surface, 'Create this project');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('ready');
  });
  const header = expectDefined(
    [...surface.element.querySelectorAll('.abyss-project-dashboard-header')].find((e) =>
      e.textContent.includes('Preview project'),
    ),
  );
  expect(header.querySelector('.abyss-project-dashboard-title')?.textContent).toBe(
    'New project: Preview project',
  );
  expect(header.querySelectorAll('.abyss-project-dashboard-date')).toHaveLength(2);
  expect(header.querySelector('.abyss-project-dashboard-status')?.textContent).not.toBe(
    'No status',
  );
  expect(h.owner.snapshot().entities.projects.some((p) => p.name === 'Preview project')).toBe(
    false,
  );
  expect(h.owner.snapshot().proposal.changes[0]).not.toHaveProperty('before');
  surface.destroy();
  expect(h.mount().element.textContent).toContain('New project: Preview project');
});

it('keeps a pending manual transcript editable when continuous mode is selected meanwhile', async () => {
  const h = await setup();
  const media = voiceMediaWithSampleClock(),
    result = deferred<string>();
  const surface = h.mount({ available: () => {}, transcribe: () => result.promise });
  await spoken(surface, media);
  h.session.setVoiceMode('continuous');
  result.resolve('Keep this for editing');
  await flushMicrotasks(0);
  expect(surface.input.value).toBe('Keep this for editing');
  expect(h.owner.snapshot().exchanges).toEqual([]);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
});
it.each([
  { agent: false, voice: true },
  { agent: true, voice: false },
])('does not auto-start continuous capture with unavailable controls %j', async (availability) => {
  const h = await setup(),
    media = voiceMediaHarness(window);
  const available = vi.fn();
  h.mount({ available, transcribe: async () => '' }, () => availability);
  h.session.setVoiceMode('continuous');
  await flushMicrotasks(0);
  expect(media.getUserMedia).not.toHaveBeenCalled();
  expect(available).not.toHaveBeenCalled();
});
it('stops continuous listening with the microphone and reports speech activity without extra controls', async () => {
  const h = await setup(),
    media = voiceMediaHarness(window);
  h.session.setVoiceMode('continuous');
  const surface = h.mount({ available: () => {}, transcribe: async () => '' });
  const microphone = expectDefined(
    surface.element.querySelector<HTMLButtonElement>('[aria-label="Microphone"]'),
  );
  await flushMicrotasks(0);
  media.level(0.1);
  await vi.waitFor(() => {
    expect(microphone.dataset['speaking']).toBe('true');
  });
  microphone.click();
  await flushMicrotasks(0);
  expect(microphone.getAttribute('aria-pressed')).toBe('false');
  expect(microphone.dataset['speaking']).toBe('false');
  expect(media.tracks[0]?.stop).toHaveBeenCalledOnce();
  expect(h.owner.snapshot().exchanges).toEqual([]);
});

it('keeps one textarea row when integer scrollHeight rounds a fractional line height upward', async () => {
  const h = await setup(),
    surface = h.mount(),
    input = surface.input as HTMLTextAreaElement;
  Object.defineProperty(input, 'scrollHeight', { configurable: true, value: 36 });
  vi.spyOn(input.win, 'getComputedStyle').mockReturnValue({
    lineHeight: '19.6px',
    fontSize: '14px',
    paddingTop: '8px',
    paddingBottom: '8px',
  } as CSSStyleDeclaration);
  h.owner.setInput('Single line');
  expect(input.rows).toBe(1);
});

it('restores ordinary capture when retained command mode loses its provider', async () => {
  const h = await setup();
  h.owner.setInput('Retained command draft');
  const surface = h.mount(undefined, () => ({ agent: false, voice: false }));
  expect(surface.input.getAttribute('aria-label')).toBe('Add task');
  expect(h.memory.active).toBe(false);
  expect(
    surface.element.querySelector<HTMLButtonElement>('[aria-label="CommandMode"]')?.hidden,
  ).toBe(true);
  expect(h.owner.snapshot().input).toBe('Retained command draft');
  expect(h.resolveOwner).not.toHaveBeenCalled();
});

function openHistory(surface: CaptureSurface) {
  expectDefined(surface.element.querySelector<HTMLButtonElement>('[aria-label="History"]')).click();
  return expectDefined(document.body.querySelector<HTMLElement>('.abyss-command-history-popover'));
}
it.each(['command toggle', 'offline history'] as const)(
  'retires an ordinary one-click speech send when opening %s',
  async (route) => {
    const h = await setup(),
      media = voiceMediaHarness(window),
      transcript = deferred<string>();
    h.memory.active = false;
    h.owner.setInput('Keep the command draft');
    await h.owner.flush();
    let signal: AbortSignal | undefined;
    const surface = h.mount(
      {
        available: () => {},
        transcribe: (_audio, current) => {
          signal = current;
          return transcript.promise;
        },
      },
      () => ({ agent: route === 'command toggle', voice: true }),
    );
    vi.useFakeTimers();
    await startManualSpeech(surface, media);
    voiceButton(surface, 'Send').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(signal?.aborted).toBe(false);
    if (route === 'command toggle') voiceButton(surface, 'CommandMode').click();
    else expectDefined(historyRows(openHistory(surface))[0]).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(surface.input.getAttribute('aria-label')).toBe('Command');
    expect(signal?.aborted).toBe(true);
    transcript.resolve('Old quick capture');
    await vi.advanceTimersByTimeAsync(0);
    expect(surface.input.value).toBe('Keep the command draft');
    expect(h.owner.snapshot().exchanges).toEqual([]);
    expect(h.ordinaryExecute).not.toHaveBeenCalled();
  },
);
function historyRows(popup: HTMLElement) {
  return [...popup.querySelectorAll<HTMLButtonElement>('.abyss-command-history-select')];
}
it('searches retained text in a compact newest activity history without transcripts or action-menu rows', async () => {
  let time = 100;
  const h = await setup(
    {},
    (api) => api,
    () => time,
  );
  h.owner.setInput('Older task');
  await h.owner.flush();
  await h.owner.newSession('keep');
  time = 200;
  h.setRun(async () => {
    h.session.exchange('agent', 'Retained assistant answer');
    h.session.status('ready', 'Ready.');
  });
  await h.owner.submit('Newer task');
  await h.owner.submit('Find this hidden followup');
  await h.owner.flush();
  await h.owner.newSession('keep');
  const surface = h.mount();
  const popup = openHistory(surface);
  expect(popup.getAttribute('role')).toBe('dialog');
  expect(historyRows(popup).map((row) => row.textContent)).toEqual(['Newer task', 'Older task']);
  expect(popup.textContent).not.toContain('Retained assistant answer');
  expect(popup.textContent).not.toContain('New session');
  const search = expectDefined(popup.querySelector<HTMLInputElement>('input'));
  search.value = 'HIDDEN FOLLOWUP';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(historyRows(popup).map((row) => row.textContent)).toEqual(['Newer task']);
  search.value = 'absent';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(historyRows(popup)).toHaveLength(0);
  expect(popup.textContent).toContain('No matching sessions');
});
it('deletes through a separate X and retains the search and focused input during asynchronous refresh', async () => {
  const h = await setup();
  h.owner.setInput('Keep this');
  await h.owner.flush();
  const first = h.owner.snapshot().id;
  await h.owner.newSession('keep');
  h.owner.setInput('Delete this');
  await h.owner.flush();
  await h.owner.newSession('keep');
  const active = h.owner.snapshot().id;
  const surface = h.mount();
  const popup = openHistory(surface);
  const search = expectDefined(popup.querySelector<HTMLInputElement>('input'));
  search.value = 'this';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  search.focus();
  const wait = deferred<void>();
  const remove = h.persisted.storage.remove;
  h.persisted.storage.remove = async (id) => {
    await wait.promise;
    await remove(id);
  };
  const row = expectDefined(
    historyRows(popup).find((button) => button.textContent === 'Delete this'),
  );
  expectDefined(
    row.parentElement?.querySelector<HTMLButtonElement>('[aria-label="Delete session"]'),
  ).click();
  await flushMicrotasks();
  expect(popup.textContent).toContain('Updating history');
  expect(h.owner.snapshot().id).toBe(active);
  expect(search.value).toBe('this');
  expect(document.activeElement).toBe(search);
  wait.resolve();
  await vi.waitFor(() => {
    expect(historyRows(popup).map((button) => button.textContent)).toEqual(['Keep this']);
  });
  expect(h.owner.recent().map((record) => record.snapshot.id)).toEqual([first]);
  expect(search.value).toBe('this');
  expect(document.activeElement).toBe(search);
  expect(h.ordinaryExecute).not.toHaveBeenCalled();
});
it('clears all history through the broom and reports empty history', async () => {
  const h = await setup();
  h.owner.setInput('Disposable draft');
  await h.owner.flush();
  const surface = h.mount();
  const popup = openHistory(surface);
  expectDefined(popup.querySelector<HTMLButtonElement>('[aria-label="Clear history"]')).click();
  await vi.waitFor(() => {
    expect(h.owner.recent()).toHaveLength(0);
  });
  await flushMicrotasks();
  expect(popup.textContent).toContain('No sessions yet');
  expect(historyRows(popup)).toHaveLength(0);
});
it('shows history storage failures while keeping retained rows inspectable', async () => {
  const h = await setup();
  h.owner.setInput('Retained');
  await h.owner.flush();
  const surface = h.mount();
  const popup = openHistory(surface);
  h.persisted.storage.write = async () => {
    throw new Error('disk unavailable');
  };
  expectDefined(popup.querySelector<HTMLButtonElement>('[aria-label="Clear history"]')).click();
  await vi.waitFor(() => {
    expect(h.owner.persistenceFailure()).not.toBeNull();
  });
  expect(popup.querySelector('[role="status"]')?.textContent).toContain('history');
  expect(historyRows(popup).map((row) => row.textContent)).toEqual(['Retained']);
});
it('owns detached history input and Escape restores History focus and releases shortcut ownership', async () => {
  const h = await setup();
  const registry = new InteractionRegistry<string>();
  h.memory.active = false;
  const surface = h.mount(undefined, undefined, registry);
  surface.input.value = 'Ordinary draft';
  surface.input.dispatchEvent(new Event('input', { bubbles: true }));
  surface.input.focus();
  const popup = openHistory(surface);
  const search = expectDefined(popup.querySelector<HTMLInputElement>('input'));
  expect(surface.element.contains(popup)).toBe(false);
  expect(document.activeElement).toBe(search);
  expect(registry.allows('next')).toBe(false);
  await flushMicrotasks(0);
  expect(h.ordinaryExecute).not.toHaveBeenCalled();
  search.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  expect(popup.isConnected).toBe(false);
  expect(document.activeElement?.getAttribute('aria-label')).toBe('History');
  expect(registry.allows('next')).toBe(true);
  openHistory(surface);
  surface.destroy();
  expect(document.querySelector('.abyss-command-history-popover')).toBeNull();
  expect(registry.allows('next')).toBe(true);
});
it('selects complete saved descendants from JSON history without native reads or provider execution', async () => {
  let treeReads = 0;
  const h = await setup({}, (api) => ({
    ...api,
    tasks: {
      ...api.tasks,
      tree: async (...args) => {
        treeReads++;
        return expectDefined(api.tasks.tree)(...args);
      },
    },
  }));
  const first = h.mount();
  enter(first, 'Create');
  await flushMicrotasks(0);
  h.confirmInSession(first);
  await vi.waitFor(() => {
    expect(h.owner.snapshot().actual.length).toBeGreaterThan(0);
  });
  await h.session.whenIdle();
  await h.owner.flush();
  const savedSnapshot = h.owner.snapshot();
  const reloaded = await CommandSessionStore.open({ ...h.persisted, now: () => 1 });
  const record = expectDefined(
    reloaded.records().find((item) => item.snapshot.id === savedSnapshot.id),
  );
  expect(record.snapshot.actual).toEqual(savedSnapshot.actual);
  expect(record.snapshot.actual[0]?.complete).toBe(true);
  await h.owner.newSession('keep');
  first.destroy();
  const readsAfterSave = treeReads;
  let runs = 0;
  h.setRun(async () => {
    runs++;
  });
  const surface = h.mount({ available: () => {}, transcribe: async () => 'Unsendable' }, () => ({
    agent: false,
    voice: true,
  }));
  expect(voiceButton(surface).hidden).toBe(false);
  const popup = openHistory(surface);
  expectDefined(historyRows(popup)[0]).click();
  await vi.waitFor(() => {
    expect(surface.element.querySelector('.abyss-task-title')?.textContent).toBe('Parent');
  });
  expect(surface.element.querySelector<HTMLElement>('.abyss-command-content')?.hidden).toBe(false);
  expect(voiceButton(surface).hidden).toBe(true);
  expect(popup.isConnected).toBe(false);
  expect(surface.element.querySelector('.abyss-command-content')?.textContent).toContain(
    'Second child only',
  );
  expect(surface.element.querySelector('.abyss-command-content')?.textContent).not.toContain(
    'Incomplete saved tree',
  );
  expect(treeReads).toBe(readsAfterSave);
  enter(surface, 'Do another thing');
  await flushMicrotasks(0);
  expect(runs).toBe(0);
  expect(h.ordinaryExecute).not.toHaveBeenCalled();
});
it.each(['historical', 'live'] as const)(
  'uses receipt-verified actual for %s restoration while preserving fresh live selection',
  async (mode) => {
    const h = await setup();
    const listed = await h.api.tasks.list();
    if (!listed.ok) throw new Error(listed.error.code);
    const root = expectDefined(listed.value.items[0]);
    const stale = await expectDefined(h.api.tasks.tree)({
      target: root.target,
      expectedRevision: root.revision,
    });
    if (!stale.ok) throw new Error(stale.error.code);
    const prepared = await expectDefined(h.api.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
      operation: {
        type: 'patch',
        target: root.target,
        patch: { markdownTitle: { type: 'set', value: 'Verified result' } },
      },
    });
    if (!prepared.ok) throw new Error(prepared.error.code);
    h.session.stage({ kind: 'task', plan: prepared.value });
    expect(await h.owner.confirm()).toBe(true);
    expect(h.owner.snapshot().journal[0]?.effects).toBe('committed');
    const actual = expectDefined(h.owner.snapshot().actual[0]);
    // History can retain an older discovery of the receipt's committed identity.
    h.session.restore(
      {
        ...h.owner.snapshot(),
        entities: {
          tasks: [
            {
              ...stale.value,
              tree: {
                ...stale.value.tree,
                target: actual.target,
                markdownTitle: mode === 'live' ? 'Fresh selected read' : 'Stale discovery',
              },
            },
          ],
          projects: [],
          notes: [],
        },
      },
      mode === 'historical',
    );
    const surface = h.mount();
    await flushMicrotasks(0);
    expect(surface.element.querySelector('.abyss-task-title')?.textContent).toBe(
      mode === 'live' ? 'Fresh selected read' : 'Verified result',
    );
  },
);
it('keeps incomplete historical scope without reading expired handles or accepting a late live expansion', async () => {
  const wait = deferred<void>();
  const admitted = deferred<void>();
  const comments = Array.from({ length: 65 }, (_, i) => `\t- 2026-08-01: Comment ${i}\n`).join('');
  let reads = 0;
  const h = await setup(
    {
      'a.md': `- [ ] Existing\n${comments}`,
    },
    (api) => ({
      ...api,
      tasks: {
        ...api.tasks,
        tree: async (input) => {
          reads++;
          if (reads > 1) {
            admitted.resolve();
            await wait.promise;
          }
          return expectDefined(api.tasks.tree)(input);
        },
      },
    }),
  );
  const listed = await h.api.tasks.list();
  if (!listed.ok) throw new Error(listed.error.code);
  const root = expectDefined(listed.value.items[0]);
  const read = await expectDefined(h.api.tasks.tree)({
    target: root.target,
    expectedRevision: root.revision,
    limit: 10,
  });
  if (!read.ok) throw new Error(read.error.code);
  expect(read.value.tree.complete).toBe(false);
  const retained = {
    ...h.owner.snapshot(),
    focus: [{ kind: 'task' as const, target: root.target, revision: root.revision }],
    entities: { tasks: [read.value], projects: [], notes: [] },
  };
  h.session.restore(retained);
  let surface = h.mount();
  await flushMicrotasks(0);
  expect(reads).toBe(1);
  expect(surface.element.querySelector('.abyss-command-content')?.textContent).toContain(
    'Incomplete saved tree',
  );
  surface.destroy();
  h.session.restore(retained, false);
  surface = h.mount();
  await admitted.promise;
  h.session.restore(retained);
  wait.resolve();
  await flushMicrotasks(0);
  expect(surface.element.querySelector('.abyss-command-content')?.textContent).toContain(
    'Incomplete saved tree',
  );
  expect(surface.element.querySelectorAll('.abyss-comment-row')).toHaveLength(
    read.value.tree.comments.length,
  );
  h.session.restore(retained, false);
  await vi.waitFor(() => {
    expect(surface.element.querySelectorAll('.abyss-comment-row')).toHaveLength(65);
  });
  h.session.restore(retained);
  await flushMicrotasks(0);
  expect(surface.element.querySelectorAll('.abyss-comment-row')).toHaveLength(
    read.value.tree.comments.length,
  );
  expect(await h.owner.review()).toBe(true);
  expect(await h.owner.focus({ kind: 'task', target: root.target, revision: root.revision })).toBe(
    true,
  );
  await flushMicrotasks(0);
  expect(reads).toBeGreaterThan(2);
  expect(surface.element.querySelectorAll('.abyss-comment-row')).toHaveLength(65);
  expect(surface.element.querySelector('.abyss-command-tree-scope')?.hasAttribute('hidden')).toBe(
    true,
  );
});
it('protects an unresolved history row and leaves all records when clear-all is blocked', async () => {
  const h = await setup({}, (api) => ({
    ...api,
    tasks: {
      ...api.tasks,
      create: async () => ({
        ok: false as const,
        error: { code: 'LOST', category: 'io' as const, message: 'Lost receipt' },
        effects: 'unknown' as const,
        recovery: 'reconcile' as const,
      }),
    },
  }));
  const surface = h.mount();
  enter(surface, 'Create');
  await flushMicrotasks(0);
  h.confirmInSession(surface);
  await vi.waitFor(() => {
    expect(h.owner.snapshot().blocked).toBe(true);
  });
  await h.owner.flush();
  const popup = openHistory(surface);
  const remove = expectDefined(
    popup.querySelector<HTMLButtonElement>('[aria-label="Delete session"]'),
  );
  expect(remove.disabled).toBe(true);
  expect(remove.title).toContain('unresolved write');
  const ids = h.owner.recent().map((record) => record.snapshot.id);
  expectDefined(popup.querySelector<HTMLButtonElement>('[aria-label="Clear history"]')).click();
  await vi.waitFor(() => {
    expect(h.owner.persistenceFailure()).not.toBeNull();
  });
  expect(h.owner.recent().map((record) => record.snapshot.id)).toEqual(ids);
  expect(popup.querySelector('[role="status"]')?.textContent).toContain('history');
});

it('searches a pending project subject even when another focused entity supplies the session title', async () => {
  const { h, projects } = await projectSetup();
  const schema = await projects.schema();
  if (!schema.ok) throw new Error(schema.error.code);
  h.session.stage({
    kind: 'project-create',
    id: 'another-project',
    name: 'Hidden project subject',
    schema: schema.value,
  });
  await h.owner.flush();
  const surface = h.mount();
  const popup = openHistory(surface);
  const search = expectDefined(popup.querySelector<HTMLInputElement>('input'));
  search.value = 'Hidden project subject';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  expect(historyRows(popup)).toHaveLength(1);
  expect(historyRows(popup)[0]?.textContent).toBe('Project');
});
it('returns keyboard focus to history search when a pending row deletion loses its button focus', async () => {
  const h = await setup();
  h.owner.setInput('Remove focused row');
  await h.owner.flush();
  await h.owner.newSession('keep');
  const surface = h.mount();
  const popup = openHistory(surface);
  const wait = deferred<void>();
  const removeFile = h.persisted.storage.remove;
  h.persisted.storage.remove = async (id) => {
    await wait.promise;
    await removeFile(id);
  };
  const remove = expectDefined(
    popup.querySelector<HTMLButtonElement>('[aria-label="Delete session"]'),
  );
  remove.focus();
  remove.click();
  // Browsers may blur a focused button as it becomes disabled during the operation.
  remove.blur();
  wait.resolve();
  await vi.waitFor(() => {
    expect(historyRows(popup)).toHaveLength(0);
  });
  await flushMicrotasks(0);
  expect(document.activeElement).toBe(popup.querySelector('input'));
});

it.each(['contextmenu', 'keyboard'])(
  'selects continuous voice explicitly from the microphone %s menu',
  async (method) => {
    const h = await setup(),
      media = voiceMediaHarness(window),
      shown = captureMenus();
    const surface = h.mount({ available: () => {}, transcribe: async () => '' });
    const mic = expectDefined(
      surface.element.querySelector<HTMLButtonElement>('[aria-label="Microphone"]'),
    );
    mic.dispatchEvent(
      method === 'contextmenu'
        ? new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
        : new KeyboardEvent('keydown', {
            key: 'F10',
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          }),
    );
    expect(shown[shown.length - 1]?.titles).toEqual(['Dictation', 'Continuous']);
    expectDefined(shown[shown.length - 1]).pick('Continuous');
    await flushMicrotasks(0);
    expect(h.owner.snapshot().voiceMode).toBe('continuous');
    expect(media.getUserMedia).toHaveBeenCalledOnce();
    expect(h.owner.snapshot().exchanges).toEqual([]);
  },
);
it('ordinary dictation preserves mounted command status and elapsed children', async () => {
  const h = await setup(),
    media = voiceMediaWithSampleClock();
  h.memory.active = false;
  const surface = h.mount({ available: () => {}, transcribe: async () => 'Dictated text' });
  await spoken(surface, media);
  const phase = expectDefined(surface.element.querySelector('.abyss-command-phase'));
  expect(phase.querySelector('.abyss-command-elapsed')).not.toBeNull();
  expectDefined(
    surface.element.querySelector<HTMLButtonElement>('[aria-label="CommandMode"]'),
  ).click();
  h.session.status('error', 'Visible command failure');
  expect(phase.textContent).toContain('Visible command failure');
});
it('shows failed command text once while preserving the editable retry and newer edits', async () => {
  const h = await setup(),
    surface = h.mount();
  h.setRun(async () => {
    throw new Error('failed');
  });
  enter(surface, 'Failed command');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('error');
  });
  expect(surface.input.value).toBe('Failed command');
  const latest = expectDefined(surface.element.querySelector<HTMLElement>('.abyss-command-latest'));
  expect(latest.hidden).toBe(true);
  h.owner.setInput('Newer edit');
  expect(latest.hidden).toBe(false);
});
it('empty Enter saves a reviewed preview while continuous capture is only listening', async () => {
  const h = await setup(),
    media = voiceMediaHarness(window);
  const surface = h.mount({ available: () => {}, transcribe: async () => '' });
  enter(surface, 'Create parent');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().proposal.changes).toHaveLength(1);
  });
  h.session.setVoiceMode('continuous');
  voiceButton(surface).click();
  await flushMicrotasks(0);
  surface.input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await vi.waitFor(async () => {
    expect(await h.read('a.md')).toContain('Parent');
  });
  expect(media.tracks[0]?.stop).toHaveBeenCalledOnce();
});

it.each(['finish', 'microphone', 'owner Stop', 'Escape', 'manual', 'session', 'error', 'pagehide'])(
  'opening continuous Q during an existing turn waits; %s controls resumption',
  async (action) => {
    const h = await setup(),
      media = voiceMediaHarness(window),
      held = deferred<void>();
    h.owner.setVoiceMode('continuous');
    h.setRun(async () => {
      await held.promise;
      if (action === 'error') throw new Error('Failed turn');
    });
    const turn = h.owner.submit('Background command');
    vi.useFakeTimers();
    const surface = h.mount({ available: () => {}, transcribe: async () => '' });
    await vi.advanceTimersByTimeAsync(200);
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(voiceButton(surface).getAttribute('aria-description')).toMatch(/paused/i);
    let changing: Promise<unknown> | undefined;
    if (action === 'microphone') voiceButton(surface).click();
    if (action === 'owner Stop') changing = h.owner.stop();
    if (action === 'Escape')
      surface.input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    if (action === 'manual') h.owner.setVoiceMode('manual');
    if (action === 'session') changing = h.owner.newSession('keep');
    if (action === 'pagehide') window.dispatchEvent(new Event('pagehide'));
    held.resolve();
    await turn;
    await changing;
    await vi.advanceTimersByTimeAsync(0);
    expect(media.getUserMedia).toHaveBeenCalledTimes(action === 'finish' ? 1 : 0);
  },
);
it('opening a second visible continuous surface during ASR leaves the exclusive voice turn with its origin', async () => {
  const h = await setup(),
    media = voiceMediaHarness(window),
    recognition = deferred<string>();
  const frame = document.body.createEl('iframe');
  const child = expectDefined(frame.contentWindow) as Window & typeof window;
  const childMedia = voiceMediaHarness(child);
  const otherHost = document.body.createDiv();
  child.document.body.append(otherHost);
  h.owner.setVoiceMode('continuous');
  h.setRun(async () => {});
  vi.useFakeTimers();
  const origin = h.mount({ available: () => {}, transcribe: () => recognition.promise });
  await vi.advanceTimersByTimeAsync(300);
  media.level(0.1);
  await vi.advanceTimersByTimeAsync(200);
  media.level(0);
  await vi.advanceTimersByTimeAsync(3500);
  expect(voiceButton(origin).getAttribute('aria-description')).toMatch(/recognizing/i);
  const other = h.mount(
    { available: () => {}, transcribe: async () => '' },
    undefined,
    undefined,
    otherHost,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(childMedia.getUserMedia).not.toHaveBeenCalled();
  voiceButton(other).click();
  await vi.advanceTimersByTimeAsync(0);
  expect(childMedia.getUserMedia).not.toHaveBeenCalled();
  recognition.resolve('Origin command');
  await vi.advanceTimersByTimeAsync(0);
  expect(h.owner.snapshot().exchanges.filter((entry) => entry.role === 'user')).toEqual([
    { role: 'user', text: 'Origin command' },
  ]);
  expect(media.getUserMedia).toHaveBeenCalledTimes(2);
  expect(childMedia.getUserMedia).not.toHaveBeenCalled();
});
it.each(['listening', 'recognizing', 'work', 'open during work'])(
  'an ordinary microphone cannot take another surface’s enabled continuous claim during %s',
  async (phase) => {
    const h = await setup(),
      media = voiceMediaHarness(window),
      held = deferred<void>(),
      recognition = deferred<string>();
    const frame = document.body.createEl('iframe');
    const child = expectDefined(frame.contentWindow) as Window & typeof window;
    const childMedia = voiceMediaHarness(child);
    const otherHost = document.body.createDiv();
    child.document.body.append(otherHost);
    h.owner.setVoiceMode('continuous');
    h.setRun(async () => held.promise);
    vi.useFakeTimers();
    const background = phase === 'open during work' ? h.owner.submit('Already working') : undefined;
    const origin = h.mount({ available: () => {}, transcribe: () => recognition.promise });
    await vi.advanceTimersByTimeAsync(300);
    if (phase === 'recognizing') {
      media.level(0.1);
      await vi.advanceTimersByTimeAsync(200);
      media.level(0);
      await vi.advanceTimersByTimeAsync(3500);
    } else if (phase === 'work') enter(origin, 'Typed work');
    h.memory.active = false;
    const other = h.mount(
      { available: () => {}, transcribe: async () => 'Ordinary dictation' },
      undefined,
      undefined,
      otherHost,
    );
    expect(other.input.getAttribute('aria-label')).toBe('Add task');
    voiceButton(other).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(childMedia.getUserMedia).not.toHaveBeenCalled();
    expect(voiceButton(other).getAttribute('aria-description')).toMatch(/another panel/i);
    expect(media.tracks.some((track) => track.readyState === 'live')).toBe(phase === 'listening');
    if (phase === 'work' || phase === 'open during work') {
      voiceButton(other, 'CommandMode').click();
      voiceButton(other).click();
      expect(childMedia.getUserMedia).not.toHaveBeenCalled();
    }
    recognition.resolve('Origin command');
    held.resolve();
    await background;
    await vi.advanceTimersByTimeAsync(300);
    expect(media.tracks[media.tracks.length - 1]?.readyState).toBe('live');
    voiceButton(origin).click();
    if (other.input.getAttribute('aria-label') === 'Command')
      voiceButton(other, 'CommandMode').click();
    voiceButton(other).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(childMedia.getUserMedia).toHaveBeenCalledOnce();
  },
);
it('deliberate manual dictation can stay editable during an independent typed LLM turn', async () => {
  const h = await setup(),
    media = voiceMediaHarness(window),
    held = deferred<void>();
  let signal: AbortSignal | undefined;
  h.setRun(async (turn) => {
    signal = turn.signal;
    await held.promise;
  });
  const running = h.owner.submit('Typed request');
  h.memory.active = false;
  const surface = h.mount({ available: () => {}, transcribe: async () => 'Manual text' });
  vi.useFakeTimers();
  await startManualSpeech(surface, media);
  expect(media.tracks[0]?.readyState).toBe('live');
  expect(
    expectDefined(surface.element.querySelector('.abyss-command-waveform path')).hasAttribute('d'),
  ).toBe(false);
  voiceButton(surface).click();
  await vi.advanceTimersByTimeAsync(0);
  expect(surface.input.value).toBe('Manual text');
  expect(signal?.aborted).toBe(false);
  expect(h.owner.snapshot().exchanges.filter((entry) => entry.role === 'user')).toEqual([
    { role: 'user', text: 'Typed request' },
  ]);
  held.resolve();
  await running;
});
it.each([false, true])(
  'a delayed context-close error belongs to its recording, restarted=%s',
  async (restart) => {
    const h = await setup(),
      media = voiceMediaHarness(window),
      closing = deferred<void>();
    h.owner.setVoiceMode('continuous');
    vi.useFakeTimers();
    const surface = h.mount({ available: () => {}, transcribe: async () => '' });
    await vi.advanceTimersByTimeAsync(0);
    expectDefined(media.contexts[0]).close.mockImplementationOnce(async () => {
      await closing.promise;
      throw new Error('Private device detail');
    });
    voiceButton(surface).click();
    if (restart) {
      voiceButton(surface).click();
      await vi.advanceTimersByTimeAsync(0);
      expect(media.tracks[1]?.readyState).toBe('live');
    }
    closing.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const description = voiceButton(surface).getAttribute('aria-description');
    if (restart) {
      expect(media.tracks[1]?.readyState).toBe('live');
      expect(description).toMatch(/listening/i);
    } else expect(description).toMatch(/could not release voice processing/i);
  },
);
it.each(['Stop', 'microphone', 'empty', 'failure', 'timeout'])(
  'retiring continuous recognition on %s never reacquires automatically',
  async (action) => {
    const h = await setup(),
      media = voiceMediaHarness(window),
      recognition = deferred<string>();
    h.owner.setVoiceMode('continuous');
    vi.useFakeTimers();
    const surface = h.mount({
      available: () => {},
      transcribe: async () => {
        const text = await recognition.promise;
        if (action === 'failure') throw new Error('Private ASR failure');
        return text;
      },
    });
    await vi.advanceTimersByTimeAsync(300);
    media.level(0.1);
    await vi.advanceTimersByTimeAsync(200);
    media.level(0);
    await vi.advanceTimersByTimeAsync(3500);
    expect(media.tracks[0]?.readyState).toBe('ended');
    if (action === 'microphone') voiceButton(surface).click();
    if (action === 'Stop') await h.owner.stop();
    if (action === 'timeout') await vi.advanceTimersByTimeAsync(45000);
    recognition.resolve(action === 'empty' ? '   ' : 'Late text');
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.owner.snapshot().exchanges).toEqual([]);
    expect(media.getUserMedia).toHaveBeenCalledOnce();
    voiceButton(surface).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(media.getUserMedia).toHaveBeenCalledTimes(2);
  },
);
it('a delayed recorder stop keeps its container and shows capture has ended before ASR starts', async () => {
  const h = await setup(),
    media = voiceMediaHarness(window),
    recognition = deferred<string>();
  h.owner.setVoiceMode('continuous');
  media.delayStops();
  vi.useFakeTimers();
  const transcribe = vi.fn(() => recognition.promise);
  const surface = h.mount({ available: () => {}, transcribe });
  await vi.advanceTimersByTimeAsync(300);
  media.level(0.1);
  await vi.advanceTimersByTimeAsync(200);
  media.level(0);
  await vi.advanceTimersByTimeAsync(3500);
  expect(media.tracks[0]?.readyState).toBe('ended');
  expect(transcribe).not.toHaveBeenCalled();
  expect(voiceButton(surface).getAttribute('aria-pressed')).toBe('false');
  expect(voiceButton(surface).getAttribute('aria-description')).toMatch(/finishing/i);
  media.completeStops();
  expect(transcribe).toHaveBeenCalledOnce();
  expect(voiceButton(surface).getAttribute('aria-description')).toMatch(/recognizing/i);
  recognition.resolve('');
});
it('retains already-finished speech when a typed turn starts before the recorder delivers its blob', async () => {
  const h = await setup(),
    media = voiceMediaHarness(window),
    held = deferred<void>();
  h.owner.setVoiceMode('continuous');
  h.setRun(async () => held.promise);
  media.delayStops();
  vi.useFakeTimers();
  const transcribe = vi.fn(async () => 'Earlier complete speech');
  const surface = h.mount({ available: () => {}, transcribe });
  await vi.advanceTimersByTimeAsync(300);
  media.level(0.1);
  await vi.advanceTimersByTimeAsync(200);
  media.level(0);
  await vi.advanceTimersByTimeAsync(3500);
  expect(media.tracks[0]?.readyState).toBe('ended');
  enter(surface, 'Typed command');
  media.completeStops();
  await vi.advanceTimersByTimeAsync(0);
  expect(transcribe).toHaveBeenCalledOnce();
  held.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(surface.input.value).toBe('Earlier complete speech');
  expect(h.owner.snapshot().exchanges.filter((entry) => entry.role === 'user')).toEqual([
    { role: 'user', text: 'Typed command' },
  ]);
});
it.each(['agent', 'voice'] as const)(
  'rechecks the enabled %s connection before automatically reopening physical input',
  async (role) => {
    const h = await setup(),
      media = voiceMediaHarness(window),
      held = deferred<void>();
    h.owner.setVoiceMode('continuous');
    h.setRun(async () => held.promise);
    const available = { agent: true, voice: true };
    vi.useFakeTimers();
    const surface = h.mount({ available: () => {}, transcribe: async () => '' }, () => available);
    await vi.advanceTimersByTimeAsync(0);
    enter(surface, 'Typed work');
    expect(media.tracks[0]?.readyState).toBe('ended');
    available[role] = false;
    held.resolve();
    await vi.advanceTimersByTimeAsync(5000);
    expect(media.getUserMedia).toHaveBeenCalledOnce();
  },
);
it.each(['permission', 'resume'])(
  'rechecks enabled voice after delayed %s and stops the acquired track before starting a recorder',
  async (phase) => {
    const h = await setup(),
      media = voiceMediaHarness(window),
      held = deferred<void>();
    let connected = true;
    h.owner.setVoiceMode('continuous');
    if (phase === 'permission') {
      const acquire = expectDefined(media.getUserMedia.getMockImplementation());
      media.getUserMedia.mockImplementation(async () => {
        await held.promise;
        return acquire();
      });
    } else media.resume(() => held.promise);
    vi.useFakeTimers();
    h.mount({ available: () => {}, transcribe: async () => '' }, () => ({
      agent: true,
      voice: connected,
    }));
    await vi.advanceTimersByTimeAsync(0);
    expect(media.getUserMedia).toHaveBeenCalledOnce();
    expect(media.recorders).toHaveLength(0);
    connected = false;
    held.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(media.tracks[0]?.readyState).toBe('ended');
    expect(media.recorders).toHaveLength(0);
    expect(media.cues).toEqual([]);
    connected = true;
    h.owner.updateContext('Later background publication');
    await vi.advanceTimersByTimeAsync(3000);
    expect(media.getUserMedia).toHaveBeenCalledOnce();
  },
);
it('retires late microphone permission during typed work without a false recording cue', async () => {
  const h = await setup(),
    media = voiceMediaHarness(window),
    held = deferred<void>();
  h.owner.setVoiceMode('continuous');
  h.setRun(async () => held.promise);
  vi.useFakeTimers();
  const surface = h.mount({ available: () => {}, transcribe: async () => '' });
  enter(surface, 'Typed before permission');
  await vi.advanceTimersByTimeAsync(200);
  expect(media.tracks[0]?.readyState).toBe('ended');
  expect(media.recorders).toHaveLength(0);
  expect(media.cues).toEqual([]);
  held.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(media.tracks[1]?.readyState).toBe('live');
  expect(media.cues).toHaveLength(1);
});
it('selecting dictation from a stopped continuous session does not acquire the microphone', async () => {
  const h = await setup(),
    media = voiceMediaHarness(window),
    shown = captureMenus();
  const surface = h.mount({ available: () => {}, transcribe: async () => '' });
  h.owner.setVoiceMode('continuous');
  voiceButton(surface).click();
  await flushMicrotasks(0);
  const mic = expectDefined(
    surface.element.querySelector<HTMLButtonElement>('[aria-label="Microphone"]'),
  );
  mic.click();
  expect(media.tracks[0]?.stop).toHaveBeenCalledOnce();
  mic.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  expectDefined(shown[shown.length - 1]).pick('Dictation');
  await flushMicrotasks(0);
  expect(h.owner.snapshot().voiceMode).toBe('manual');
  expect(media.getUserMedia).toHaveBeenCalledOnce();
  expect(mic.getAttribute('aria-pressed')).toBe('false');
});

it.each(['', ' 🔁 every week on Wednesday'])(
  'shows recurrence add/change/removal without changing date/time (%s)',
  async (initial) => {
    const h = await setup({ 'a.md': `- [ ] Gym ⏳ 2026-11-11 ⏰ 10:00${initial}\n` });
    const listed = await h.api.tasks.list({});
    if (!listed.ok) throw new Error(listed.error.code);
    const root = expectDefined(listed.value.items[0]);
    const prepared = await expectDefined(h.api.tasks.prepare)({
      kind: 'edit',
      target: root.target,
      expectedRevision: root.revision,
    });
    if (!prepared.ok) throw new Error(prepared.error.code);
    let plan = await canonicalCommandPlan(h.api, prepared.value, new AbortController().signal, {
      now: () => Date.UTC(2026, 7, 1, 12),
      deadline: Date.UTC(2026, 7, 1, 12) + 5000,
    });
    h.session.stage({ kind: 'task', plan });
    const surface = h.mount();
    await flushMicrotasks(0);
    if (initial !== '') {
      expect(
        expectDefined(surface.element.querySelector('.abyss-recurrence-badge')).textContent,
      ).toContain('Wednesday');
      expect(
        expectDefined(surface.element.querySelector('.abyss-recurrence-badge')).getAttribute(
          'data-change',
        ),
      ).toBe('');
    }
    plan = await refineCommand(h, plan, {
      type: 'patch',
      target: root.target,
      patch: { recurrence: { type: 'set', value: 'every week on Friday' } },
    });
    const badge = expectDefined(surface.element.querySelector('.abyss-recurrence-badge'));
    expect(badge.textContent).toContain('Friday');
    expect(badge.getAttribute('data-change')).toBe('changed');
    expect(expectDefined(badge.querySelector('ins')).textContent).toContain('Friday');
    if (initial !== '')
      expect(expectDefined(badge.querySelector('del')).textContent).toContain('Wednesday');
    expect(surface.element.textContent).toContain('2026-11-11');
    expect(surface.element.textContent).toContain('10:00');
    expect([
      ...surface.element.querySelectorAll('.abyss-task-date [data-change="changed"]'),
    ]).toHaveLength(0);
    await refineCommand(h, plan, {
      type: 'patch',
      target: root.target,
      patch: { recurrence: { type: 'clear' } },
    });
    if (initial !== '')
      expect(
        surface.element.querySelector('.abyss-recurrence-badge[data-change="removed"]')
          ?.textContent,
      ).toContain('Wednesday');
    else expect(surface.element.querySelector('.abyss-recurrence-badge')).toBeNull();
    expect(await h.read('a.md')).toBe(`- [ ] Gym ⏳ 2026-11-11 ⏰ 10:00${initial}\n`);
  },
);

it.each(['Root', 'Child'])(
  'keeps the recurrence-only cumulative gutter on its owning %s row across later context',
  async (targetTitle) => {
    const rootRule = targetTitle === 'Root' ? ' 🔁 every week on Wednesday' : '';
    const childRule = targetTitle === 'Child' ? ' 🔁 every week on Wednesday' : '';
    const h = await setup({
      'a.md': `- [ ] Root ⏳ 2026-11-11 ⏰ 10:00${rootRule}\n\t- [ ] Child ⏳ 2026-11-11${childRule}\n`,
    });
    const listed = await h.api.tasks.list();
    if (!listed.ok) throw new Error(listed.error.code);
    const root = expectDefined(listed.value.items.find((node) => node.title === 'Root'));
    const target = expectDefined(listed.value.items.find((node) => node.title === targetTitle));
    await h.owner.focus({ kind: 'task', target: root.target, revision: root.revision });
    const calls: Array<{ tool: string; input: unknown }> = [
      { tool: 'interpret', input: { intent: 'plan', research: false } },
      {
        tool: 'task',
        input: {
          input: {
            kind: 'edit',
            target: target.target,
            expectedRevision: target.revision,
            operation: {
              type: 'patch',
              target: target.target,
              patch: { recurrence: { type: 'set', value: 'every week on Friday' } },
            },
          },
        },
      },
      { tool: 'finish', input: { state: 'ready', message: 'Recurrence ready.' } },
    ];
    scriptedAgent(h, calls);
    const surface = h.mount();
    const rows = () => [
      ...surface.element.querySelectorAll<HTMLElement>('.abyss-task-card-main-row'),
    ];
    const ownerRow = () =>
      expectDefined(rows().find((row) => row.querySelector('.abyss-recurrence-badge') !== null));
    await flushMicrotasks(0);
    expect(ownerRow().dataset['sessionChanged']).toBe('false');
    enter(surface, 'Change only the repeat to Friday.');
    await vi.waitFor(() => {
      expect(h.owner.snapshot().status.message).toBe('Ready. Enter to save.');
    });
    expect(ownerRow().dataset['sessionChanged']).toBe('true');
    expect(ownerRow().querySelector('ins')?.textContent).toBe('Friday');
    expect(
      rows()
        .filter((row) => row !== ownerRow())
        .every((row) => row.dataset['sessionChanged'] === 'false'),
    ).toBe(true);
    calls.push(
      { tool: 'interpret', input: { intent: 'plan', research: false } },
      { tool: 'read', input: { input: { kind: 'statuses' } } },
      {
        tool: 'finish',
        input: () => ({ state: 'ready', message: 'Context only.', selection: currentSelection(h) }),
      },
    );
    enter(surface, 'Show available statuses, change nothing.');
    await vi.waitFor(() => {
      expect(h.owner.snapshot().input).toBe('');
      expect(h.owner.snapshot().status.kind, h.owner.snapshot().status.message).toBe('ready');
    });
    expect(ownerRow().dataset['sessionChanged']).toBe('true');
    expect(ownerRow().querySelector('.abyss-recurrence-badge')?.textContent).toContain('Friday');
    expect(await h.read('a.md')).toBe(
      `- [ ] Root ⏳ 2026-11-11 ⏰ 10:00${rootRule}\n\t- [ ] Child ⏳ 2026-11-11${childRule}\n`,
    );
  },
);

it.each([false, true])(
  'history selection keeps continuous capture stopped from command mode=%s',
  async (active) => {
    const h = await setup();
    h.owner.setInput('Continuous history');
    h.owner.setVoiceMode('continuous');
    await h.owner.flush();
    const retained = h.owner.snapshot().id;
    await h.owner.newSession('keep');
    h.owner.setVoiceMode('manual');
    h.memory.active = active;
    const media = voiceMediaHarness(window);
    const surface = h.mount({ available: () => {}, transcribe: async () => '' });
    const popup = openHistory(surface);
    expectDefined(
      historyRows(popup).find((row) => row.textContent === 'Continuous history'),
    ).click();
    await vi.waitFor(() => {
      expect(h.owner.snapshot().id).toBe(retained);
    });
    await flushMicrotasks(0);
    expect(h.memory.active).toBe(true);
    expect(media.getUserMedia).not.toHaveBeenCalled();
    surface.destroy();
    h.mount({ available: () => {}, transcribe: async () => '' });
    await flushMicrotasks(0);
    expect(media.getUserMedia).toHaveBeenCalledOnce();
  },
);

it.each(['thinking', 'searching', 'writing'] as const)(
  'renders restored %s without a dead Stop control or running timer',
  async (kind) => {
    const h = await setup();
    h.owner.setInput('Retained history input');
    h.session.restore({
      ...h.session.snapshot(),
      status: { kind, message: 'Interrupted work' },
      blocked: kind === 'writing',
    });
    let surface = h.mount();
    for (let reopen = 0; reopen < 2; reopen++) {
      await flushMicrotasks(0);
      expect(surface.element.querySelector('[aria-label="Stop"]')).toBeNull();
      expect(surface.element.querySelector('.abyss-command-elapsed')?.hasAttribute('hidden')).toBe(
        true,
      );
      expect(h.owner.snapshot().recovery).toBe(kind === 'writing' ? 'uncertain' : 'historical');
      expect(surface.input.value).toBe('Retained history input');
      h.session.cancelTurn();
      surface.destroy();
      if (reopen === 0) surface = h.mount();
    }
  },
);

it.each(['manual', 'continuous'] as const)(
  'history stays microphone-stopped after an active %s controller enters ordinary capture',
  async (initialMode) => {
    const h = await setup();
    h.owner.setInput('Retained continuous history');
    h.owner.setVoiceMode('continuous');
    await h.owner.flush();
    const retained = h.owner.snapshot().id;
    await h.owner.newSession('keep');
    h.owner.setVoiceMode(initialMode);
    const media = voiceMediaHarness(window);
    const surface = h.mount({ available: () => {}, transcribe: async () => '' });
    const microphone = expectDefined(
      surface.element.querySelector<HTMLButtonElement>('[aria-label="Microphone"]'),
    );
    await flushMicrotasks(0);
    if (initialMode === 'continuous') microphone.click();
    const starts = media.getUserMedia.mock.calls.length;
    expect(microphone.getAttribute('aria-pressed')).toBe('false');
    expectDefined(
      surface.element.querySelector<HTMLButtonElement>('[aria-label="CommandMode"]'),
    ).click();
    await flushMicrotasks(0);
    expect(h.memory.active).toBe(false);
    const popup = openHistory(surface);
    expectDefined(
      historyRows(popup).find((row) => row.textContent === 'Retained continuous history'),
    ).click();
    await vi.waitFor(() => {
      expect(h.owner.snapshot().id).toBe(retained);
    });
    await flushMicrotasks(0);
    expect(h.memory.active).toBe(true);
    expect(media.getUserMedia).toHaveBeenCalledTimes(starts);
    expect(microphone.getAttribute('aria-pressed')).toBe('false');
    for (let publication = 0; publication < 3; publication++) {
      h.owner.open();
      h.owner.updateContext(`Publication ${publication}`);
      await h.owner.flush();
    }
    expect(media.getUserMedia).toHaveBeenCalledTimes(starts);
    expect(microphone.getAttribute('aria-pressed')).toBe('false');
    surface.destroy();
    h.mount({ available: () => {}, transcribe: async () => '' });
    await flushMicrotasks(0);
    expect(media.getUserMedia).toHaveBeenCalledTimes(starts + 1);
  },
);

it('coordinated command departure hides outside Q and retains its admitted turn', async () => {
  const h = await setup(),
    held = deferred<void>();
  let signal: AbortSignal | undefined;
  h.setRun(async (input) => {
    signal = input.signal;
    await held.promise;
  });
  const surface = await h.mountCoordinator();
  const sessionId = h.owner.snapshot().id;
  enter(surface, 'Accepted work');
  await vi.waitFor(() => {
    expect(signal).toBeDefined();
  });
  const outside = document.body.createEl('button', { text: 'Outside' });
  outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  outside.focus();
  await flushMicrotasks(0);
  expect(surface.host.querySelector('.abyss-capture-input')).toBeNull();
  expect(document.activeElement).toBe(outside);
  expect(h.owner.snapshot().id).toBe(sessionId);
  expect(signal?.aborted).toBe(false);
  outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  held.resolve();
  await vi.waitFor(() => {
    expect(h.notify).toHaveBeenCalledOnce();
  });
  const reopened = await h.mountCoordinator();
  expect(h.owner.snapshot().id).toBe(sessionId);
  expect(reopened.element.querySelector('.abyss-command-latest')?.textContent).toBe(
    'Accepted work',
  );
  expect(h.ordinaryExecute).not.toHaveBeenCalled();
});
it.each(['body', 'toolbar', 'content'])(
  'coordinated command Escape dismisses Q from %s focus',
  async (target) => {
    const h = await setup(),
      surface = await h.mountCoordinator();
    const selector = target === 'toolbar' ? '[aria-label="Send"]' : '.abyss-command-content';
    const destination =
      target === 'body'
        ? document.body
        : expectDefined(surface.element.querySelector<HTMLElement>(selector));
    surface.input.blur();
    destination.setAttribute('tabindex', '-1');
    destination.focus();
    destination.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    expect(surface.host.querySelector('.abyss-capture-input')).toBeNull();
    expect(h.ordinaryExecute).not.toHaveBeenCalled();
  },
);
it('coordinated History consumes its first Escape before Q dismisses', async () => {
  const h = await setup(),
    surface = await h.mountCoordinator();
  expectDefined(surface.element.querySelector<HTMLButtonElement>('[aria-label="History"]')).click();
  const search = expectDefined(
    document.querySelector<HTMLInputElement>('.abyss-command-history-search'),
  );
  search.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  expect(surface.host.querySelector('.abyss-capture-input')).not.toBeNull();
  expect(document.querySelector('.abyss-command-history-search')).toBeNull();
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  expect(surface.host.querySelector('.abyss-capture-input')).toBeNull();
});
it('a sibling ordinary toggle cannot reroute a visibly command Send into task capture', async () => {
  const h = await setup(),
    first = h.mount(),
    second = h.mount();
  h.owner.setInput('Move the existing task to tomorrow');
  expectDefined(
    first.element.querySelector<HTMLButtonElement>('[aria-label="CommandMode"]'),
  ).click();
  expect(second.input.getAttribute('aria-label')).toBe('Command');
  expect(second.element.classList.contains('abyss-capture-surface--command')).toBe(true);
  expectDefined(second.element.querySelector<HTMLButtonElement>('[aria-label="Send"]')).click();
  await flushMicrotasks(0);
  expect(
    h.owner
      .snapshot()
      .exchanges.filter((entry) => entry.role === 'user')
      .map((entry) => entry.text),
  ).toEqual(['Move the existing task to tomorrow']);
  expect(h.ordinaryExecute).not.toHaveBeenCalled();
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
});

function voiceButton(
  surface: Pick<CaptureSurface, 'element'>,
  label = 'Microphone',
): HTMLButtonElement {
  const selector = label === 'Microphone' ? '[data-voice-icon]' : `[aria-label="${label}"]`;
  return expectDefined(surface.element.querySelector<HTMLButtonElement>(selector));
}
async function startManualSpeech(
  surface: Pick<CaptureSurface, 'element'>,
  media: ReturnType<typeof voiceMediaHarness>,
) {
  voiceButton(surface).click();
  await vi.advanceTimersByTimeAsync(250);
  media.level(0.1);
  await vi.advanceTimersByTimeAsync(200);
  media.level(0);
}
it.each(['recording', 'recorder-stop', 'recognizing', 'visible transcript'])(
  'one Send during %s admits exactly one manual voice exchange',
  async (stage) => {
    const h = await setup(),
      media = voiceMediaHarness(window),
      result = deferred<string>();
    h.setRun(async () => {});
    const surface = h.mount({ available: () => {}, transcribe: () => result.promise });
    await flushMicrotasks(0);
    vi.useFakeTimers();
    media.delayStops();
    await startManualSpeech(surface, media);
    if (stage !== 'recording') voiceButton(surface).click();
    if (stage === 'recognizing' || stage === 'visible transcript') media.completeStops();
    if (stage === 'visible transcript') {
      result.resolve('Recognized command');
      await vi.advanceTimersByTimeAsync(0);
      expect(surface.input.value).toBe('Recognized command');
    }
    const send = voiceButton(surface, 'Send');
    expect(send.disabled).toBe(false);
    send.click();
    if (stage !== 'visible transcript') {
      send.click();
      surface.input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      media.completeStops();
      result.resolve('Recognized command');
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(h.owner.snapshot().exchanges.filter((entry) => entry.role === 'user')).toEqual([
      { role: 'user', text: 'Recognized command' },
    ]);
    expect(surface.input.value).toBe('');
    expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  },
);
it('keeps the next complete manual dictation editable after a held recognition times out', async () => {
  const h = await setup(),
    media = voiceMediaHarness(window),
    stale = deferred<string>();
  const transcribe = vi
    .fn(async () => 'Second dictation')
    .mockImplementationOnce(() => stale.promise);
  const surface = h.mount({ available: () => {}, transcribe });
  await flushMicrotasks(0);
  vi.useFakeTimers();
  await startManualSpeech(surface, media);
  voiceButton(surface).click();
  await startManualSpeech(surface, media);
  expect(media.tracks[1]?.readyState).toBe('live');
  expect(
    expectDefined(surface.element.querySelector('.abyss-command-waveform path')).hasAttribute('d'),
  ).toBe(false);
  voiceButton(surface).click();
  expect(transcribe).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(45000);
  expect(surface.input.value).toBe('Second dictation');
  stale.resolve('Late first result');
  await vi.advanceTimersByTimeAsync(0);
  expect(surface.input.value).toBe('Second dictation');
  expect(h.owner.snapshot().exchanges).toEqual([]);
});
it('Enter records one pending send while microphone-stop alone remains editable', async () => {
  const h = await setup(),
    media = voiceMediaHarness(window);
  h.setRun(async () => {});
  const surface = h.mount({ available: () => {}, transcribe: async () => 'Recognized command' });
  await flushMicrotasks(0);
  vi.useFakeTimers();
  await startManualSpeech(surface, media);
  voiceButton(surface).click();
  await vi.advanceTimersByTimeAsync(0);
  expect(surface.input.value).toBe('Recognized command');
  expect(h.owner.snapshot().exchanges).toEqual([]);
  h.owner.setInput('');
  await startManualSpeech(surface, media);
  surface.input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(h.owner.snapshot().exchanges.filter((entry) => entry.role === 'user')).toEqual([
    { role: 'user', text: 'Recognized command' },
  ]);
});
async function retirePendingSend(
  h: Awaited<ReturnType<typeof setup>>,
  surface: CaptureSurface,
  action: string,
) {
  if (action === 'edit' || action === 'sibling edit') {
    surface.input.value = 'Later typed input';
    surface.input.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (action === 'hide') surface.destroy();
  else if (action === 'mode') voiceButton(surface, 'CommandMode').click();
  else if (action === 'session') await h.owner.newSession('keep');
}
it.each(['edit', 'sibling edit', 'hide', 'mode', 'session', 'empty', 'error'])(
  'manual pending Send retires after %s without confirming a retained proposal',
  async (retire) => {
    const h = await setup(),
      media = voiceMediaHarness(window),
      result = deferred<string>();
    const surface = h.mount({
      available: () => {},
      transcribe: async () => {
        const text = await result.promise;
        if (retire === 'error') throw new Error('ASR failed');
        return text;
      },
    });
    enter(surface, 'Create parent');
    await vi.waitFor(() => {
      expect(h.owner.snapshot().proposal.changes).toHaveLength(1);
    });
    const other = retire === 'sibling edit' ? h.mount() : undefined;
    vi.useFakeTimers();
    await startManualSpeech(surface, media);
    voiceButton(surface, 'Send').click();
    await retirePendingSend(h, other ?? surface, retire);
    const edited = ['edit', 'sibling edit'].includes(retire);
    result.resolve(retire === 'empty' ? '   ' : 'Recognized refinement');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.owner.snapshot().exchanges.filter((entry) => entry.role === 'user')).toHaveLength(
      retire === 'session' ? 0 : 1,
    );
    expect(await h.read('a.md')).toBe('- [ ] Existing\n');
    expect(h.owner.snapshot().journal).toEqual([]);
    if (edited) expect(surface.input.value).toBe('Later typed input\n\nRecognized refinement');
    if (['empty', 'error'].includes(retire)) {
      expect(surface.input.value).toBe('');
      expect(surface.element.querySelector('.abyss-command-phase')?.textContent).toMatch(
        /speech|failed|unexpected/i,
      );
    }
  },
);
it.each(['recording', 'recognizing', 'pending Send'])(
  'closing idle Q preserves another Q with %s',
  async (stage) => {
    const h = await setup(),
      media = voiceMediaHarness(window),
      result = deferred<string>();
    h.setRun(async () => {});
    const first = h.mount(),
      second = h.mount({ available: () => {}, transcribe: () => result.promise });
    await flushMicrotasks(0);
    vi.useFakeTimers();
    await startManualSpeech(second, media);
    if (stage !== 'recording')
      voiceButton(second, stage === 'recognizing' ? 'Microphone' : 'Send').click();
    first.destroy();
    if (stage === 'recording') {
      expect(voiceButton(second).getAttribute('aria-pressed')).toBe('true');
      expect(media.tracks[0]?.stop).not.toHaveBeenCalled();
      voiceButton(second).click();
    }
    result.resolve('Second surface command');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.owner.snapshot().exchanges.filter((entry) => entry.role === 'user')).toEqual(
      stage === 'pending Send' ? [{ role: 'user', text: 'Second surface command' }] : [],
    );
    if (stage !== 'pending Send') expect(second.input.value).toBe('Second surface command');
    second.destroy();
    expect(media.tracks[0]?.stop).toHaveBeenCalledOnce();
  },
);
it('a passive shared preference update cannot acquire either stopped surface microphone', async () => {
  const h = await setup(),
    media = voiceMediaHarness(window);
  const first = h.mount({ available: () => {}, transcribe: async () => '' });
  const second = h.mount({ available: () => {}, transcribe: async () => '' });
  voiceButton(first, 'CommandMode').click();
  h.owner.setVoiceMode('continuous');
  await flushMicrotasks(0);
  expect(media.getUserMedia).not.toHaveBeenCalled();
  expect(voiceButton(first).getAttribute('aria-pressed')).not.toBe('true');
  expect(voiceButton(second).getAttribute('aria-pressed')).not.toBe('true');
});
it('a visible submitting surface alone acquires an agent-requested continuous microphone', async () => {
  const h = await setup(),
    media = voiceMediaHarness(window);
  const first = h.mount({ available: () => {}, transcribe: async () => '' });
  const second = h.mount({ available: () => {}, transcribe: async () => '' });
  voiceButton(first, 'CommandMode').click();
  h.setRun(async () => {
    h.session.setVoiceMode('continuous');
  });
  enter(second, 'Use continuous voice');
  await flushMicrotasks(0);
  expect(media.getUserMedia).toHaveBeenCalledOnce();
  expect(voiceButton(second).getAttribute('aria-pressed')).toBe('true');
  expect(voiceButton(first).getAttribute('aria-pressed')).not.toBe('true');
});
it('selecting a shared voice preference preserves the existing other-surface capture claim', async () => {
  const h = await setup(),
    media = voiceMediaHarness(window),
    shown = captureMenus();
  const first = h.mount({ available: () => {}, transcribe: async () => '' });
  const second = h.mount({ available: () => {}, transcribe: async () => '' });
  voiceButton(second).click();
  await flushMicrotasks(0);
  voiceButton(first).dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
  );
  expectDefined(shown[0]).pick('Continuous');
  expect(media.getUserMedia).toHaveBeenCalledOnce();
  expect(voiceButton(second).getAttribute('aria-pressed')).toBe('true');
  expect(voiceButton(first).getAttribute('aria-pressed')).not.toBe('true');
  expect(media.tracks[0]?.stop).not.toHaveBeenCalled();
});

it('closing idle Q preserves the other surface’s armed microphone while its typed turn settles', async () => {
  const h = await setup(),
    media = voiceMediaHarness(window),
    held = deferred<void>();
  h.owner.setVoiceMode('continuous');
  vi.useFakeTimers();
  h.setRun(async () => held.promise);
  const transcribe = vi.fn(async () => 'Unintended command');
  const first = h.mount(),
    second = h.mount({ available: () => {}, transcribe });
  await vi.advanceTimersByTimeAsync(300);
  media.level(0.1);
  await vi.advanceTimersByTimeAsync(200);
  enter(second, 'Running');
  expect(media.tracks[0]?.readyState).toBe('ended');
  first.destroy();
  await vi.advanceTimersByTimeAsync(2500);
  expect(transcribe).not.toHaveBeenCalled();
  expect(media.getUserMedia).toHaveBeenCalledOnce();
  held.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(media.getUserMedia).toHaveBeenCalledTimes(2);
  expect(voiceButton(second).getAttribute('aria-description')).toMatch(/listening/i);
});
it.each([false, true])(
  'resets speech feedback during a typed command with reduced motion=%s',
  async (reduced) => {
    const h = await setup(),
      media = voiceMediaHarness(window),
      held = deferred<void>();
    h.setRun(async () => held.promise);
    vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
    h.owner.setVoiceMode('continuous');
    vi.useFakeTimers();
    const surface = h.mount({ available: () => {}, transcribe: async () => '' });
    await vi.advanceTimersByTimeAsync(300);
    media.level(0.1);
    await vi.advanceTimersByTimeAsync(200);
    expect(voiceButton(surface).dataset['speaking']).toBe('true');
    enter(surface, 'Work while listening');
    h.session.status('thinking', 'Planning current command');
    await vi.advanceTimersByTimeAsync(200);
    const phase = expectDefined(surface.element.querySelector<HTMLElement>('.abyss-command-phase'));
    expect(phase.textContent).toMatch(/Planning current command/);
    expect(phase.textContent).toMatch(/paused/i);
    expect(phase.textContent).not.toMatch(/listening/i);
    expect(voiceButton(surface).dataset['speaking']).toBe('false');
    expect(phase.lastElementChild?.classList.contains('abyss-command-elapsed')).toBe(true);
    voiceButton(surface).click();
    expect(phase.textContent).toMatch(/stopped/i);
    held.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(media.getUserMedia).toHaveBeenCalledOnce();
  },
);
it.each(['recording', 'recognizing', 'visible transcript'])(
  'ordinary Q sends typed and dictated text exactly once from %s',
  async (stage) => {
    const h = await setup(),
      media = voiceMediaHarness(window),
      result = deferred<string>();
    h.memory.active = false;
    h.allowOrdinaryWrites();
    const surface = await h.mountCoordinator({
      available: () => {},
      transcribe: () => result.promise,
    });
    surface.input.value = 'Typed preface';
    surface.input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.useFakeTimers();
    await startManualSpeech(surface, media);
    if (stage !== 'recording') voiceButton(surface).click();
    if (stage === 'visible transcript') {
      result.resolve('Dictated continuation');
      await vi.advanceTimersByTimeAsync(0);
      expect(surface.input.value).toBe('Typed preface Dictated continuation');
    }
    voiceButton(surface, 'Send').click();
    if (stage !== 'visible transcript') voiceButton(surface, 'Send').click();
    result.resolve('Dictated continuation');
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.read('a.md')).toBe(
      '- [ ] Existing\n- [ ] Typed preface Dictated continuation ➕ 2026-08-01\n',
    );
    expect(h.ordinaryExecute).toHaveBeenCalledOnce();
    expect(h.owner.snapshot().exchanges).toEqual([]);
  },
);
it.each(['recording', 'recognizing'])(
  'ordinary coordinated departure retires %s without creating a partial task',
  async (stage) => {
    const h = await setup(),
      media = voiceMediaHarness(window),
      result = deferred<string>();
    h.memory.active = false;
    h.allowOrdinaryWrites();
    const surface = await h.mountCoordinator({
      available: () => {},
      transcribe: () => result.promise,
    });
    surface.input.value = 'Typed preface';
    surface.input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.useFakeTimers();
    await startManualSpeech(surface, media);
    if (stage === 'recognizing') voiceButton(surface).click();
    const outside = document.body.createEl('button');
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(surface.host.querySelector('.abyss-capture-input')).toBeNull();
    result.resolve('Late dictated text');
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.read('a.md')).toBe('- [ ] Existing\n');
    expect(media.tracks[0]?.stop).toHaveBeenCalledOnce();
    expect(h.ordinaryExecute).not.toHaveBeenCalled();
  },
);
it.each(['outside', 'Escape'])(
  'coordinated %s hide preserves an admitted write and its same-session readback',
  async (exit) => {
    const admitted = deferred<void>(),
      held = deferred<void>();
    let signal: AbortSignal | undefined;
    const h = await setup({}, (api) => ({
      ...api,
      tasks: {
        ...api.tasks,
        create: async (input, options) => {
          const result = await expectDefined(api.tasks.create)(input, options);
          admitted.resolve();
          await held.promise;
          return result;
        },
      },
    }));
    const surface = await h.mountCoordinator();
    enter(surface, 'Create parent');
    await vi.waitFor(() => {
      expect(h.owner.snapshot().status.kind).toBe('ready');
    });
    const sessionId = h.owner.snapshot().id;
    h.setRun(async (input) => {
      signal = input.signal;
      await h.session.confirmFromTurn(input.session.proposal.revision, input.signal);
    });
    enter(surface, 'Save the reviewed proposal');
    await admitted.promise;
    if (exit === 'outside')
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    else
      surface.input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    await flushMicrotasks(0);
    expect(surface.host.querySelector('.abyss-capture-input')).toBeNull();
    expect(signal?.aborted).toBe(false);
    held.resolve();
    await vi.waitFor(() => {
      expect(h.owner.snapshot().status.kind).toBe('saved');
    });
    await vi.waitFor(() => {
      expect(h.notify).toHaveBeenCalledOnce();
    });
    expect(h.owner.snapshot().id).toBe(sessionId);
    expect(h.owner.snapshot().journal[0]?.effects).toBe('committed');
    expect((await h.read('a.md')).match(/Parent/gu)).toHaveLength(1);
    const reopened = await h.mountCoordinator();
    await flushMicrotasks(0);
    expect(reopened.element.querySelector('.abyss-command-tree')?.textContent).toContain('Parent');
    expect(h.owner.snapshot().id).toBe(sessionId);
  },
);

it('a completed manual dictation releases its acquisition claim before a passive mode publication', async () => {
  const h = await setup(),
    media = voiceMediaHarness(window);
  const surface = h.mount({ available: () => {}, transcribe: async () => 'Editable text' });
  await flushMicrotasks(0);
  vi.useFakeTimers();
  await startManualSpeech(surface, media);
  voiceButton(surface).click();
  await vi.advanceTimersByTimeAsync(0);
  expect(surface.input.value).toBe('Editable text');
  expect(media.tracks[0]?.stop).toHaveBeenCalledOnce();
  h.owner.setVoiceMode('continuous');
  await vi.advanceTimersByTimeAsync(0);
  expect(media.getUserMedia).toHaveBeenCalledOnce();
  expect(voiceButton(surface).getAttribute('aria-pressed')).toBe('false');
});
it('coordinated wiki completion owns the first Escape without submitting or closing Q', async () => {
  vi.spyOn(textFieldPosition, 'textFieldAnchor').mockReturnValue(new DOMRect(100, 100, 1, 20));
  vi.spyOn(textFieldPosition, 'textFieldViewport').mockReturnValue(new DOMRect(0, 0, 1000, 800));
  const h = await setup({ 'Alpha.md': '', 'Alpine.md': '' }),
    surface = await h.mountCoordinator();
  surface.input.value = 'Draft [[Al';
  surface.input.setSelectionRange(10, 10);
  surface.input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => {
    expect(document.querySelector('.abyss-link-suggest-option')).not.toBeNull();
  });
  surface.input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  expect(document.querySelector('.abyss-link-suggest-option')).toBeNull();
  expect(surface.host.querySelector('.abyss-capture-input')).not.toBeNull();
  surface.input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  expect(surface.host.querySelector('.abyss-capture-input')).toBeNull();
  expect(h.owner.snapshot().exchanges).toEqual([]);
  expect(h.ordinaryExecute).not.toHaveBeenCalled();
});

it('coordinated command menu owns its detached pointer and first Escape', async () => {
  const h = await setup(),
    surface = await h.mountCoordinator();
  vi.spyOn(Menu.prototype, 'showAtMouseEvent').mockImplementation(function (this: Menu) {
    const menu = document.body.createDiv({ cls: 'menu' });
    menu.createDiv({ cls: 'menu-item', text: 'New session' });
    return this;
  });
  const hide = methodOf(Menu.prototype, 'hide');
  vi.spyOn(Menu.prototype, 'hide').mockImplementation(function (this: Menu) {
    document.querySelector('.menu')?.remove();
    return hide.call(this);
  });
  voiceButton(surface, 'Send').dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
  );
  const item = expectDefined(document.querySelector<HTMLElement>('.menu-item'));
  item.dispatchEvent(new Event('pointerdown', { bubbles: true }));
  await flushMicrotasks(0);
  expect(surface.host.querySelector('.abyss-capture-input')).not.toBeNull();
  item.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  expect(document.querySelector('.menu')).toBeNull();
  expect(surface.host.querySelector('.abyss-capture-input')).not.toBeNull();
  document.activeElement?.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
  expect(surface.host.querySelector('.abyss-capture-input')).toBeNull();
});
it('a later ordinary edit retires its pending Send and retains both editable parts', async () => {
  const h = await setup(),
    media = voiceMediaHarness(window),
    result = deferred<string>();
  h.memory.active = false;
  h.allowOrdinaryWrites();
  const surface = await h.mountCoordinator({
    available: () => {},
    transcribe: () => result.promise,
  });
  vi.useFakeTimers();
  await startManualSpeech(surface, media);
  voiceButton(surface, 'Send').click();
  surface.input.value = 'Later ordinary edit';
  surface.input.dispatchEvent(new Event('input', { bubbles: true }));
  result.resolve('Recognized text');
  await vi.advanceTimersByTimeAsync(0);
  expect(surface.input.value).toBe('Later ordinary edit Recognized text');
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  voiceButton(surface, 'Send').click();
  await vi.advanceTimersByTimeAsync(0);
  expect(await h.read('a.md')).toBe(
    '- [ ] Existing\n- [ ] Later ordinary edit Recognized text ➕ 2026-08-01\n',
  );
});

it('coordinated command departure waits for IME composition without cancelling admitted work', async () => {
  const h = await setup(),
    held = deferred<void>();
  let signal: AbortSignal | undefined;
  h.setRun(async (input) => {
    signal = input.signal;
    await held.promise;
  });
  const surface = await h.mountCoordinator();
  const sessionId = h.owner.snapshot().id;
  enter(surface, 'Accepted work');
  await vi.waitFor(() => {
    expect(signal).toBeDefined();
  });
  vi.useFakeTimers();
  surface.input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  surface.input.value = '未確定';
  surface.input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
  const outside = document.body.createEl('button', { text: 'Outside' });
  outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  outside.focus();
  await vi.advanceTimersByTimeAsync(10);
  expect(surface.host.querySelector('.abyss-capture-input')).toBe(surface.input);
  expect(document.activeElement).toBe(outside);
  expect(signal?.aborted).toBe(false);
  expect(h.ordinaryExecute).not.toHaveBeenCalled();
  surface.input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  surface.input.value = '確定した入力';
  surface.input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(10);
  expect(surface.host.querySelector('.abyss-capture-input')).toBeNull();
  expect(document.activeElement).toBe(outside);
  expect(h.owner.snapshot().input).toBe('確定した入力');
  expect(h.owner.snapshot().id).toBe(sessionId);
  expect(signal?.aborted).toBe(false);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  held.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.notify).toHaveBeenCalledOnce();
});
it.each(['recording', 'recognizing'])(
  'ordinary voice departure waits for IME composition while %s without writing partial input',
  async (stage) => {
    const h = await setup(),
      media = voiceMediaHarness(window),
      transcript = deferred<string>();
    h.memory.active = false;
    h.allowOrdinaryWrites();
    const surface = await h.mountCoordinator({
      available: () => {},
      transcribe: () => transcript.promise,
    });
    vi.useFakeTimers();
    await startManualSpeech(surface, media);
    if (stage === 'recognizing') voiceButton(surface).click();
    surface.input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    surface.input.value = '未確定';
    surface.input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    const outside = document.body.createEl('button', { text: 'Outside' });
    outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    outside.focus();
    await vi.advanceTimersByTimeAsync(10);
    expect(surface.host.querySelector('.abyss-capture-input')).toBe(surface.input);
    expect(h.ordinaryExecute).not.toHaveBeenCalled();
    surface.input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    surface.input.value = '確定した入力';
    surface.input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(10);
    expect(surface.host.querySelector('.abyss-capture-input')).toBeNull();
    expect(document.activeElement).toBe(outside);
    transcript.resolve('Late speech');
    await vi.advanceTimersByTimeAsync(0);
    expect(await h.read('a.md')).toBe('- [ ] Existing\n');
    expect(h.ordinaryExecute).not.toHaveBeenCalled();
    expect(media.tracks[0]?.stop).toHaveBeenCalledOnce();
  },
);
it('retires held recognition after same-document focus actually hides its originating surface', async () => {
  const h = await setup();
  const media = voiceMediaWithSampleClock();
  const result = deferred<string>();
  let recognitionSignal: AbortSignal | undefined;
  const origin = h.mount({
    available: () => {},
    transcribe: (_audio, signal) => {
      recognitionSignal = signal;
      return result.promise;
    },
  });
  await spokenCommand(h, origin, media);
  expect(expectDefined(recognitionSignal).aborted).toBe(false);
  const other = h.mount();
  other.input.focus();
  await vi.waitFor(() => {
    expect(origin.element.isConnected).toBe(false);
  });
  expect(expectDefined(recognitionSignal).aborted).toBe(true);
  other.input.value = '  Other exact draft  ';
  other.input.dispatchEvent(new Event('input', { bubbles: true }));
  result.resolve('Retired speech');
  await flushMicrotasks(0);
  expect(other.input.value).toBe('  Other exact draft  ');
  expect(h.owner.snapshot().exchanges).toEqual([]);
  expect(h.owner.snapshot().journal).toEqual([]);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
});

it.each(['manual', 'continuous'] as const)(
  'draws the %s waveform from live input, fades through quiet, and clears immediately for typing or Stop',
  async (mode) => {
    const h = await setup(),
      media = voiceMediaHarness(window);
    h.owner.setVoiceMode(mode);
    vi.useFakeTimers();
    const surface = h.mount({ available: () => {}, transcribe: async () => '' });
    const mic = voiceButton(surface);
    if (mode === 'manual') mic.click();
    await vi.advanceTimersByTimeAsync(300);
    expect(mic.dataset['voiceIcon']).toBe(mode === 'manual' ? 'square' : 'audio-lines');
    if (mode === 'manual') expect(mic.getAttribute('aria-label')).toBe('Stop dictation');
    const wave = expectDefined(
      surface.input.parentElement?.querySelector('.abyss-command-waveform'),
    );
    const path = expectDefined(wave.querySelector('path'));
    expect(wave.getAttribute('aria-hidden')).toBe('true');
    expect(path.getAttribute('d')).toBeNull();
    media.level(0.03);
    await vi.advanceTimersByTimeAsync(100);
    const quiet = path.getAttribute('d');
    expect(quiet).toBeTruthy();
    media.level(0.2);
    await vi.advanceTimersByTimeAsync(100);
    expect(path.getAttribute('d')).not.toBe(quiet);
    media.level(0);
    await vi.advanceTimersByTimeAsync(50);
    const lastVoice = firstBarHeight(path);
    expect(lastVoice).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(32);
    expect(firstBarHeight(path)).toBeGreaterThan(0);
    expect(firstBarHeight(path)).toBeLessThan(lastVoice);
    await vi.advanceTimersByTimeAsync(100);
    expect(path.getAttribute('d')).toBeNull();
    media.level(0.1);
    await vi.advanceTimersByTimeAsync(100);
    expect(path.getAttribute('d')).toBeTruthy();
    surface.input.value = 'I am typing';
    surface.input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(path.getAttribute('d')).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
    expect(path.getAttribute('d')).toBeNull();
    surface.input.value = '';
    surface.input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(100);
    expect(path.getAttribute('d')).toBeTruthy();
    mic.click();
    expect(path.getAttribute('d')).toBeNull();
    expect(media.tracks[0]?.readyState).toBe('ended');
    await vi.advanceTimersByTimeAsync(500);
    expect(path.getAttribute('d')).toBeNull();
    surface.destroy();
    expect(wave.isConnected).toBe(false);
  },
);
it.each([false, true])(
  'fits the live waveform to both edges at a consistent bar spacing after resizing (reduced motion: %s)',
  async (reduced) => {
    vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
    let resized: ResizeObserverCallback | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resized = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    const h = await setup(),
      media = voiceMediaHarness(window);
    vi.useFakeTimers();
    const surface = h.mount({ available: () => {}, transcribe: async () => '' });
    const wave = expectDefined(
      surface.element.querySelector<SVGSVGElement>('.abyss-command-waveform'),
    );
    const path = expectDefined(wave.querySelector('path'));
    voiceButton(surface).click();
    await vi.advanceTimersByTimeAsync(300);
    let firstHeight: number | undefined;
    for (const width of [500, 175]) {
      media.level(width === 500 ? 0.04 : 0.3);
      Object.defineProperty(surface.input, 'clientWidth', {
        configurable: true,
        value: width + 24,
      });
      Object.defineProperty(wave, 'clientWidth', { configurable: true, value: width });
      resized?.([], {} as ResizeObserver);
      await vi.advanceTimersByTimeAsync(80);
      const shape = path.getAttribute('d') ?? '';
      const height = firstBarHeight(path);
      if (firstHeight === undefined) firstHeight = height;
      else expect(height).toBeGreaterThan(firstHeight);
      const points = [...shape.matchAll(/M(\d+(?:\.\d+)?)/gu)].map((m) => Number(m[1]));
      const viewWidth = Number(wave.getAttribute('viewBox')?.split(' ')[2]);
      const pixels = points.map((x) => (x * width) / viewWidth);
      expect(points.length).toBeGreaterThanOrEqual(Math.floor(width / 6));
      expect(points.length).toBeLessThanOrEqual(Math.ceil(width / 4));
      expect(pixels[0]).toBeLessThanOrEqual(3);
      expect(width - (pixels[pixels.length - 1] ?? 0)).toBeLessThanOrEqual(3);
    }
    expect(wave.getAttribute('preserveAspectRatio')).toBe('none');
    expect(path.getAttribute('vector-effect')).toBe('non-scaling-stroke');
  },
);
function firstBarHeight(path: Element): number {
  return Number(/v([\d.]+)/u.exec(path.getAttribute('d') ?? '')?.[1] ?? 0);
}
it.each([false, true])(
  'interpolates rising and falling microphone frames between analyser samples then stops requesting frames (reduced motion: %s)',
  async (reduced) => {
    const h = await setup(),
      media = voiceMediaHarness(window);
    vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
    vi.useFakeTimers();
    const surface = h.mount({ available: () => {}, transcribe: async () => '' });
    voiceButton(surface).click();
    const path = expectDefined(surface.element.querySelector('.abyss-command-waveform path'));
    await vi.advanceTimersByTimeAsync(300);
    media.level(0.04);
    await vi.advanceTimersByTimeAsync(800);
    const quiet = firstBarHeight(path);
    expect(quiet).toBeGreaterThan(0);
    const request = window.requestAnimationFrame.bind(window);
    let pending = 0,
      maxPending = 0;
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((paint) => {
      maxPending = Math.max(maxPending, ++pending);
      return request((time) => {
        pending--;
        paint(time);
      });
    });
    await vi.advanceTimersByTimeAsync(200);
    expect(raf).not.toHaveBeenCalled();
    media.level(0.3);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(16);
    const rising = firstBarHeight(path);
    await vi.advanceTimersByTimeAsync(16);
    expect(rising).toBeGreaterThan(quiet);
    expect(firstBarHeight(path)).toBeGreaterThan(rising);
    await vi.advanceTimersByTimeAsync(768);
    const loud = firstBarHeight(path);
    media.level(0.04);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(16);
    const falling = firstBarHeight(path);
    await vi.advanceTimersByTimeAsync(16);
    expect(falling).toBeLessThan(loud);
    expect(firstBarHeight(path)).toBeLessThan(falling);
    expect(firstBarHeight(path)).toBeGreaterThan(quiet);
    expect(raf).toHaveBeenCalled();
    expect(maxPending).toBe(1);
  },
);
it('reacts gently when reduced motion changes during speech and retains identical bar positions', async () => {
  const h = await setup(),
    media = voiceMediaHarness(window),
    preference = { matches: false };
  vi.stubGlobal('matchMedia', () => preference);
  vi.useFakeTimers();
  const surface = h.mount({ available: () => {}, transcribe: async () => '' });
  voiceButton(surface).click();
  await vi.advanceTimersByTimeAsync(300);
  const path = expectDefined(surface.element.querySelector('.abyss-command-waveform path'));
  const positions = () => [...(path.getAttribute('d') ?? '').matchAll(/M(\d+)/gu)].map((m) => m[1]);
  media.level(0.3);
  await vi.advanceTimersByTimeAsync(82);
  const earlyNormal = firstBarHeight(path);
  await vi.advanceTimersByTimeAsync(718);
  const normal = firstBarHeight(path),
    geometry = positions();
  preference.matches = true;
  await vi.advanceTimersByTimeAsync(800);
  const reduced = firstBarHeight(path);
  expect(reduced).toBeGreaterThan(0);
  expect(reduced).toBeLessThan(normal);
  expect(positions()).toEqual(geometry);
  media.level(0);
  await vi.advanceTimersByTimeAsync(200);
  expect(path.hasAttribute('d')).toBe(false);
  media.level(0.3);
  await vi.advanceTimersByTimeAsync(82);
  expect(firstBarHeight(path)).toBeGreaterThan(0);
  expect(firstBarHeight(path) / reduced).toBeLessThan(earlyNormal / normal);
  preference.matches = false;
  await vi.advanceTimersByTimeAsync(718);
  expect(firstBarHeight(path)).toBe(normal);
});
it.each(['stop', 'agent work', 'hidden', 'disposed'] as const)(
  'cancels the pending waveform fade immediately on %s',
  async (reason) => {
    const h = await setup(),
      media = voiceMediaHarness(window),
      held = deferred<void>();
    h.setRun(() => held.promise);
    vi.useFakeTimers();
    const surface = h.mount({ available: () => {}, transcribe: async () => '' });
    voiceButton(surface).click();
    await vi.advanceTimersByTimeAsync(300);
    const path = expectDefined(surface.element.querySelector('.abyss-command-waveform path'));
    media.level(0.2);
    await vi.advanceTimersByTimeAsync(300);
    media.level(0);
    await vi.advanceTimersByTimeAsync(66);
    expect(path.hasAttribute('d')).toBe(true);
    const cancel = vi.spyOn(window, 'cancelAnimationFrame');
    let command: Promise<void> | undefined;
    if (reason === 'stop') voiceButton(surface).click();
    if (reason === 'agent work') command = h.owner.submit('Show the existing task');
    if (reason === 'hidden') {
      vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
      document.dispatchEvent(new Event('visibilitychange'));
    }
    if (reason === 'disposed') surface.destroy();
    expect(path.hasAttribute('d')).toBe(false);
    expect(cancel).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(160);
    expect(path.hasAttribute('d')).toBe(false);
    held.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await command;
  },
);
it('draws different samples with the same loudness differently without rendering the command tree', async () => {
  const h = await setup(),
    media = voiceMediaHarness(window);
  vi.useFakeTimers();
  const surface = h.mount({ available: () => {}, transcribe: async () => '' });
  voiceButton(surface).click();
  await vi.advanceTimersByTimeAsync(300);
  const path = expectDefined(surface.element.querySelector('.abyss-command-waveform path'));
  const renders = vi.spyOn(h.owner, 'snapshot');
  const firstHalf = new Float32Array(2048);
  firstHalf.fill(0.1, 0, 1024);
  media.frame(firstHalf);
  await vi.advanceTimersByTimeAsync(400);
  const first = path.getAttribute('d');
  expect(first).toBeTruthy();
  await vi.advanceTimersByTimeAsync(250);
  expect(path.getAttribute('d')).toBe(first);
  media.frame(firstHalf.reverse());
  await vi.advanceTimersByTimeAsync(100);
  expect(path.getAttribute('d')).toBeTruthy();
  expect(path.getAttribute('d')).not.toBe(first);
  expect(renders).not.toHaveBeenCalled();
});
it.each([false, true])(
  'one pointer click on Send finishes, transcribes and submits once in coordinated Q (command=%s)',
  async (command) => {
    const h = await setup(),
      media = voiceMediaHarness(window),
      recognition = deferred<string>();
    h.memory.active = command;
    h.allowOrdinaryWrites();
    const run = vi.fn(async () => {});
    h.setRun(run);
    const transcribe = vi.fn(() => recognition.promise);
    const surface = await h.mountCoordinator({ available: () => {}, transcribe });
    vi.useFakeTimers();
    media.delayStops();
    await startManualSpeech(surface, media);
    const send = voiceButton(surface, 'Send');
    send.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    send.focus();
    send.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true }));
    send.click();
    expect(media.tracks[0]?.readyState).toBe('ended');
    expect(transcribe).not.toHaveBeenCalled();
    media.completeStops();
    expect(transcribe).toHaveBeenCalledOnce();
    recognition.resolve('Buy milk');
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(Number(command));
    expect(h.ordinaryExecute).toHaveBeenCalledTimes(Number(!command));
    expect(h.owner.snapshot().exchanges.filter((entry) => entry.role === 'user')).toEqual(
      command ? [{ role: 'user', text: 'Buy milk' }] : [],
    );
  },
);
