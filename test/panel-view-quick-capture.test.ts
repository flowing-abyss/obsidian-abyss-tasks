import { MarkdownRenderer, WorkspaceLeaf, type App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../src/app/AppState';
import type { CenterPanel } from '../src/panels/CenterPanel';
import { TaskListSurface } from '../src/panels/task-list/TaskListSurface';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import type { CalendarSettings } from '../src/settings/types';
import { TagManager } from '../src/tags/TagManager';
import type { TaskRef } from '../src/tasks';
import type {
  CreationPresentationController,
  CreationRevealRequest,
} from '../src/ui/creation/CreationPresentationController';
import { renderedTaskElements } from '../src/ui/taskPresentationIdentity';
import { PanelView } from '../src/views/PanelView';
import { deferred, expectDefined, flushMicrotasks, useRealMoment } from './helpers';
import {
  prepareTaskPanelViewport,
  taskCardMountBound,
  taskListRect,
} from './support/taskPanelViewport';
import { createCanonicalSearchHarness } from './support/taskSearchHarness';
import { searchUiCompleted } from './support/taskSearchUiHarness';

useRealMoment();
let legacyScroll = vi.fn();
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return taskListRect(this) ?? new DOMRect(0, 0, 700, 900);
  });
  legacyScroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: legacyScroll,
  });
});
afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  vi.restoreAllMocks();
});

const rows = Array.from(
  { length: 1200 },
  (_, n) => `- [ ] A row ${String(n).padStart(4, '0')}`,
).join('\n');

async function mountQuickPanel(dashboard = false, tag = false, needle = false) {
  const settings: CalendarSettings = structuredClone(DEFAULT_SETTINGS);
  settings.taskFilePath = 'created.md';
  settings.taskInsertionMode = 'append';
  settings.projects.taskInsertionMode = 'append';
  settings.listViewStates = {
    inbox: { groupBy: 'none', sortBy: { field: 'title', dir: 'asc' }, filters: [] },
    'tag:#work': { groupBy: 'none', sortBy: { field: 'title', dir: 'asc' }, filters: [] },
  };
  const content = rows
    .split('\n')
    .map((row) => `${row}${needle ? ' needle' : ''}${tag ? ' #work' : ''}`)
    .join('\n');
  const h = await createCanonicalSearchHarness(
    {
      'many.md': dashboard ? '' : content,
      'created.md': '',
      'Projects/P.md': `---\nstatus: todo\n---\n\n# Tasks\n${dashboard ? rows : ''}\n`,
      'excluded.md': '- [ ] Unrelated excluded #other\n',
    },
    settings,
  );
  const leaf = new (WorkspaceLeaf as unknown as { new (app: App): WorkspaceLeaf })(h.app);
  const tags = new TagManager(h.app, settings, async () => {}, {
    check: () => 'ready',
    apply: async (_change, applyLive) => {
      applyLive();
    },
  });
  const view = new PanelView(
    leaf,
    settings,
    tags,
    h.index,
    h.tasks,
    h.statusRegistry,
    undefined,
    undefined,
    undefined,
    undefined,
    h.search,
  );
  prepareTaskPanelViewport(view.contentEl, true);
  for (const element of [view.contentEl, view.containerEl]) {
    const bounds = new DOMRect(0, 0, 700, 900);
    Object.defineProperty(element, 'getClientRects', {
      configurable: true,
      value: () => Object.assign([bounds], { item: () => bounds }),
    });
  }
  vi.spyOn(h.app.workspace, 'getActiveViewOfType').mockImplementation((type) =>
    type === PanelView ? view : null,
  );
  (h.app.workspace as { activeLeaf: WorkspaceLeaf | null }).activeLeaf = leaf;
  await view.onOpen();
  const internals = view as unknown as {
    state_abyssPrivate: AppState;
    center_abyssPrivate: CenterPanel;
    creationPresentation_abyssPrivate: CreationPresentationController;
  };
  const state = internals.state_abyssPrivate;
  state.set('selectedList', 'inbox');
  if (tag) state.set('selectedList', { type: 'tag', tag: '#work' });
  if (dashboard) {
    state.set('mode', 'projects');
    state.set('projectsPanel', { view: 'dashboard', path: 'Projects/P.md' });
  }
  const root = view.contentEl;
  const center = expectDefined(root.querySelector<HTMLElement>('.abyss-center'));
  return {
    ...h,
    view,
    root,
    center,
    state,
    settings,
    panel: internals.center_abyssPrivate,
    presentation: internals.creationPresentation_abyssPrivate,
    query(value: string) {
      const input = expectDefined(
        root.querySelector<HTMLInputElement>('.abyss-center-search, .abyss-search-global'),
      );
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    async openQ() {
      center.tabIndex = -1;
      center.focus();
      const event = new KeyboardEvent('keydown', {
        key: 'q',
        code: 'KeyQ',
        bubbles: true,
        cancelable: true,
      });
      center.dispatchEvent(event);
      await flushMicrotasks(0);
      expect(event.defaultPrevented).toBe(true);
      const input = expectDefined(
        root.querySelector<HTMLInputElement>('.abyss-quick-capture-host .abyss-capture-input'),
      );
      expect(document.activeElement).toBe(input);
      return input;
    },
    async dispose() {
      await view.onClose();
      view.containerEl.remove();
      (h.app.workspace as { activeLeaf: WorkspaceLeaf | null }).activeLeaf = null;
      h.close();
    },
  };
}

function enter(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
  );
}

