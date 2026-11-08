import { MockLanguageModelV4 } from 'ai/test';
import { MarkdownRenderer } from 'obsidian';
import { afterEach, expect, it, vi } from 'vitest';
import type { ContentPlanV1, ProjectDtoV1, TaskContentOperationV1, TasksApiV1 } from '../api';
import { CommandAgent } from '../src/ai/CommandAgent';
import { canonicalCommandPlan } from '../src/ai/commandReads';
import { prepareSchema } from '../src/ai/commandSchemas';
import { CommandSession } from '../src/ai/CommandSession';
import { CommandSessionOwner } from '../src/ai/CommandSessionOwner';
import { CommandSessionStore } from '../src/ai/CommandSessionStore';
import type { CommandAgentPort, CommandSessionSnapshot } from '../src/ai/commandTypes';
import type { CommandTranscriptionPort } from '../src/ai/voice/ProviderTranscription';
import TaskCalendarPlugin from '../src/main';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import {
  CommandModeSurface,
  type CommandSurfaceMemory,
} from '../src/ui/commandMode/CommandModeSurface';
import { CaptureSurface } from '../src/ui/taskCapture/CaptureSurface';
import { TaskCaptureController } from '../src/ui/taskCapture/TaskCaptureController';
import { describeTaskCreationResult } from '../src/ui/taskCommandResult';
import { createAppWithFiles, deferred, expectDefined, flushMicrotasks } from './helpers';
import { captureMenus, mockReadingView } from './support/linkEditHarness';
import { publicApiHarness, type PublicApiHarness } from './support/publicApiHarness';
import { voiceMediaHarness } from './support/voiceMediaHarness';
const cleanups: Array<() => void> = [];
afterEach(() => {
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
  let persisted: unknown;
  let override: CommandAgentPort['run'] | undefined;
  const owner = new CommandSessionOwner({
    store: new CommandSessionStore({
      storage: {
        load: () => persisted,
        save: (value) => {
          persisted = value;
        },
      },
      now: () => 100,
    }),
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
  const mount = (transcription?: CommandTranscriptionPort) => {
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
          execute: async () => {
            throw new Error('Ordinary capture leaked');
          },
        },
      },
      describe: describeTaskCreationResult,
      onResult: () => {},
      onRequestClose: () => {},
    });
    const surface = new CaptureSurface(host, controller, {
      extend: (capture) =>
        new CommandModeSurface(capture, {
          app: h.app,
          ...(transcription === undefined ? {} : { transcription }),
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
  return {
    ...h,
    api,
    owner,
    session,
    memory,
    projectSettings,
    resolveOwner,
    mount,
    navigate,
    setRun: (run: CommandAgentPort['run']) => {
      override = run;
    },
    closeCount: () => closeCount,
  };
}
function enter(surface: CaptureSurface, text: string) {
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
  enter(surface, '');
  await new Promise((resolve) => window.setTimeout(resolve, 30));
  expect(await h.read('a.md')).toContain('Parent');
  expect(surface.element.querySelector('.abyss-command-phase')?.textContent).toContain('Saved');
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
  'retains command input after a late turn settles following %s',
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
    expect(h.owner.snapshot().input).toBe('Same command');
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
  enter(surface, '');
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
  await new Promise((resolve) => window.setTimeout(resolve, 220));
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
it('offers new session through the compact history menu and retains a dirty tree until disposition', async () => {
  const h = await setup();
  const shown = captureMenus();
  const surface = h.mount();
  enter(surface, 'Create');
  await flushMicrotasks(0);
  expectDefined(surface.element.querySelector<HTMLButtonElement>('[aria-label="History"]')).click();
  expectDefined(shown[0]).pick('New session');
  await flushMicrotasks(0);
  expect(h.owner.snapshot().pendingTransition?.kind).toBe('new-session');
  expect(surface.element.querySelector('.abyss-task-title')?.textContent).toBe('Parent');
  expectDefined(surface.element.querySelector<HTMLButtonElement>('[aria-label="History"]')).click();
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
function historyMenu(surface: CaptureSurface, shown: ReturnType<typeof captureMenus>) {
  expectDefined(surface.element.querySelector<HTMLButtonElement>('[aria-label="History"]')).click();
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
  const menu = historyMenu(surface, shown);
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
    historyMenu(surface, shown).pick('Save and continue');
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
    historyMenu(surface, shown).pick('Save and continue');
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
  const retired = historyMenu(original, shown);
  original.destroy();
  const current = h.mount();
  await flushMicrotasks(0);
  retired.pick('Save and continue');
  await flushMicrotasks(0);
  expect(h.app.vault.getFileByPath('Review.md')).toBeNull();
  expect(h.owner.snapshot().journal).toHaveLength(0);
  historyMenu(current, shown).pick('Save and continue');
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
    const old = historyMenu(surface, shown);
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
    historyMenu(surface, shown).pick('Save and continue');
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

it('retains selection and scroll when the active surface remounts without hiding its owner', async () => {
  const h = await setup();
  const first = h.mount();
  first.input.value = 'Retained command';
  first.input.dispatchEvent(new Event('input', { bubbles: true }));
  first.input.setSelectionRange(3, 7);
  const content = expectDefined(first.element.querySelector<HTMLElement>('.abyss-command-content'));
  content.scrollTop = 41;
  const hide = vi.spyOn(h.owner, 'hide');
  first.destroy();
  const second = h.mount();
  second.focus();
  expect(hide).not.toHaveBeenCalled();
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

function scriptedAgent(
  h: Awaited<ReturnType<typeof setup>>,
  calls: Array<{ tool: string; input: unknown }>,
): void {
  let sequence = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      const call = expectDefined(calls.shift());
      return {
        content: [
          {
            type: 'tool-call',
            toolCallId: `surface-${++sequence}`,
            toolName: call.tool,
            input: JSON.stringify(
              typeof call.input === 'function' ? (call.input as () => unknown)() : call.input,
            ),
          },
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
  const request = {
    kind: 'edit',
    target: root.target,
    expectedRevision: root.revision,
    operation: { type: 'update-comment', target: comment.target, text: 'Bring blue pen' },
  };
  const calls: Array<{ tool: string; input: unknown }> = [
    { tool: 'interpret', input: { intent: 'plan', research: false } },
    { tool: 'read', input: { input: { kind: 'tree', target: second.target, limit: 500 } } },
    {
      tool: 'task',
      input: () => ({
        input: {
          ...request,
          operation: {
            ...request.operation,
            target: expectDefined(
              [...h.owner.snapshot().entities.tasks].reverse()[0]?.tree.comments[0],
            ).target,
          },
        },
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
    expect(h.owner.snapshot().status.message).toBe('Ready.');
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
      input: { state: 'ready', message: 'All changes.', presentation: 'cumulative' },
    },
  );
  enter(surface, 'Show all changes');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.message).toBe('All changes.');
  });
  expect(changed.querySelector('del')?.textContent).toBe('red');
  surface.destroy();
  const reopened = h.mount();
  await flushMicrotasks(0);
  expect(reopened.element.querySelector('del')?.textContent).toBe('red');
  calls.push(
    { tool: 'interpret', input: { intent: 'plan', research: false } },
    { tool: 'finish', input: { state: 'ready', message: 'Selection retained.' } },
  );
  enter(reopened, 'Keep that selection');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.message).toBe('Selection retained.');
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
    expect(h.owner.snapshot().status.message).toBe('Note prepared.');
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
    expect(h.owner.snapshot().status.message).toBe('Note shortened.');
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
    expect(h.owner.snapshot().status.message).toBe('Link prepared.');
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
    { tool: 'finish', input: { state: 'ready', message: 'Selection retained.' } },
  );
  enter(surface, 'Keep this selection');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.message).toBe('Selection retained.');
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
    ].find((element) => element.textContent === '45m');
    expect(duration).toBeDefined();
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
  const phase = expectDefined(surface.element.querySelector<HTMLElement>('.abyss-command-phase'));
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
      expect(h.owner.snapshot().status.message).toBe('Ready.');
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

async function projectSetup(source = '---\nEffort: 2\n---\nProject body\n') {
  const app = await createAppWithFiles({
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
  return { h, project, projects };
}

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
  expect(field().getAttribute('data-change')).toBe('changed');
  const retainedProperty = field();
  await command('Start');
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
  enter(surface, '');
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
    expect(h.owner.snapshot().status.message).toBe('Ready.');
  });
  const removed = expectDefined(
    surface.element.querySelector<HTMLElement>('[data-project-field="description"]'),
  );
  expect(removed.textContent).toContain('Accepted description');
  expect(removed.dataset['change']).toBe('removed');
  expect(removed.inert).toBe(true);
  enter(surface, '');
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
    tool: 'task',
    input: () => {
      const plan = currentPlan(h);
      return {
        input: {
          kind: 'append',
          plan: plan.target,
          expectedPlanRevision: plan.revision,
          operation: operation(plan),
        },
      };
    },
  };
}
it.each([
  ['B', 'A', 'Child C'],
  ['Child C', 'A', 'B'],
])(
  'retains canonical interleaved removal order across preparations and remount (%j)',
  async (...order) => {
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
                target: expectDefined(
                  plan.after?.comments.find((comment) => comment.text === label),
                ).target,
              },
        ),
      ),
      { tool: 'finish', input: { state: 'ready', message: 'Ready.' } },
    ]);
    let surface = h.mount();
    enter(surface, 'Remove these exact comments and child');
    await vi.waitFor(() => {
      expect(h.owner.snapshot().status.message).toBe('Ready.');
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
      { text: 'Child C', removed: true },
      { text: 'D', removed: false },
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
    enter(surface, '');
    await vi.waitFor(() => {
      expect(h.owner.snapshot().status.kind).toBe('saved');
    });
    const saved = await expectDefined(h.api.tasks.tree)({ target: root.target, limit: 500 });
    if (!saved.ok) throw new Error(saved.error.code);
    expect(saved.value.tree.comments.map((comment) => comment.text)).toEqual(['D']);
    expect(saved.value.tree.children.map((child) => child.markdownTitle)).toEqual(['Child E']);
    expect(saved.value.tree.timeEntries).toHaveLength(2);
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
  const checkFirst = () => {
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
    expect(h.owner.snapshot().status.message).toBe('Ready.');
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
    expect(h.owner.snapshot().status.message).toBe('Only time.');
  });
  const checkLatest = () => {
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
      input: { state: 'ready', message: 'All changes.', presentation: 'cumulative' },
    },
  );
  enter(surface, 'Show cumulative changes');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.message).toBe('All changes.');
  });
  checkFirst();
  surface.destroy();
  surface = h.mount();
  await flushMicrotasks(0);
  checkFirst();
  enter(surface, '');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('saved');
  });
  expect(surface.element.querySelector('del, [data-change="changed"]')).toBeNull();
  expect(await h.read('a.md')).toContain('Renamed root');
  expect(await h.read('a.md')).toContain('Final comment');
});

