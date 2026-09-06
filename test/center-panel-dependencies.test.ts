import { addIcon, Component, Notice, removeIcon, TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppState } from '../src/app/AppState';
import { CenterPanel } from '../src/panels/CenterPanel';
import { RightPanel } from '../src/panels/RightPanel';
import { DEFAULT_SETTINGS } from '../src/settings/defaults';
import { localDate, type TaskCommand, type TaskSnapshot } from '../src/tasks';
import { CalendarRenderer } from '../src/ui/CalendarRenderer';
import { createTaskCard } from '../src/ui/TaskCard';
import { presentTaskCommandResult } from '../src/ui/taskCommandResult';
import {
  calendarMutationTarget,
  calendarOccurrenceForRender,
  projectCalendarOccurrences,
  taskSnapshotForCalendarOccurrence,
} from '../src/views/calendarOccurrences';
import { ListView } from '../src/views/ListView';
import { MonthGridView } from '../src/views/MonthGridView';
import { renderAllDayCell } from '../src/views/timegrid/renderAllDay';
import { renderTimedBlocksForDay } from '../src/views/timegrid/renderTimedBlocks';
import {
  configuredTaskApplication,
  createAppWithFiles,
  expectDefined,
  flushMicrotasks,
  resolvedConfig,
  useRealMoment,
} from './helpers';

useRealMoment();
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  activeDocument.body.empty();
  vi.restoreAllMocks();
});

async function harness(markdown: string) {
  const app = await createAppWithFiles({ 'tasks.md': `\n${markdown}` });
  const { index, tasks, statusRegistry } = configuredTaskApplication(app, DEFAULT_SETTINGS, {
    authority: true,
  });
  await index.initialize();
  cleanups.push(() => {
    index.destroy();
  });
  const execute = vi.spyOn(tasks, 'execute');
  const messages: string[] = [];
  vi.spyOn(
    Notice.prototype as unknown as { constructor__(message: string | DocumentFragment): void },
    'constructor__',
  ).mockImplementation((message) => {
    messages.push(typeof message === 'string' ? message : message.textContent);
  });
  const node = (title: string) =>
    expectDefined(
      index.listNodes().find(({ node }) => node.title === title),
      `Missing ${title}`,
    );
  const state = new AppState();
  state.set('selectedList', 'inbox');
  const el = activeDocument.body.createDiv();
  const component = new Component();
  component.load();
  cleanups.push(() => {
    component.unload();
  });
  const send = async (command: TaskCommand) => {
    presentTaskCommandResult(await tasks.execute(command));
  };
  const callbacks = {
    app,
    component,
    statusRegistry,
    occurrenceFor: calendarOccurrenceForRender,
    dependenciesFor: (task: TaskSnapshot) => {
      const target = calendarMutationTarget(task);
      return target === undefined ? undefined : index.dependencies(target);
    },
    onToggle: async (task: TaskSnapshot) => {
      await send({
        type: 'toggle-completion',
        target: expectDefined(calendarMutationTarget(task)),
      });
    },
    onSetStatus: async (task: TaskSnapshot, symbol: string) => {
      await send({
        type: 'set-status',
        target: expectDefined(calendarMutationTarget(task)),
        symbol,
      });
    },
    onTaskClick: vi.fn(),
    onDrop: vi.fn(),
    onDayClick: vi.fn(),
    onDateClick: vi.fn(),
    onCreateAtDate: vi.fn(),
    onWeekClick: vi.fn(),
    onSetPriority: vi.fn(),
    onStartChange: vi.fn(),
    onDueChange: vi.fn(),
    onExtendToSpan: vi.fn(),
    onKeyboardIntent: vi.fn(),
    onTimeChange: vi.fn(),
    onDurationChange: vi.fn(),
    onContextMenu: vi.fn(),
    onOpenNote: vi.fn(),
  };
  const file = app.vault.getAbstractFileByPath('tasks.md');
  if (!(file instanceof TFile)) throw new Error('Missing fixture file');
  return {
    app,
    index,
    tasks,
    statusRegistry,
    execute,
    messages,
    state,
    el,
    component,
    callbacks,
    node,
    file,
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;
function mountCenter(h: Harness): CenterPanel {
  const panel = new CenterPanel(
    h.state,
    h.app,
    { ...DEFAULT_SETTINGS, inbox: { ...DEFAULT_SETTINGS.inbox, mode: 'untagged' } },
    h.index,
    h.statusRegistry,
    undefined,
    null,
    null,
    h.tasks,
  );
  panel.mount(h.el);
  cleanups.push(() => {
    panel.destroy();
  });
  return panel;
}
function mountInspector(h: Harness, title = 'Current'): RightPanel {
  const location = h.node(title);
  h.state.set('taskStack', [location.root, ...location.path]);
  const panel = new RightPanel(
    h.state,
    h.app,
    h.statusRegistry,
    DEFAULT_SETTINGS,
    undefined,
    h.tasks,
  );
  panel.mount(h.el);
  cleanups.push(() => {
    panel.destroy();
  });
  return panel;
}
function element(root: ParentNode, selector: string): HTMLElement {
  return expectDefined(root.querySelector<HTMLElement>(selector), `Missing ${selector}`);
}
function physicalActivation(control: HTMLElement, type: 'pointer' | 'touch'): void {
  const pointer = new Event('pointerdown', { bubbles: true, cancelable: true });
  Object.defineProperties(pointer, {
    pointerType: { value: type === 'touch' ? 'touch' : 'mouse' },
    button: { value: 0 },
    pointerId: { value: 1 },
  });
  control.dispatchEvent(pointer);
  if (type === 'touch')
    control.dispatchEvent(new Event('touchstart', { bubbles: true, cancelable: true }));
  control.dispatchEvent(new Event('pointerup', { bubbles: true, cancelable: true }));
  if (type === 'touch')
    control.dispatchEvent(new Event('touchend', { bubbles: true, cancelable: true }));
  // Even a browser's compatibility click (including detail=0 from touch/AT) must stay blocked.
  control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  control.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 0 }));
}