/** Observe the real reveal; a short-lived pulse is not a reliable asynchronous completion clock. */
function nextQuickPresentation(presentation: CreationPresentationController) {
  const receipt = deferred<{ ref: TaskRef; element: HTMLElement } | undefined>();
  const present = presentation.present.bind(presentation);
  vi.spyOn(presentation, 'present').mockImplementationOnce(
    (result, description, authority, ownsSelection) => {
      present(
        result,
        description,
        authority === undefined
          ? undefined
          : {
              ...authority,
              onPresented(ref, element) {
                authority.onPresented?.(ref, element);
                receipt.resolve({ ref, element });
              },
              onFinished() {
                authority.onFinished?.();
                receipt.resolve(undefined);
              },
            },
        ownsSelection,
      );
      if (authority === undefined) receipt.resolve(undefined);
    },
  );
  return receipt.promise;
}

const revealRevocations = [
  'input',
  'blur',
  'escape',
  'navigation',
  'selection',
  'scroll-before-event',
] as const;

function revokeQuickReveal(
  h: Awaited<ReturnType<typeof mountQuickPanel>>,
  input: HTMLInputElement,
  reason: (typeof revealRevocations)[number],
  hosts: { readonly scroll: HTMLElement; readonly outside: HTMLInputElement },
): void {
  const { scroll, outside } = hosts;
  switch (reason) {
    case 'input':
      input.value = 'new draft';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      break;
    case 'blur':
      outside.focus();
      break;
    case 'escape':
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      break;
    case 'navigation':
      h.state.set('selectedList', 'upcoming');
      break;
    case 'selection':
      h.state.set('taskStack', [expectDefined(h.index.list({ filePath: 'many.md' })[0])]);
      break;
    case 'scroll-before-event':
      scroll.scrollTop = 64;
      break;
  }
}