it.each(['short', 'late'] as const)(
  'reviews a %s note-only section diff before Enter and retains fresh current note content after save/remount',
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
    expect(note.textContent).toContain('Folder/Research.md');
    expect(
      note.querySelector('.abyss-text-difference-removed')?.textContent ??
        note.querySelector('del')?.textContent,
    ).toContain('Old');
    expect(note.querySelector('ins')?.textContent).toContain('New');
    expect(note.querySelector('input[type="checkbox"]')).toBeNull();
    expect(await h.read('Folder/Research.md')).toContain('Old choice');
    enter(surface, '');
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
  enter(surface, '');
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
    scriptedAgent(h, [{ tool: 'interpret', input: { intent: 'confirm', research: false } }]);
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
    enter(surface, '');
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
    const second = h.mount();
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
      expect(h.owner.snapshot().status.message).toBe('Revised.');
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
    await vi.waitFor(() => {
      expect(second.element.querySelector('.abyss-command-note-body')?.textContent).toContain(
        'Latest draft',
      );
    });
    enter(second, '');
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
  enter(surface, '');
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
  enter(surface, '');
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
    enter(surface, '');
    await flushMicrotasks(0);
    expect(h.owner.snapshot().journal).toHaveLength(1);
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
    enter(surface, '');
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
      expect(h.owner.snapshot().status.message).toBe('Read current note.');
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
    enter(surface, '');
    await flushMicrotasks(0);
    expect(h.owner.snapshot().journal).toHaveLength(1);
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
  enter(surface, '');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('saved');
  });
  expect(await h.read('Contact.md')).toBe(
    original.replace('Phone 7719.', 'Phone 7719.\n\nVisits on Tuesday.'),
  );
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
  enter(surface, '');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().status.kind).toBe('saved');
  });
  expect(write).toHaveBeenCalledTimes(1);
  expect(await h.read('Note.md')).toBe(
    original.replace('First', 'Changed first').replace('Second', 'Changed second'),
  );
});