describe('center dependency indicator DOM', () => {
  it.each([
    { suffix: '', dependent: '', counts: [], type: 'none' },
    { suffix: ' ⛔ a', dependent: '', counts: ['1'], type: 'blocked-by' },
    {
      suffix: ' 🆔 current',
      dependent: '- [ ] Dependent ⛔ current\n',
      counts: ['1'],
      type: 'blocks',
    },
    {
      suffix: ' 🆔 current ⛔ a, b',
      dependent: '- [ ] Dependent ⛔ current\n',
      counts: ['2', '1'],
      type: 'both',
    },
  ])(
    'renders $type inline between checkbox and title without secondary copy',
    async ({ suffix, dependent, counts, type }) => {
      addIcon(
        'lock',
        '<svg><rect x="5" y="10" width="14" height="11"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/></svg>',
      );
      cleanups.push(() => {
        removeIcon('lock');
      });
      const h = await harness(
        `- [ ] Current${suffix}\n- [ ] Schema 🆔 a\n- [ ] Review 🆔 b\n${dependent}`,
      );
      mountCenter(h);
      const card = [...h.el.querySelectorAll<HTMLElement>('.abyss-task-card')].find(
        (row) => row.querySelector('.abyss-task-title')?.textContent === 'Current',
      );
      const row = element(expectDefined(card), '.abyss-task-card-main-row');
      const indicator = row.querySelector<HTMLElement>('.abyss-dep-indicator');
      if (type === 'none') {
        expect(indicator).toBeNull();
        expect(
          row.firstElementChild?.nextElementSibling?.classList.contains('abyss-task-body'),
        ).toBe(true);
      } else {
        const group = expectDefined(indicator);
        expect(group.previousElementSibling?.matches('[role="checkbox"]')).toBe(true);
        expect(group.nextElementSibling?.classList.contains('abyss-task-body')).toBe(true);
        expect(group.querySelectorAll('svg')).toHaveLength(1);
        expect(
          [...group.querySelectorAll('[data-dependency-count]')].map((count) => count.textContent),
        ).toEqual(counts);
        expect(group.firstElementChild?.getAttribute('data-dependency-direction')).toBe(
          type === 'blocks' ? 'blocks' : 'blocked-by',
        );
        expect(group.getAttribute('aria-label')).toContain('blocked by');
        expect(group.getAttribute('aria-label')).toContain('blocks');
        expect(group.title).toBe(group.getAttribute('aria-label'));
        expect(group.matches('button, [role="button"]')).toBe(false);
        expect(
          [...group.children].every((piece) => piece.getAttribute('aria-hidden') === 'true'),
        ).toBe(true);
        group.click();
        expect(h.state.get('taskStack')[0]?.title).toBe('Current');
      }
      expect(expectDefined(card).querySelector('.abyss-task-desc')).toBeNull();
    },
  );

  it('uses a slash between simultaneous center counts without reusing the inspector divider', async () => {
    const h = await harness(
      '- [ ] Current 🆔 current ⛔ a, b\n- [ ] Schema 🆔 a\n- [ ] Review 🆔 b\n- [ ] Dependent ⛔ current\n',
    );
    mountCenter(h);
    const card = [...h.el.querySelectorAll<HTMLElement>('.abyss-task-card')].find(
      (row) => row.querySelector('.abyss-task-title')?.textContent === 'Current',
    );
    const indicator = element(expectDefined(card), '.abyss-dep-indicator');

    expect(indicator.querySelector('.abyss-dep-indicator-divider')?.textContent).toBe('/');
    expect(indicator.querySelector('.abyss-dep-divider')).toBeNull();
    expect([...indicator.children].map((child) => child.textContent)).toEqual(['', '2', '/', '1']);
  });
});