describe('physical Q creation reveal through PanelView', () => {
  it.each([
    { origin: 'Inbox', dashboard: false, tag: false },
    { origin: 'tag', dashboard: false, tag: true },
    { origin: 'dashboard', dashboard: true, tag: false },
  ])(
    'reveals the exact offscreen root through the retained bounded $origin surface',
    async ({ dashboard, tag }) => {
      const h = await mountQuickPanel(dashboard, tag);
      try {
        const reveal = vi.spyOn(TaskListSurface.prototype, 'reveal');
        const input = await h.openQ();
        const presented = nextQuickPresentation(h.presentation);
        enter(input, 'Z created Q');
        const receipt = expectDefined(await presented);
        const created = expectDefined(h.index.list().find((task) => task.title === 'Z created Q'));
        expect(h.state.get('taskStack')).toEqual([created]);
        if (tag) expect(created.tags).toContain('#work');
        expect(
          h.index
            .list({ filePath: dashboard ? 'Projects/P.md' : 'created.md' })
            .filter((task) => task.title === 'Z created Q'),
        ).toHaveLength(1);
        expect(receipt.ref).toEqual(created.ref);
        const card = receipt.element;
        expect(renderedTaskElements(h.root, created.ref)).toContain(card);
        expect(card.classList.contains('is-just-created')).toBe(true);
        const scroll = expectDefined(
          h.root.querySelector<HTMLElement>(
            dashboard ? '.abyss-project-dashboard-session' : '.abyss-center-scroll',
          ),
        );
        const viewport = scroll.getBoundingClientRect();
        const bounds = card.getBoundingClientRect();
        expect(bounds.top).toBeGreaterThanOrEqual(viewport.top);
        expect(bounds.bottom).toBeLessThanOrEqual(viewport.bottom);
        expect(h.root.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(
          taskCardMountBound(h.root, 1),
        );
        expect(h.panel['taskSurface_abyssPrivate']?.surface.rows.taskCount).toBe(1201);
        expect(reveal).toHaveBeenCalledWith(`${created.ref.filePath}:${created.ref.line}`, {
          waitForReady: true,
        });
        expect(legacyScroll).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(input);
        expect(input.isConnected).toBe(true);
        expect(input.value).toBe('');
      } finally {
        await h.dispose();
      }
    },
  );

  it.each([
    {
      name: 'matched-text',
      global: false,
      property: false,
      destination: 'created.md',
      title: 'Z created Q needle',
    },
    {
      name: 'excluded-text',
      global: false,
      property: false,
      destination: 'created.md',
      title: 'Z created Q excluded',
    },
    {
      name: 'matched-property',
      global: false,
      property: true,
      destination: 'many.md',
      title: 'Z created Q needle',
    },
    {
      name: 'excluded-property',
      global: false,
      property: true,
      destination: 'created.md',
      title: 'Z created Q needle',
    },
    {
      name: 'global-search',
      global: true,
      property: false,
      destination: 'created.md',
      title: 'Z created Q needle',
    },
    {
      name: 'global-search-excluded',
      global: true,
      property: false,
      destination: 'created.md',
      title: 'Z created Q excluded',
    },
  ])(
    'preserves query and unrelated exclusions while revealing only the created root ($name)',
    async ({ global, property, destination, title }) => {
      const h = await mountQuickPanel(false, false, true);
      try {
        h.state.set('mode', global ? 'search' : 'tasks');
        h.settings.taskFilePath = destination;
        if (property) {
          h.state.set('centerListViewState', {
            ...h.state.get('centerListViewState'),
            filters: [{ type: 'file', filePath: 'many.md' }],
          });
        }
        h.query('needle');
        await searchUiCompleted(h.center);
        const filters = structuredClone(h.state.get('centerListViewState').filters);
        const input = await h.openQ();
        const presented = nextQuickPresentation(h.presentation);
        enter(input, title);
        const receipt = expectDefined(await presented);
        const created = expectDefined(h.index.list().find((task) => task.title === title));
        expect(receipt.ref).toEqual(created.ref);
        expect(renderedTaskElements(h.root, created.ref)).toContain(receipt.element);
        expect(receipt.element.classList.contains('is-just-created')).toBe(true);
        expect(h.state.get('taskStack')).toEqual([created]);
        expect(h.state.get('selectedList')).toBe('inbox');
        expect(h.state.get(global ? 'searchQuery' : 'centerFilter')).toBe('needle');
        expect(h.state.get('mode')).toBe(global ? 'search' : 'tasks');
        expect(h.state.get('centerListViewState').filters).toEqual(filters);
        expect(
          h.center.querySelector<HTMLInputElement>('.abyss-center-search, .abyss-search-global')
            ?.value,
        ).toBe('needle');
        expect(h.panel['taskSurface_abyssPrivate']?.surface.rows.taskCount).toBe(1201);
        const unrelated = expectDefined(h.index.list({ filePath: 'excluded.md' })[0]);
        expect(renderedTaskElements(h.root, unrelated.ref)).toEqual([]);
        expect(h.root.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(
          taskCardMountBound(h.root, 1),
        );
        expect(document.activeElement).toBe(input);
        expect(input.value).toBe('');
        expect(legacyScroll).not.toHaveBeenCalled();
      } finally {
        await h.dispose();
      }
    },
  );

  it.each(['presented', 'cancelled'] as const)(
    'observes a %s excluded reveal after the old polling window expires',
    async (outcome) => {
      const h = await mountQuickPanel(false, false, true);
      const entered = deferred<void>();
      const hydration = deferred<void>();
      try {
        h.query('needle');
        await searchUiCompleted(h.center);
        const resolve = h.index.resolveSearchHits.bind(h.index);
        vi.spyOn(h.index, 'resolveSearchHits').mockImplementation(async (hits, signal) => {
          const created = h.source.files().find((file) => file.path === 'created.md');
          if (
            created !== undefined &&
            hits.some((hit) =>
              [...h.source.nodes(created)].some((node) => node.rootId === hit.address.rootId),
            )
          ) {
            entered.resolve();
            await hydration.promise;
          }
          return resolve(hits, signal);
        });
        const input = await h.openQ();
        const presented = nextQuickPresentation(h.presentation);
        enter(input, 'Z created Q excluded');
        await entered.promise;
        // Reproduce the old assertion's false negative while real hydration is still pending.
        await expect(
          vi.waitFor(() => {
            expect(h.root.querySelector('.is-just-created')).not.toBeNull();
          }),
        ).rejects.toThrow();
        if (outcome === 'cancelled') {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        }
        hydration.resolve();
        const receipt = await presented;
        const created = expectDefined(h.index.list({ filePath: 'created.md' })[0]);
        expect(created.title).toBe('Z created Q excluded');
        expect(h.state.get('centerFilter')).toBe('needle');
        expect(h.state.get('centerListViewState').filters).toEqual([]);
        expect(h.root.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(
          taskCardMountBound(h.root, 1),
        );
        const unrelated = expectDefined(h.index.list({ filePath: 'excluded.md' })[0]);
        expect(renderedTaskElements(h.root, unrelated.ref)).toEqual([]);
        expect(legacyScroll).not.toHaveBeenCalled();
        if (outcome === 'presented') {
          const card = expectDefined(receipt).element;
          expect(receipt?.ref).toEqual(created.ref);
          expect(renderedTaskElements(h.root, created.ref)).toContain(card);
          expect(card.classList.contains('is-just-created')).toBe(true);
          expect(h.state.get('taskStack')).toEqual([created]);
          const scroll = expectDefined(h.center.querySelector<HTMLElement>('.abyss-center-scroll'));
          const viewport = scroll.getBoundingClientRect();
          expect(card.getBoundingClientRect().top).toBeGreaterThanOrEqual(viewport.top);
          expect(card.getBoundingClientRect().bottom).toBeLessThanOrEqual(viewport.bottom);
          expect(h.panel['taskSurface_abyssPrivate']?.surface.rows.taskCount).toBe(1201);
          expect(document.activeElement).toBe(input);
          expect(input.isConnected).toBe(true);
          expect(input.value).toBe('');
        } else {
          expect(receipt).toBeUndefined();
          await flushMicrotasks();
          expect(h.root.querySelector('.is-just-created')).toBeNull();
          expect(h.panel['creationInclusion_abyssPrivate']).toBeUndefined();
          expect(h.panel['creationAttempts_abyssPrivate'].size).toBe(0);
          expect(input.isConnected).toBe(false);
          expect(document.activeElement).toBe(h.center);
        }
      } finally {
        hydration.resolve();
        await h.dispose();
      }
    },
  );

  it.each(['calendar', 'overview'] as const)(
    'keeps %s creation without a stale disconnected list capability',
    async (origin) => {
      const h = await mountQuickPanel();
      try {
        h.state.set('mode', origin === 'calendar' ? 'calendar' : 'projects');
        const present = vi.spyOn(h.presentation, 'present');
        const reveal = vi.spyOn(TaskListSurface.prototype, 'reveal');
        const input = await h.openQ();
        enter(input, 'Z created Q');
        await flushMicrotasks();
        const created = expectDefined(h.index.list({ filePath: 'created.md' })[0]);
        expect(h.state.get('taskStack')).toEqual([created]);
        expect(present.mock.calls[0]?.[2]).toBeUndefined();
        expect(reveal).not.toHaveBeenCalled();
        expect(h.state.get('mode')).toBe(origin === 'calendar' ? 'calendar' : 'projects');
        expect(document.activeElement).toBe(input);
        expect(input.value).toBe('');
      } finally {
        await h.dispose();
      }
    },
  );

  it.each(
    (['command', 'excluded-prepare'] as const).flatMap((stage) =>
      [true, false].map((scrollEvent) => ({ stage, scrollEvent })),
    ),
  )(
    'keeps a Q write but drops its late reveal after scrolling during $stage; native event=$scrollEvent',
    async ({ stage, scrollEvent }) => {
      const h = await mountQuickPanel(false, false, true);
      const held = deferred<void>(),
        entered = deferred<void>();
      try {
        let presenting = false;
        const presented = deferred<void>();
        let revealing: HTMLElement | undefined | Promise<HTMLElement | undefined>;
        const present = h.presentation.present.bind(h.presentation);
        vi.spyOn(h.presentation, 'present').mockImplementation((result, description, authority) => {
          presenting = true;
          if (authority !== undefined) {
            const reveal = authority.reveal.bind(authority);
            vi.spyOn(authority, 'reveal').mockImplementation((ref, request) => {
              revealing = reveal(ref, request);
              return revealing;
            });
          }
          present(result, description, authority);
          presented.resolve();
        });
        if (stage === 'excluded-prepare') h.query('needle');
        if (stage === 'excluded-prepare') await searchUiCompleted(h.center);
        const plan = h.tasks.planCreate.bind(h.tasks);
        vi.spyOn(h.tasks, 'planCreate').mockImplementation(async (intent) => {
          const session = await plan(intent);
          if (session.type !== 'ready') return session;
          return {
            ...session,
            execute: async (request) => {
              if (stage === 'command') {
                entered.resolve();
                await held.promise;
              }
              const result = await session.execute(request);
              if (stage === 'excluded-prepare') await searchUiCompleted(h.center);
              return result;
            },
          };
        });
        if (stage === 'excluded-prepare') {
          const prepare = h.search.prepare.bind(h.search);
          vi.spyOn(h.search, 'prepare').mockImplementation(async (signal) => {
            await prepare(signal);
            if (presenting) {
              presenting = false;
              entered.resolve();
              await held.promise;
            }
          });
        }
        const input = await h.openQ();
        const title = stage === 'command' ? 'Z late Q needle' : 'Z late Q excluded';
        enter(input, title);
        await entered.promise;
        const scroll = expectDefined(h.center.querySelector<HTMLElement>('.abyss-center-scroll'));
        expect(document.activeElement).toBe(input);
        const reveal = vi.spyOn(TaskListSurface.prototype, 'reveal');
        scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: 550, bubbles: true }));
        scroll.scrollTop = 550;
        if (scrollEvent) scroll.dispatchEvent(new Event('scroll'));
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => {
            resolve();
          });
        });
        await flushMicrotasks();
        held.resolve();
        await presented.promise;
        await revealing;
        await flushMicrotasks();
        expect(h.index.list({ filePath: 'created.md' }).map((task) => task.title)).toEqual([title]);
        expect(h.root.querySelector('.abyss-creation-feedback')?.textContent).toContain('added');
        expect(reveal).not.toHaveBeenCalled();
        expect(scroll.scrollTop).toBe(550);
        expect(h.root.querySelector('.is-just-created')).toBeNull();
        expect(h.panel['creationInclusion_abyssPrivate']).toBeUndefined();
        expect(h.panel['creationAttempts_abyssPrivate'].size).toBe(0);
        expect(h.root.querySelectorAll('.abyss-task-card').length).toBeGreaterThan(0);
        expect(h.root.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(
          taskCardMountBound(h.root),
        );
        expect(document.activeElement).toBe(input);
        enter(input, 'ZZ fresh Q needle');
        await vi.waitFor(() => {
          expect(h.root.querySelector('.is-just-created')).not.toBeNull();
        });
        const fresh = expectDefined(
          h.index
            .list({ filePath: 'created.md' })
            .find((task) => task.title === 'ZZ fresh Q needle'),
        );
        expect(h.state.get('taskStack')).toEqual([fresh]);
        expect(renderedTaskElements(h.root, fresh.ref)).toContain(
          h.root.querySelector('.is-just-created'),
        );
        expect(scroll.scrollTop).toBeGreaterThan(550);
        expect(h.root.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(
          taskCardMountBound(h.root, 1),
        );
        expect(document.activeElement).toBe(input);
        expect(legacyScroll).not.toHaveBeenCalled();
      } finally {
        held.resolve();
        await h.dispose();
      }
    },
  );

  it('retains Q submission permission across acknowledged programmatic native scroll', async () => {
    const h = await mountQuickPanel();
    const held = deferred<void>(),
      entered = deferred<void>();
    try {
      const plan = h.tasks.planCreate.bind(h.tasks);
      vi.spyOn(h.tasks, 'planCreate').mockImplementation(async (intent) => {
        const session = await plan(intent);
        if (session.type !== 'ready') return session;
        return {
          ...session,
          execute: async (request) => {
            entered.resolve();
            await held.promise;
            return session.execute(request);
          },
        };
      });
      const input = await h.openQ();
      enter(input, 'Z acknowledged Q');
      await entered.promise;
      const surface = expectDefined(h.panel['taskSurface_abyssPrivate']).surface;
      expect(surface.reveal('many.md:600')).toBeDefined();
      const scroll = expectDefined(h.center.querySelector<HTMLElement>('.abyss-center-scroll'));
      expect(scroll.scrollTop).toBeGreaterThan(0);
      scroll.dispatchEvent(new Event('scroll'));
      held.resolve();
      await vi.waitFor(() => {
        expect(h.root.querySelector('.is-just-created')).not.toBeNull();
      });
      const created = expectDefined(h.index.list({ filePath: 'created.md' })[0]);
      expect(renderedTaskElements(h.root, created.ref)).toContain(
        h.root.querySelector('.is-just-created'),
      );
      expect(h.panel['creationAttempts_abyssPrivate'].size).toBe(0);
      expect(document.activeElement).toBe(input);
      expect(h.root.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(
        taskCardMountBound(h.root, 1),
      );
    } finally {
      held.resolve();
      await h.dispose();
    }
  });

  it.each(['Q', 'button'] as const)(
    'selects an undisturbed %s blur submission without revealing',
    async (route) => {
      const h = await mountQuickPanel();
      const outside = document.body.createEl('input');
      try {
        let input: HTMLInputElement;
        if (route === 'Q') input = await h.openQ();
        else {
          expectDefined(h.root.querySelector<HTMLButtonElement>('.abyss-add-task-trigger')).click();
          await flushMicrotasks();
          input = expectDefined(h.root.querySelector<HTMLInputElement>('.abyss-capture-input'));
        }
        input.value = 'Z blur submission';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        outside.focus();
        await flushMicrotasks();
        const created = expectDefined(h.index.list({ filePath: 'created.md' })[0]);
        expect(h.state.get('taskStack')).toEqual([created]);
        expect(h.root.querySelector('.abyss-right .abyss-right-title-view')?.textContent).toBe(
          created.title,
        );
        expect(h.root.querySelector('.abyss-creation-feedback')?.textContent).toContain('added');
        expect(h.root.querySelector('.is-just-created')).toBeNull();
        expect(h.panel['creationAttempts_abyssPrivate'].size).toBe(0);
        expect(document.activeElement).toBe(outside);
        expect(legacyScroll).not.toHaveBeenCalled();
      } finally {
        outside.remove();
        await h.dispose();
      }
    },
  );

  it.each(
    (['list', 'calendar', 'overview'] as const).flatMap((origin) =>
      [false, true].map((returnToOrigin) => ({ origin, returnToOrigin })),
    ),
  )(
    'retains the inspector after real sidebar navigation from $origin; return=$returnToOrigin',
    async ({ origin, returnToOrigin }) => {
      const h = await mountQuickPanel();
      const held = deferred<void>(),
        entered = deferred<void>();
      const openMode = (label: string): void => {
        expectDefined(
          h.root.querySelector<HTMLButtonElement>(`.abyss-rail-btn[aria-label="${label}"]`),
        ).click();
      };
      const openOrigin = (): void => {
        if (origin !== 'list') openMode(origin === 'calendar' ? 'Calendar' : 'Projects');
      };
      const openList = (label: string): void => {
        const row = expectDefined(
          [...h.root.querySelectorAll<HTMLElement>('.abyss-left-item')].find(
            (candidate) => candidate.querySelector('.abyss-left-label')?.textContent === label,
          ),
        );
        row.dispatchEvent(new Event('pointerdown', { bubbles: true }));
        row.click();
      };
      try {
        openList('Inbox');
        openOrigin();
        const previous = expectDefined(h.index.list({ filePath: 'many.md' })[0]);
        h.state.set('taskStack', [previous]);
        const present = vi.spyOn(h.presentation, 'present');
        const plan = h.tasks.planCreate.bind(h.tasks);
        vi.spyOn(h.tasks, 'planCreate').mockImplementation(async (intent) => {
          const session = await plan(intent);
          if (session.type !== 'ready') return session;
          return {
            ...session,
            execute: async (request) => {
              entered.resolve();
              await held.promise;
              return session.execute(request);
            },
          };
        });
        const input = await h.openQ();
        enter(input, 'Z retained navigation');
        await entered.promise;
        if (origin === 'overview') openMode('Tasks');
        openList('Today');
        expect(h.state.get('selectedList')).toBe('today');
        expect(h.state.get('taskStack')).toEqual([previous]);
        if (returnToOrigin) {
          openList('Inbox');
          openOrigin();
          expect(h.state.get('selectedList')).toBe('inbox');
        }
        expect(h.state.get('taskStack')).toEqual([previous]);
        held.resolve();
        await flushMicrotasks();
        await flushMicrotasks();
        expect(h.index.list({ filePath: 'created.md' }).map((task) => task.title)).toEqual([
          'Z retained navigation',
        ]);
        const authority = present.mock.calls[0]?.[2];
        if (origin === 'list') expect(authority?.canSelect?.()).toBe(false);
        else expect(authority).toBeUndefined();
        expect(h.state.get('taskStack')).toEqual([previous]);
        expect(h.root.querySelector('.abyss-right .abyss-right-title-view')?.textContent).toBe(
          previous.title,
        );
        expect(h.root.querySelector('.abyss-creation-feedback')?.textContent).toContain('added');
        expect(h.root.querySelector('.is-just-created')).toBeNull();
        expect(legacyScroll).not.toHaveBeenCalled();
      } finally {
        held.resolve();
        await h.dispose();
      }
    },
  );

  it.each(
    (['list', 'calendar', 'overview'] as const).flatMap((origin) =>
      (['task-click', 'navigation'] as const).map((laterIntent) => ({ origin, laterIntent })),
    ),
  )(
    'retains newer $laterIntent selection after a delayed Q write from $origin',
    async ({ origin, laterIntent }) => {
      const h = await mountQuickPanel();
      const held = deferred<void>(),
        entered = deferred<void>();
      try {
        if (origin !== 'list') h.state.set('mode', origin === 'calendar' ? 'calendar' : 'projects');
        const present = vi.spyOn(h.presentation, 'present');
        const plan = h.tasks.planCreate.bind(h.tasks);
        vi.spyOn(h.tasks, 'planCreate').mockImplementation(async (intent) => {
          const session = await plan(intent);
          if (session.type !== 'ready') return session;
          return {
            ...session,
            execute: async (request) => {
              entered.resolve();
              await held.promise;
              return session.execute(request);
            },
          };
        });
        const previous = expectDefined(h.index.list({ filePath: 'many.md' })[0]);
        h.state.set('taskStack', [previous]);
        const input = await h.openQ();
        enter(input, 'Z late Q selection');
        await entered.promise;
        if (origin !== 'list') {
          h.state.set('mode', 'tasks');
          await flushMicrotasks();
        }
        const newer = expectDefined(h.index.list({ filePath: 'many.md' })[1]);
        if (laterIntent === 'task-click') {
          const card = expectDefined(renderedTaskElements(h.center, newer.ref)[0]);
          card.dispatchEvent(new Event('pointerdown', { bubbles: true }));
          card.click();
          expect(h.state.get('taskStack')).toEqual([newer]);
        } else {
          h.state.set('selectedList', 'upcoming');
          h.state.set('taskStack', []);
        }
        const selection = h.state.get('taskStack');
        held.resolve();
        await flushMicrotasks();
        await flushMicrotasks();
        expect(h.index.list({ filePath: 'created.md' })).toHaveLength(1);
        if (origin !== 'list') expect(present.mock.calls[0]?.[2]).toBeUndefined();
        expect(h.state.get('taskStack')).toEqual(selection);
        const title = h.root.querySelector('.abyss-right .abyss-right-title-view');
        if (laterIntent === 'task-click') expect(title?.textContent).toBe(newer.title);
        else expect(title).toBeNull();
        expect(h.root.querySelector('.abyss-creation-feedback')?.textContent).toContain('added');
        expect(h.root.querySelector('.is-just-created')).toBeNull();
        expect(legacyScroll).not.toHaveBeenCalled();
      } finally {
        held.resolve();
        await h.dispose();
      }
    },
  );

  it.each(['blur', 'escape'] as const)(
    'keeps a %s-during-submit result scoped after its controller closes',
    async (cause) => {
      const h = await mountQuickPanel();
      const write = deferred<void>(),
        writing = deferred<void>();
      const outside = document.body.createEl('input');
      try {
        const plan = h.tasks.planCreate.bind(h.tasks);
        vi.spyOn(h.tasks, 'planCreate').mockImplementation(async (intent) => {
          const session = await plan(intent);
          if (session.type !== 'ready') return session;
          return {
            ...session,
            execute: async (request) => {
              writing.resolve();
              await write.promise;
              return session.execute(request);
            },
          };
        });
        let currentAtResult: boolean | undefined;
        const present = h.presentation.present.bind(h.presentation);
        vi.spyOn(h.presentation, 'present').mockImplementation((result, description, authority) => {
          currentAtResult = authority?.isCurrent();
          present(result, description, authority);
        });
        const input = await h.openQ();
        enter(input, 'Z created Q');
        await writing.promise;
        if (cause === 'blur') outside.focus();
        else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        write.resolve();
        await flushMicrotasks();
        expect(h.index.list({ filePath: 'created.md' })).toHaveLength(1);
        expect(h.state.get('taskStack')).toEqual(h.index.list({ filePath: 'created.md' }));
        expect(currentAtResult).toBe(false);
        expect(h.root.querySelector('.is-just-created')).toBeNull();
        expect(h.root.querySelector('.abyss-quick-capture-host .abyss-capture-input')).toBeNull();
        expect(document.activeElement).toBe(cause === 'blur' ? outside : h.center);
        expect(legacyScroll).not.toHaveBeenCalled();
      } finally {
        write.resolve();
        outside.remove();
        await h.dispose();
      }
    },
  );

  it('retains the opening surface across destination resolution and keeps revoked results scoped', async () => {
    const h = await mountQuickPanel();
    const destination = deferred<void>();
    try {
      const plan = h.tasks.planCreate.bind(h.tasks);
      vi.spyOn(h.tasks, 'planCreate').mockImplementation(async (intent) => {
        await destination.promise;
        return plan(intent);
      });
      const chrome = h.center;
      chrome.tabIndex = -1;
      chrome.focus();
      chrome.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', bubbles: true, cancelable: true }),
      );
      h.state.set('selectedList', 'upcoming');
      destination.resolve();
      await flushMicrotasks();
      const input = expectDefined(
        h.root.querySelector<HTMLInputElement>('.abyss-quick-capture-host .abyss-capture-input'),
      );
      let currentAtResult: boolean | undefined;
      const present = h.presentation.present.bind(h.presentation);
      vi.spyOn(h.presentation, 'present').mockImplementation((result, description, authority) => {
        currentAtResult = authority?.isCurrent();
        present(result, description, authority);
      });
      enter(input, 'Z created Q');
      await flushMicrotasks();
      expect(h.index.list({ filePath: 'created.md' })).toHaveLength(1);
      expect(currentAtResult).toBe(false);
      expect(h.state.get('selectedList')).toBe('upcoming');
      expect(h.root.querySelector('.is-just-created')).toBeNull();
      expect(legacyScroll).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(input);
    } finally {
      destination.resolve();
      await h.dispose();
    }
  });

  it('waits for exact hydration and current mounted Markdown without changing the focused Q input', async () => {
    const h = await mountQuickPanel(false, false, true);
    const hydration = deferred<void>(),
      markdown = deferred<void>();
    const entered = deferred<void>(),
      rendered = deferred<void>();
    try {
      h.query('needle');
      await searchUiCompleted(h.center);
      const actual = h.index.resolveSearchHits.bind(h.index);
      vi.spyOn(h.index, 'resolveSearchHits').mockImplementation(async (hits, signal) => {
        const created = h.source.files().find((file) => file.path === 'created.md');
        if (
          created !== undefined &&
          hits.some((hit) =>
            [...h.source.nodes(created)].some((node) => node.rootId === hit.address.rootId),
          )
        ) {
          entered.resolve();
          await hydration.promise;
        }
        return actual(hits, signal);
      });
      vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, text, holder) => {
        holder.createEl('strong', { text });
        if (text.includes('Z created Q needle')) {
          rendered.resolve();
          await markdown.promise;
        }
      });
      let request: CreationRevealRequest | undefined;
      const present = h.presentation.present.bind(h.presentation);
      vi.spyOn(h.presentation, 'present').mockImplementation((result, description, authority) => {
        if (authority !== undefined) {
          const reveal = authority.reveal.bind(authority);
          vi.spyOn(authority, 'reveal').mockImplementation((ref, next) => {
            request = next;
            return reveal(ref, next);
          });
        }
        present(result, description, authority);
      });
      const input = await h.openQ();
      enter(input, '**Z created Q needle**');
      await vi.waitFor(() => {
        expect(request).toBeDefined();
      });
      await entered.promise;
      const reveal = vi.spyOn(expectDefined(h.panel['taskSurface_abyssPrivate']).surface, 'reveal');
      expect(h.root.querySelector('.is-just-created')).toBeNull();
      expect(reveal).not.toHaveBeenCalled();
      hydration.resolve();
      await rendered.promise;
      expect(h.root.querySelector('.is-just-created')).toBeNull();
      expect(reveal).not.toHaveBeenCalled();
      markdown.resolve();
      await vi.waitFor(() => {
        expect(h.root.querySelector('.is-just-created')).not.toBeNull();
      });
      const created = expectDefined(h.index.list({ filePath: 'created.md' })[0]);
      expect(renderedTaskElements(h.root, created.ref)).toContain(
        h.root.querySelector('.is-just-created'),
      );
      expect(reveal.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(reveal.mock.calls.length).toBeLessThanOrEqual(8);
      expect(h.root.querySelectorAll('.abyss-task-card').length).toBeLessThanOrEqual(
        taskCardMountBound(h.root, 1),
      );
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe('');
      expect(legacyScroll).not.toHaveBeenCalled();
    } finally {
      hydration.resolve();
      markdown.resolve();
      await h.dispose();
    }
  });

  it.each(
    (['hydration', 'markdown'] as const).flatMap((stage) =>
      revealRevocations.map((reason) => ({ stage, reason })),
    ),
  )('revokes the full Q $stage wait on $reason', async ({ stage, reason }) => {
    const h = await mountQuickPanel(false, false, true);
    const hydration = deferred<void>(),
      markdown = deferred<void>();
    const entered = deferred<void>(),
      rendered = deferred<void>();
    let request: CreationRevealRequest | undefined;
    try {
      h.query('needle');
      await searchUiCompleted(h.center);
      const actual = h.index.resolveSearchHits.bind(h.index);
      vi.spyOn(h.index, 'resolveSearchHits').mockImplementation(async (hits, signal) => {
        const created = h.source.files().find((file) => file.path === 'created.md');
        if (
          created !== undefined &&
          hits.some((hit) =>
            [...h.source.nodes(created)].some((node) => node.rootId === hit.address.rootId),
          )
        ) {
          entered.resolve();
          await hydration.promise;
        }
        return actual(hits, signal);
      });
      vi.spyOn(MarkdownRenderer, 'render').mockImplementation(async (_app, text, holder) => {
        holder.createEl('strong', { text });
        if (text.includes('Z created Q needle')) {
          rendered.resolve();
          await markdown.promise;
        }
      });
      const present = h.presentation.present.bind(h.presentation);
      vi.spyOn(h.presentation, 'present').mockImplementation((result, description, authority) => {
        if (authority !== undefined) {
          const reveal = authority.reveal.bind(authority);
          vi.spyOn(authority, 'reveal').mockImplementation((ref, next) => {
            request = next;
            return reveal(ref, next);
          });
        }
        present(result, description, authority);
      });
      const input = await h.openQ();
      enter(input, '**Z created Q needle**');
      await vi.waitFor(() => {
        expect(request).toBeDefined();
      });
      await entered.promise;
      const reveal = vi.spyOn(expectDefined(h.panel['taskSurface_abyssPrivate']).surface, 'reveal');
      if (stage === 'markdown') {
        hydration.resolve();
        await rendered.promise;
      }
      const scroll = expectDefined(h.center.querySelector<HTMLElement>('.abyss-center-scroll'));
      const outside = document.body.createEl('input');
      revokeQuickReveal(h, input, reason, { scroll, outside });
      const active = document.activeElement;
      const top = scroll.scrollTop;
      if (reason !== 'scroll-before-event')
        await vi.waitFor(() => {
          expect(request?.signal.aborted).toBe(true);
        });
      hydration.resolve();
      markdown.resolve();
      await flushMicrotasks();
      await flushMicrotasks();
      if (reason === 'scroll-before-event') scroll.dispatchEvent(new Event('scroll'));
      expect(request?.signal.aborted).toBe(true);
      expect(reveal).not.toHaveBeenCalled();
      expect(h.root.querySelector('.is-just-created')).toBeNull();
      expect(h.panel['creationAttempts_abyssPrivate'].size).toBe(0);
      expect(document.activeElement).toBe(active);
      expect(scroll.scrollTop).toBe(top);
      if (reason === 'input') expect(input.value).toBe('new draft');
      const mounted = h.root.querySelectorAll('.abyss-task-card').length;
      if (reason === 'navigation') expect(mounted).toBe(0);
      else {
        expect(mounted).toBeGreaterThan(0);
        expect(mounted).toBeLessThanOrEqual(taskCardMountBound(h.root));
      }
      outside.remove();
    } finally {
      hydration.resolve();
      markdown.resolve();
      await h.dispose();
    }
  });
});