it.each(['enter', 'send', 'microphone'])(
  'final manual voice uses the real Q %s submission path once',
  async (action) => {
    const h = await setup();
    const media = voiceMediaHarness(window);
    const transcribe = vi.fn(async () => 'Recognized command');
    const surface = h.mount({ available: () => {}, transcribe });
    const microphone = expectDefined(
      surface.element.querySelector<HTMLButtonElement>('[aria-label="Microphone"]'),
    );
    microphone.click();
    await flushMicrotasks(0);
    expect(media.getUserMedia).toHaveBeenCalledOnce();
    media.level(0.1);
    await new Promise((resolve) => window.setTimeout(resolve, 200));
    media.level(0);
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
      expect(h.owner.snapshot().proposal.changes).toHaveLength(1);
    });
    expect(
      h.owner
        .snapshot()
        .exchanges.filter((e) => e.role === 'user')
        .map((e) => e.text),
    ).toEqual(['Recognized command']);
    expect(surface.element.querySelector('.abyss-command-latest')?.textContent).toBe(
      'Recognized command',
    );
    expect(media.tracks[0]?.stop).toHaveBeenCalledOnce();
    expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  },
);

async function spoken(surface: CaptureSurface, media: ReturnType<typeof voiceMediaHarness>) {
  expectDefined(
    surface.element.querySelector<HTMLButtonElement>('[aria-label="Microphone"]'),
  ).click();
  await flushMicrotasks(0);
  media.level(0.1);
  await new Promise((resolve) => window.setTimeout(resolve, 220));
  media.level(0);
  surface.input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
  await flushMicrotasks(0);
}
it('empty final speech never confirms the retained reviewed proposal', async () => {
  const h = await setup();
  const media = voiceMediaHarness(window);
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
    const media = voiceMediaHarness(window);
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
  const media = voiceMediaHarness(window);
  const result = deferred<string>();
  const surface = h.mount({ available: () => {}, transcribe: () => result.promise });
  await spoken(surface, media);
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
  const media = voiceMediaHarness(window);
  const result = deferred<string>();
  const origin = h.mount({ available: () => {}, transcribe: () => result.promise });
  const other = h.mount();
  await spoken(origin, media);
  other.input.value = '  Unsent text from the other Q  ';
  other.input.dispatchEvent(new Event('input', { bubbles: true }));
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
  const media = voiceMediaHarness(window);
  const result = deferred<string>(),
    finish = deferred<void>();
  h.setRun(async () => finish.promise);
  const origin = h.mount({ available: () => {}, transcribe: () => result.promise });
  const other = h.mount();
  enter(origin, 'Same command');
  await spoken(origin, media);
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
  const media = voiceMediaHarness(window);
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
  await spoken(surface, media);
  expect(surface.input.value).toBe('  Retained draft  \n\nSpoken command');
  expect(h.owner.snapshot().exchanges).toEqual([]);
  expect(h.owner.snapshot().journal).toEqual([]);
});
it("voice in a new empty session submits normally after another session's unsent draft", async () => {
  const h = await setup();
  const media = voiceMediaHarness(window);
  const surface = h.mount({ available: () => {}, transcribe: async () => 'Create parent' });
  surface.input.value = 'Prior unsent draft';
  surface.input.dispatchEvent(new Event('input', { bubbles: true }));
  expect(await h.owner.newSession()).toBe(true);
  expect(surface.input.value).toBe('');
  expect(media.getUserMedia).not.toHaveBeenCalled();
  await spoken(surface, media);
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
  const media = voiceMediaHarness(window);
  const result = deferred<string>();
  const surface = h.mount({ available: () => {}, transcribe: () => result.promise });
  enter(surface, 'Create parent');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().proposal.changes).toHaveLength(1);
  });
  const change = h.owner.snapshot().proposal.changes[0];
  if (change?.kind !== 'task' || change.plan.after === null) throw new Error('Missing task');
  const child = expectDefined(change.plan.after.children[1]);
  await spoken(surface, media);
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
it('final continuous speech steers planning; activity alone leaves the current turn running', async () => {
  const h = await setup();
  const media = voiceMediaHarness(window);
  const calls: Array<Parameters<CommandAgentPort['run']>[0]> = [];
  h.setRun(async (input) => {
    calls.push(input);
    if (calls.length === 1)
      await new Promise<void>((resolve) => {
        input.signal.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });
  });
  const texts = ['First voice command', 'Second voice refinement'];
  const surface = h.mount({
    available: () => {},
    transcribe: async () => expectDefined(texts.shift()),
  });
  h.session.setVoiceMode('continuous');
  expectDefined(
    surface.element.querySelector<HTMLButtonElement>('[aria-label="Microphone"]'),
  ).click();
  await flushMicrotasks(0);
  for (let index = 0; index < 2; index++) {
    media.level(0.1);
    await new Promise((resolve) => window.setTimeout(resolve, 220));
    if (index === 1) expect(calls[0]?.signal.aborted).toBe(false);
    media.level(0);
    await vi.waitFor(
      () => {
        expect(calls).toHaveLength(index + 1);
      },
      { timeout: 2000 },
    );
  }
  expect(calls[0]?.signal.aborted).toBe(true);
  expect(calls.map((call) => call.text)).toEqual([
    'First voice command',
    'Second voice refinement',
  ]);
  expect(media.getUserMedia).toHaveBeenCalledOnce();
  expect(media.tracks[0]?.stop).not.toHaveBeenCalled();
});
it('voice failure leaves typed input and proposal available for the next deliberate attempt', async () => {
  const h = await setup();
  const media = voiceMediaHarness(window);
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
    const media = voiceMediaHarness(window);
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
    scriptedAgent(h, [{ tool: 'interpret', input: { intent: 'confirm', research: false } }]);
    await spoken(surface, media);
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
  const media = voiceMediaHarness(window);
  const result = deferred<string>();
  const surface = h.mount({ available: () => {}, transcribe: () => result.promise });
  enter(surface, 'Create parent');
  await vi.waitFor(() => {
    expect(h.owner.snapshot().proposal.changes).toHaveLength(1);
  });
  await spoken(surface, media);
  const original = h.owner.snapshot().proposal.changes[0];
  if (original?.kind !== 'task') throw new Error('No plan');
  h.session.stage(original);
  scriptedAgent(h, [{ tool: 'interpret', input: { intent: 'confirm', research: false } }]);
  result.resolve('Confirm it');
  await flushMicrotasks(0);
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  expect(h.owner.snapshot().journal).toEqual([]);
  expect(h.owner.snapshot().activeQuestion).toMatch(/proposal changed/i);
  expect(surface.element.querySelector('.abyss-command-latest')?.textContent).toBe('Confirm it');
});
it('final voice waits for an admitted write and follows its verified focus mapping without replay', async () => {
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
  const media = voiceMediaHarness(window);
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
  enter(surface, '');
  await admitted.promise;
  let interpreted: CommandSessionSnapshot | undefined;
  h.setRun(async ({ session }) => {
    interpreted = session;
  });
  await spoken(surface, media);
  expect(interpreted).toBeUndefined();
  expect(writes).toBe(1);
  release.resolve();
  await vi.waitFor(() => {
    expect(interpreted).toBeDefined();
  });
  expect(writes).toBe(1);
  expect(interpreted?.focus[0]?.target).toBe(h.owner.snapshot().actual[0]?.target);
  expect(interpreted?.submissionBasis?.proposalRevision).toBe(1);
  expect((await h.read('a.md')).match(/Parent/g)).toHaveLength(1);
});
it('final voice waits for a dispatched apply before its source effect, then previews a new refinement', async () => {
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
  const media = voiceMediaHarness(window);
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
  enter(surface, '');
  await admitted.promise;
  expect(h.owner.snapshot().journal[0]?.state).toBe('admitted');
  await spoken(surface, media);
  expect(interpreted).toBeUndefined();
  expect(await h.read('a.md')).toBe('- [ ] Existing\n');
  release.resolve();
  await vi.waitFor(() => {
    expect(h.owner.snapshot().journal[0]?.effects).toBe('committed');
  });
  await vi.waitFor(() => {
    expect(currentTaskChange(h.owner.snapshot()).plan.after?.durationMinutes).toBe(20);
  });
  expect(calls).toBe(1);
  expect(interpreted?.focus[0]?.target).toBe(h.owner.snapshot().actual[0]?.target);
  expect(interpreted?.submissionBasis?.proposalRevision).toBe(1);
  expect(h.owner.snapshot().exchanges.filter((entry) => entry.role === 'user')).toHaveLength(1);
  expect(await h.read('a.md')).toBe('- [ ] Saved first\n');
  enter(surface, '');
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
  const media = voiceMediaHarness(window);
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
  media.level(0.1);
  await new Promise((resolve) => window.setTimeout(resolve, 220));
  media.level(0);
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
  await vi.advanceTimersByTimeAsync(220);
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
it('restores continuous mode without opening media when Q remounts', async () => {
  const h = await setup();
  const media = voiceMediaHarness(window);
  h.session.setVoiceMode('continuous');
  const surface = h.mount({ available: () => {}, transcribe: async () => '' });
  surface.destroy();
  const reopened = h.mount({ available: () => {}, transcribe: async () => '' });
  expect(media.getUserMedia).not.toHaveBeenCalled();
  expect(h.owner.snapshot().voiceMode).toBe('continuous');
  expect(
    reopened.element.querySelector('[aria-label="Microphone"]')?.getAttribute('aria-description'),
  ).toMatch(/continuous/i);
});
it('keeps agent phases, readiness, questions and errors visible during continuous listening', async () => {
  const h = await setup();
  const media = voiceMediaHarness(window);
  const surface = h.mount({ available: () => {}, transcribe: async () => '' });
  h.session.setVoiceMode('continuous');
  expectDefined(
    surface.element.querySelector<HTMLButtonElement>('[aria-label="Microphone"]'),
  ).click();
  await flushMicrotasks(0);
  const phase = expectDefined(surface.element.querySelector('.abyss-command-phase'));
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
  expect(media.tracks[0]?.stop).not.toHaveBeenCalled();
  expect(
    surface.element.querySelector('[aria-label="Microphone"]')?.getAttribute('aria-pressed'),
  ).toBe('true');
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