const surfaceNames = [
  'center',
  'search',
  'month',
  'all-day',
  'deadline',
  'timed',
  'legacy-card',
  'list',
  'inspector',
  'inspector-subtask',
] as const;
type Surface = (typeof surfaceNames)[number];
function mountSurface(h: Harness, surface: Surface): HTMLElement {
  const task = h.node('Current').root;
  if (surface === 'center' || surface === 'search') {
    if (surface === 'search') {
      h.state.set('mode', 'search');
      h.state.set('searchQuery', 'Current');
    }
    mountCenter(h);
    return expectDefined(
      [...h.el.querySelectorAll<HTMLElement>('.abyss-task-card')].find(
        (row) => row.querySelector('.abyss-task-title')?.textContent === 'Current',
      ),
    );
  }
  if (surface === 'inspector' || surface === 'inspector-subtask') {
    mountInspector(h, surface === 'inspector-subtask' ? 'Parent' : 'Current');
    return element(
      h.el,
      surface === 'inspector' ? '.abyss-right-header' : '.abyss-subtask-section .abyss-subtask-row',
    );
  }
  return mountCalendarSurface(h, surface, task);
}

function mountCalendarSurface(
  h: Harness,
  surface: Exclude<Surface, 'center' | 'search' | 'inspector' | 'inspector-subtask'>,
  task: TaskSnapshot,
): HTMLElement {
  if (surface === 'legacy-card') {
    const card = createTaskCard(task, 'due', h.callbacks);
    h.el.append(card);
    return card;
  }
  if (surface === 'list' || surface === 'month') {
    const view = surface === 'list' ? new ListView(h.callbacks) : new MonthGridView(h.callbacks);
    view.render(h.el, [task], resolvedConfig({ startPosition: '2026-09' }));
    cleanups.push(() => {
      view.destroy();
    });
    return element(h.el, surface === 'list' ? '.abyss-list-task' : '.abyss-calendar-item');
  }
  if (surface === 'timed') {
    renderTimedBlocksForDay(h.el, [task], h.callbacks);
    return element(h.el, '.abyss-tg-block');
  }
  renderAllDayCell(
    h.el,
    '2026-09-05',
    [],
    surface === 'all-day' ? [task] : [],
    surface === 'deadline' ? [task] : [],
    h.callbacks,
  );
  return element(h.el, surface === 'all-day' ? '.abyss-tg-plain' : '.abyss-tg-deadline-marker');
}
function markdownFor(surface: Surface, duplicate = false): string {
  return `${surface === 'inspector-subtask' ? '- [ ] Parent\n  ' : ''}- [ ] Current ⛔ schema 📅 2026-09-05${surface === 'timed' ? ' ⏰ 10:00' : ''}\n- [ ] Write schema 🆔 schema\n${duplicate ? '- [x] Other schema 🆔 schema\n' : ''}`;
}

describe('strict dependency checkbox surfaces', () => {
  it('keeps search mounted when a blocked marker SVG receives the pointer click', async () => {
    const h = await harness(markdownFor('search'));
    const row = mountSurface(h, 'search');
    const marker = element(row, '.abyss-status-marker');
    const icon = marker.createSvg('svg');
    icon.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushMicrotasks();
    expect(h.state.get('mode')).toBe('search');
    expect(marker.isConnected).toBe(true);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.messages).toEqual([]);
  });

  it.each(['center', 'inspector', 'standalone'] as const)(
    '%s preserves recurrence deletion confirmation and then reports the application blocked result',
    async (surface) => {
      const h = await harness(
        '- [ ] Current ⛔ schema 🔁 tomorrow 🏁 delete 📅 2026-09-05\n- [ ] Write schema 🆔 schema\n',
      );
      expect(h.node('Current').node.onCompletion).toBe('delete');
      if (surface === 'standalone') {
        const renderer = new CalendarRenderer(
          h.el,
          resolvedConfig({ defaultView: 'month', startPosition: '2026-09' }),
          h.app,
          h.index,
          h.tasks,
          h.statusRegistry,
        );
        renderer.mount();
        cleanups.push(() => {
          renderer.destroy();
        });
      } else mountSurface(h, surface);
      const control = element(h.el, '[role="checkbox"]');
      control.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushMicrotasks();
      expect(h.execute).not.toHaveBeenCalled();
      element(activeDocument, '.abyss-recurrence-delete-confirm-button').click();
      await flushMicrotasks();
      expect(activeDocument.querySelector('.abyss-recurrence-delete-confirm')).toBeNull();
      expect(h.execute).toHaveBeenCalledTimes(1);
      expect(h.messages).toEqual(['Complete “Write schema” or remove the dependency first']);
    },
  );

  it.each(surfaceNames)(
    '$0 keeps satisfied and missing declarations completable',
    async (surface) => {
      const markdown = markdownFor(surface)
        .replace('⛔ schema', '⛔ schema, missing')
        .replace('- [ ] Write schema', '- [x] Write schema');
      const h = await harness(markdown);
      const row = mountSurface(h, surface);
      expect(row.querySelector('[aria-disabled="true"]')).toBeNull();
      expect(row.querySelector('.abyss-dep-indicator')).toBeNull();
      element(row, '[role="checkbox"]').click();
      await flushMicrotasks();
      expect(h.execute).toHaveBeenCalledTimes(1);
      expect(h.node('Current').node.status).toBe('done');
      expect(h.messages).toEqual([]);
    },
  );

  it.each(['today', 'week', 'month'] as const)(
    'refreshes CenterPanel %s calendar after the last blocker is removed',
    async (view) => {
      const h = await harness(markdownFor(view === 'month' ? 'center' : 'timed'));
      const panel = mountCenter(h);
      panel['calDate_abyssPrivate'] = window.moment('2026-09-05');
      panel['calViewType_abyssPrivate'] = view;
      h.state.set('mode', 'calendar');
      const indicator = element(h.el, '.abyss-dep-indicator');
      const control = expectDefined(indicator.previousElementSibling) as HTMLElement;
      expect(control.getAttribute('aria-disabled')).toBe('true');
      physicalActivation(control, 'touch');
      await flushMicrotasks();
      expect(h.execute).not.toHaveBeenCalled();
      await h.tasks.execute({
        type: 'remove-dependency',
        dependent: h.node('Current').target,
        dependencyId: 'schema',
      });
      await flushMicrotasks();
      expect(h.el.querySelector('.abyss-dep-indicator')).toBeNull();
      const enabled = element(h.el, '[role="checkbox"]');
      expect(enabled.getAttribute('aria-disabled')).not.toBe('true');
      h.execute.mockClear();
      enabled.click();
      await flushMicrotasks();
      expect(h.execute).toHaveBeenCalledTimes(1);
      expect(h.node('Current').node.status).toBe('done');
      expect(h.messages).toEqual([]);
    },
  );

  it.each(['month', 'all-day', 'deadline', 'timed', 'legacy-card', 'list'] as const)(
    '%s omits dependency queries and strict semantics for forecasts',
    async (surface) => {
      const h = await harness(
        '- [ ] Current ⛔ schema 🔁 every day 📅 2026-09-05 ⏰ 10:00\n- [ ] Write schema 🆔 schema\n',
      );
      const range = { from: localDate('2026-09-06'), to: localDate('2026-09-06') };
      const projection = projectCalendarOccurrences(
        h.index.forCalendarProjection([range.from]),
        range,
        { removeScheduledDate: false },
      );
      const forecast = taskSnapshotForCalendarOccurrence(
        expectDefined(projection.occurrences.find((occurrence) => occurrence.kind === 'forecast')),
      );
      const query = vi.spyOn(h.callbacks, 'dependenciesFor');
      const row = mountCalendarSurface(h, surface, forecast);
      expect(calendarMutationTarget(forecast)).toBeUndefined();
      expect(row.querySelector('.abyss-dep-indicator')).toBeNull();
      expect(row.querySelector('[aria-disabled="true"]')).toBeNull();
      expect(row.querySelector('[role="checkbox"]')).toBeNull();
      expect(query).not.toHaveBeenCalled();
      row.querySelector<HTMLElement>('.abyss-status-marker')?.click();
      await flushMicrotasks();
      expect(h.execute).not.toHaveBeenCalled();
    },
  );

  it.each(['month', 'all-day', 'deadline', 'timed', 'legacy-card', 'list'] as const)(
    '%s uses a materialized subtask endpoint instead of its root',
    async (surface) => {
      const h = await harness(
        '- [ ] Parent\n  - [ ] Current ⛔ schema 📅 2026-09-05 ⏰ 10:00\n- [ ] Write schema 🆔 schema\n',
      );
      const source = h.node('Current');
      const child = taskSnapshotForCalendarOccurrence({
        kind: 'materialized',
        key: 'indexed-child',
        source,
        planning: source.node.planning,
        recurring: false,
      });
      const row = mountCalendarSurface(h, surface, child);
      const control = element(row, '[role="checkbox"]');
      expect(control.getAttribute('aria-disabled')).toBe('true');
      physicalActivation(control, 'pointer');
      await flushMicrotasks();
      expect(h.execute).not.toHaveBeenCalled();
      control.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await flushMicrotasks();
      expect(h.execute).toHaveBeenCalledExactlyOnceWith({
        type: 'toggle-completion',
        target: h.node('Current').target,
      });
      expect(h.messages).toEqual(['Complete “Write schema” or remove the dependency first']);
    },
  );

  it.each(
    surfaceNames.flatMap((surface) =>
      (['pointer', 'touch'] as const).map((activation) => ({ surface, activation })),
    ),
  )(
    '$surface suppresses $activation and synthesized clicks before dispatch',
    async ({ surface, activation }) => {
      const h = await harness(markdownFor(surface, true));
      const row = mountSurface(h, surface);
      const marker = element(row, '.abyss-status-marker');
      const before = await h.app.vault.read(h.file);
      physicalActivation(marker, activation);
      await flushMicrotasks();
      expect(h.execute).not.toHaveBeenCalled();
      expect(h.messages).toEqual([]);
      expect(await h.app.vault.read(h.file)).toBe(before);
      const wrapper = marker.parentElement;
      expect(wrapper?.classList.contains('abyss-status-control')).toBe(true);
      expect(wrapper?.getAttribute('aria-disabled')).toBe('true');
      expect(wrapper?.getAttribute('role')).toBe('checkbox');
      expect(wrapper?.tabIndex).toBe(0);
      expect(wrapper?.title).toMatch(/prerequisite.*remove.*dependenc/iu);
      wrapper?.focus();
      expect(activeDocument.activeElement).toBe(wrapper);
      physicalActivation(expectDefined(wrapper), activation);
      await flushMicrotasks();
      expect(h.execute).not.toHaveBeenCalled();
      if (!surface.startsWith('inspector')) {
        const indicator = element(row, '.abyss-dep-indicator');
        expect(indicator.previousElementSibling).toBe(wrapper);
      }
    },
  );

  it('keyboard completion and each menu completion status report one deterministic blocked Notice', async () => {
    const h = await harness(markdownFor('center'));
    const row = mountSurface(h, 'center');
    const control = element(row, '[role="checkbox"]');
    control.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.messages).toEqual(['Complete “Write schema” or remove the dependency first']);
    for (const title of ['Done', 'Cancelled']) {
      control.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      const choice = expectDefined(
        [...activeDocument.querySelectorAll<HTMLElement>('.abyss-status-popover-row')].find(
          (row) => row.textContent === title,
        ),
      );
      expect(choice.getAttribute('aria-disabled')).not.toBe('true');
      choice.click();
      await flushMicrotasks();
      expect(h.messages[h.messages.length - 1]).toBe(
        'Complete “Write schema” or remove the dependency first',
      );
    }
    expect(h.execute).toHaveBeenCalledTimes(3);
    expect(h.messages).toHaveLength(3);
    control.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const progress = expectDefined(
      [...activeDocument.querySelectorAll<HTMLElement>('.abyss-status-popover-row')].find(
        (row) => row.textContent === 'In progress',
      ),
    );
    progress.click();
    await flushMicrotasks();
    expect(h.node('Current').node.statusSymbol).toBe('/');
    expect(h.messages).toHaveLength(3);
  });

  it('retains inspector checkbox focus when a reconciled counterpart becomes active', async () => {
    const h = await harness('- [ ] Current ⛔ schema\n- [x] Write schema 🆔 schema\n');
    mountInspector(h);
    const marker = element(h.el, '.abyss-right-header [role="checkbox"]');
    const title = element(h.el, '.abyss-right-title');
    marker.focus();
    expect(marker.ownerDocument.activeElement).toBe(marker);
    await h.tasks.execute({
      type: 'set-status',
      target: h.node('Write schema').target,
      symbol: ' ',
    });
    await flushMicrotasks();
    const wrapper = element(h.el, '.abyss-right-header [role="checkbox"]');
    expect(wrapper.getAttribute('aria-disabled')).toBe('true');
    expect(marker.ownerDocument.activeElement).toBe(wrapper);
    expect(wrapper.firstElementChild).toBe(marker);
    expect(element(h.el, '.abyss-right-title')).toBe(title);
    h.execute.mockClear();
    physicalActivation(marker, 'pointer');
    physicalActivation(wrapper, 'touch');
    await flushMicrotasks();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.messages).toEqual([]);
    wrapper.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    wrapper.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', repeat: true }));
    await flushMicrotasks();
    expect(h.execute).toHaveBeenCalledExactlyOnceWith({
      type: 'toggle-completion',
      target: h.node('Current').target,
    });
    expect(h.messages).toEqual(['Complete “Write schema” or remove the dependency first']);
  });

  it('refreshes the inspector checkbox when a counterpart is satisfied, retaining mounted title draft', async () => {
    const h = await harness(markdownFor('inspector'));
    mountInspector(h);
    const before = element(h.el, '.abyss-right-header [role="checkbox"]');
    expect(before.getAttribute('aria-disabled')).toBe('true');
    const title = element(h.el, '.abyss-right-title');
    before.focus();
    await h.tasks.execute({
      type: 'set-status',
      target: h.node('Write schema').target,
      symbol: 'x',
    });
    await flushMicrotasks();
    const control = element(h.el, '.abyss-right-header [role="checkbox"]');
    expect(control.getAttribute('aria-disabled')).not.toBe('true');
    expect(activeDocument.activeElement).toBe(control);
    expect(element(h.el, '.abyss-right-title')).toBe(title);
    h.execute.mockClear();
    control.click();
    await flushMicrotasks();
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.node('Current').node.status).toBe('done');
    expect(h.messages).toEqual([]);
  });

  it.each(['month', 'week', 'list'] as const)(
    'wires dependency queries through standalone CalendarRenderer %s',
    async (defaultView) => {
      const h = await harness(markdownFor('center'));
      const renderer = new CalendarRenderer(
        h.el,
        resolvedConfig({
          defaultView,
          startPosition: defaultView === 'week' ? '2026-08-31' : '2026-09',
        }),
        h.app,
        h.index,
        h.tasks,
        h.statusRegistry,
      );
      renderer.mount();
      cleanups.push(() => {
        renderer.destroy();
      });
      const indicator = element(h.el, '.abyss-dep-indicator');
      const control = expectDefined(indicator.previousElementSibling) as HTMLElement;
      expect(control.getAttribute('aria-disabled')).toBe('true');
      physicalActivation(control, 'touch');
      await flushMicrotasks();
      expect(h.execute).not.toHaveBeenCalled();
      await h.tasks.execute({
        type: 'set-status',
        target: h.node('Write schema').target,
        symbol: 'x',
      });
      await flushMicrotasks();
      expect(h.el.querySelector('.abyss-dep-indicator')).toBeNull();
      const enabled = element(h.el, '[role="checkbox"]');
      expect(enabled.getAttribute('aria-disabled')).not.toBe('true');
      h.execute.mockClear();
      enabled.click();
      await flushMicrotasks();
      expect(h.execute).toHaveBeenCalledTimes(1);
      expect(h.node('Current').node.status).toBe('done');
      expect(h.messages).toEqual([]);
    },
  );

  it.each([
    { ids: 'schema', expected: 'Complete “Write schema” or remove the dependency first' },
    {
      ids: 'schema, duplicate',
      expected: 'Complete “Write schema” or remove the dependency first (+1 more)',
    },
    {
      ids: 'schema, duplicate, third',
      expected: 'Complete “Write schema” or remove the dependency first (+2 more)',
    },
    {
      ids: 'duplicate',
      expected: 'Resolve duplicate dependency ID “duplicate” or remove the dependency first',
    },
    {
      ids: 'duplicate, schema, third',
      expected:
        'Resolve duplicate dependency ID “duplicate” or remove the dependency first (+2 more)',
    },
  ])('uses the first declared active blocker for $ids', async ({ ids, expected }) => {
    const h = await harness(
      `- [ ] Current ⛔ missing, ${ids}\n- [ ] Write schema 🆔 schema\n- [ ] Arbitrary first candidate 🆔 duplicate\n- [x] Arbitrary second candidate 🆔 duplicate\n- [ ] Third 🆔 third\n`,
    );
    const result = await h.tasks.execute({
      type: 'toggle-completion',
      target: h.node('Current').target,
    });
    expect(result.type).toBe('blocked');
    presentTaskCommandResult(result);
    expect(h.messages).toEqual([expected]);
  });
});
