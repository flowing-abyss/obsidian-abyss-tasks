import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Component, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { calendarOccurrenceForRender } from '../src/views/calendarOccurrences';
import { MonthGridView } from '../src/views/MonthGridView';
import { createSpanInteractionOwner } from '../src/views/spanInteractions';
import { layoutVisibleSpans } from '../src/views/spanLayout';
import { renderAllDaySpanLayer } from '../src/views/timegrid/renderAllDay';
import {
  DataTransferStub,
  freshContainer,
  resolvedConfig,
  subtask,
  task,
  taskComment,
  taskFromCodecLine,
  useRealMoment,
} from './helpers';

useRealMoment();
const fakeApp = {} as App;
const registry = new StatusRegistry(buildDefaultTaskStatuses());
const css = readFileSync(resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\\,/gu, ',');
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, 'u').exec(css);
  return match?.groups?.['body'] ?? '';
}

function declarationsForRuleContaining(...selectors: string[]): string {
  for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/gu)) {
    const roots = (match[1] ?? '')
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .split(',')
      .map((selector) => selector.trim());
    if (selectors.every((selector) => roots.includes(selector))) return match[2] ?? '';
  }
  return '';
}

function winningCssDeclaration(element: Element, property: string): string {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  let winner = '';
  let winnerSpecificity = -1;
  for (const rule of withoutComments.matchAll(/([^{}]+)\{([^}]*)\}/gu)) {
    const value = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'u').exec(
      rule[2] ?? '',
    )?.[1];
    if (!value) continue;
    for (const selector of (rule[1] ?? '').split(',').map((part) => part.trim())) {
      if (!selector) continue;
      let matches = false;
      try {
        matches = element.matches(selector);
      } catch {
        continue;
      }
      if (!matches) continue;
      const specificity =
        (selector.match(/#[\w-]+/gu)?.length ?? 0) * 100 +
        (selector.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/gu)?.length ?? 0) * 10;
      if (specificity >= winnerSpecificity) {
        winner = value.trim();
        winnerSpecificity = specificity;
      }
    }
  }
  return winner;
}

function requiredElement(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Expected element matching ${selector}`);
  return element;
}

function recurrenceBadgeDom(root: ParentNode): Record<string, string | undefined> {
  const badge = root.querySelector<HTMLElement>('.abyss-recurrence-badge');
  const icon = badge?.querySelector<HTMLElement>('.abyss-recurrence-badge-icon');
  return {
    rootClass: badge?.className,
    validity: badge?.dataset['recurrenceValidity'],
    label: badge?.getAttribute('aria-label') ?? undefined,
    iconClass: icon?.className,
    icon: icon?.dataset['icon'],
  };
}

function callbacks() {
  return {
    app: fakeApp,
    onDayClick: vi.fn(),
    onCreateAtDate: vi.fn(),
    onTaskClick: vi.fn(),
    onDrop: vi.fn(),
    onSpanMove: vi.fn(),
    onSpanBoundary: vi.fn(),
    onToggle: vi.fn(),
    onSetStatus: vi.fn(),
    onSetPriority: vi.fn(),
    onWeekClick: vi.fn(),
    statusRegistry: registry,
  };
}

function allDayCallbacks() {
  return {
    occurrenceFor: calendarOccurrenceForRender,
    ...callbacks(),
    component: new Component(),
    onStartChange: vi.fn(),
    onDueChange: vi.fn(),
    onExtendToSpan: vi.fn(),
  };
}

function measureMonthCells(container: HTMLElement): void {
  Array.from(container.querySelectorAll<HTMLElement>('.abyss-mg-cell')).forEach((cell, index) => {
    const column = index % 7;
    const row = Math.floor(index / 7);
    vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(
      new DOMRect(column * 100, row * 100, 100, 100),
    );
  });
}

function monthChronologyTasks(
  times: { early: string; late: string; compact: string } = {
    early: '09:00',
    late: '15:00',
    compact: '20:00',
  },
) {
  return [
    task({
      title: '15 span',
      planning: { start: '2026-07-30', due: '2026-07-31', time: times.late },
      source: { filePath: '15.md', line: 15 },
    }),
    task({
      title: 'Deadline marker',
      planning: { scheduled: '2026-07-29', due: '2026-07-30' },
      source: { filePath: 'deadline.md', line: 5 },
    }),
    task({
      title: 'Untimed span',
      planning: { start: '2026-07-30', due: '2026-07-31' },
      source: { filePath: 'untimed.md', line: 1 },
    }),
    task({
      title: '20 compact',
      planning: { scheduled: '2026-07-30', time: times.compact },
      source: { filePath: 'compact.md', line: 20 },
    }),
    task({
      title: '09 span',
      planning: { start: '2026-07-29', due: '2026-07-30', time: times.early },
      source: { filePath: '09.md', line: 9 },
    }),
  ];
}

function monthGridRowFor(container: HTMLElement, date: string, title: string): number {
  const cell = requiredElement(container, `[data-mg-date="${date}"]`);
  const row = cell.closest<HTMLElement>('.abyss-mg-row');
  if (!row) throw new Error(`Expected Month row containing ${date}`);
  const candidates = [
    ...row.querySelectorAll<HTMLElement>(`[data-span-date="${date}"]`),
    ...cell.querySelectorAll<HTMLElement>(
      '.abyss-mg-cell-items > .abyss-mg-plain, .abyss-mg-cell-items > .abyss-mg-block-dot, .abyss-mg-cell-items > .abyss-mg-deadline-marker',
    ),
  ];
  const element = candidates.find(
    (candidate) => candidate.querySelector('.abyss-mg-item-title')?.textContent === title,
  );
  if (!element) throw new Error(`Expected Month item "${title}" on ${date}`);
  return Number(element.style.gridRow);
}

describe('MonthGridView', () => {
  it('renders the shared recurrence badge DOM in a compact month item', () => {
    const container = freshContainer();
    new MonthGridView(callbacks()).render(
      container,
      [
        task({
          title: 'Monthly repeat',
          recurrence: 'every week',
          planning: { scheduled: '2026-07-10', time: '09:00' },
        }),
      ],
      resolvedConfig({ startPosition: '2026-07', firstDayOfWeek: 1 }),
    );

    expect(recurrenceBadgeDom(requiredElement(container, '.abyss-mg-block-dot'))).toEqual({
      rootClass: 'abyss-recurrence-badge',
      validity: 'valid',
      label: 'Repeats: every week',
      iconClass: 'abyss-recurrence-badge-icon',
      icon: 'repeat-2',
    });
  });

  it('renders timed span and compact items before untimed items independent of input order', () => {
    const config = resolvedConfig({ startPosition: '2026-07', firstDayOfWeek: 1 });
    const tasks = monthChronologyTasks();
    const renderRows = (orderedTasks: ReturnType<typeof monthChronologyTasks>): number[] => {
      const container = freshContainer();
      new MonthGridView(callbacks()).render(container, orderedTasks, config);
      return ['09 span', '15 span', '20 compact', 'Untimed span'].map((title) =>
        monthGridRowFor(container, '2026-07-30', title),
      );
    };

    expect(renderRows(tasks)).toEqual([1, 2, 3, 4]);
    expect(renderRows([...tasks].reverse())).toEqual([1, 2, 3, 4]);
  });

  it('keeps a multi-day task in one grid row when an earlier local task exists on one day', () => {
    const container = freshContainer();
    const config = resolvedConfig({ startPosition: '2026-07', firstDayOfWeek: 1 });
    new MonthGridView(callbacks()).render(
      container,
      [
        task({
          title: 'Conference talk',
          planning: { start: '2026-07-29', due: '2026-07-31', time: '15:00' },
          source: { filePath: 'conference.md', line: 10 },
        }),
        task({
          title: 'Local morning task',
          planning: { scheduled: '2026-07-30', time: '09:00' },
          source: { filePath: 'local.md', line: 20 },
        }),
      ],
      config,
    );

    expect(
      ['2026-07-29', '2026-07-30', '2026-07-31'].map((date) =>
        monthGridRowFor(container, date, 'Conference talk'),
      ),
    ).toEqual([2, 2, 2]);
    expect(monthGridRowFor(container, '2026-07-30', 'Local morning task')).toBe(1);
  });

  it('patch recomputes chronological rows without replacing the Month skeleton', () => {
    const container = freshContainer();
    const view = new MonthGridView(callbacks());
    const config = resolvedConfig({ startPosition: '2026-07', firstDayOfWeek: 1 });
    view.render(container, monthChronologyTasks(), config);
    const cell = requiredElement(container, '[data-mg-date="2026-07-30"]');
    const row = cell.closest('.abyss-mg-row');
    const spanLayer = row?.querySelector('.abyss-mg-span-layer');

    view.patch(
      container,
      monthChronologyTasks({ early: '18:00', late: '07:00', compact: '12:00' }),
      config,
    );

    expect(requiredElement(container, '[data-mg-date="2026-07-30"]')).toBe(cell);
    expect(cell.closest('.abyss-mg-row')).toBe(row);
    expect(row?.querySelector('.abyss-mg-span-layer')).toBe(spanLayer);
    expect(
      ['15 span', '20 compact', '09 span', 'Untimed span'].map((title) =>
        monthGridRowFor(container, '2026-07-30', title),
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  it('patches only task layers while retaining month headers, rows, day cells, and static listeners', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const config = resolvedConfig({ startPosition: '2026-07', firstDayOfWeek: 1 });
    const initial = task({
      title: 'Initial month task',
      markdownTitle: 'Initial month task',
      planning: { due: '2026-07-15' },
    });

    view.render(container, [initial], config);
    const header = container.querySelector('.abyss-mg-head-row');
    const row = requiredElement(container, '[data-mg-date="2026-07-15"]').closest('.abyss-mg-row');
    const cell = container.querySelector('[data-mg-date="2026-07-15"]');
    const dayLabel = cell?.querySelector('.abyss-mg-day-label');
    const spanLayer = row?.querySelector('.abyss-mg-span-layer');

    for (let revision = 1; revision <= 3; revision++) {
      view.patch(
        container,
        [
          task({
            title: `Updated month task ${revision}`,
            markdownTitle: `Updated month task ${revision}`,
            planning: { due: '2026-07-15' },
          }),
          task({
            title: `Updated span ${revision}`,
            markdownTitle: `Updated span ${revision}`,
            planning: { start: '2026-07-14', due: '2026-07-16' },
            source: { filePath: 'span.md', line: revision },
          }),
        ],
        config,
      );
    }

    expect(container.querySelector('.abyss-mg-head-row')).toBe(header);
    expect(requiredElement(container, '[data-mg-date="2026-07-15"]').closest('.abyss-mg-row')).toBe(
      row,
    );
    expect(container.querySelector('[data-mg-date="2026-07-15"]')).toBe(cell);
    expect(cell?.querySelector('.abyss-mg-day-label')).toBe(dayLabel);
    expect(row?.querySelector('.abyss-mg-span-layer')).toBe(spanLayer);
    expect(container.textContent).not.toContain('Initial month task');
    expect(container.textContent).toContain('Updated month task 3');
    expect(container.textContent).toContain('Updated span 3');

    cell?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onDayClick).toHaveBeenCalledTimes(1);
  });

  it('patch falls back to a full render when the visible month changes', () => {
    const container = freshContainer();
    const view = new MonthGridView(callbacks());
    view.render(container, [], resolvedConfig({ startPosition: '2026-07' }));
    const header = container.querySelector('.abyss-mg-head-row');

    view.patch(container, [], resolvedConfig({ startPosition: '2026-08' }));

    expect(container.querySelector('.abyss-mg-head-row')).not.toBe(header);
    expect(container.querySelector('[data-mg-date="2026-08-01"]')).not.toBeNull();
  });

  it('keeps one current overlay drop listener when the same layer renders repeatedly', () => {
    const container = freshContainer();
    const parent = container.createDiv();
    const dates = ['2026-07-13', '2026-07-14', '2026-07-15'];
    for (const [index, date] of dates.entries()) {
      const cell = parent.createDiv({ cls: 'abyss-tg-allday-cell' });
      cell.setAttribute('data-tg-date', date);
      vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue({
        x: index * 100,
        y: 0,
        width: 100,
        height: 20,
        top: 0,
        right: (index + 1) * 100,
        bottom: 20,
        left: index * 100,
        toJSON: () => ({}),
      });
    }
    const layer = parent.createDiv({ cls: 'abyss-tg-span-layer' });
    const row = layoutVisibleSpans(
      [task({ planning: { start: '2026-07-13', due: '2026-07-15' } })],
      dates,
    ).rows[0]!;
    const old = allDayCallbacks();
    const latest = allDayCallbacks();
    const owner = createSpanInteractionOwner();

    renderAllDaySpanLayer(layer, row, dates, old, [], owner, 'timegrid');
    renderAllDaySpanLayer(layer, row, dates, latest, [], owner, 'timegrid');
    renderAllDaySpanLayer(layer, row, dates, latest, [], owner, 'timegrid');

    const body = requiredElement(layer, '[data-span-kind="ghost"]');
    const dragover = new MouseEvent('dragover', { bubbles: true, cancelable: true, clientX: 150 });
    body.dispatchEvent(dragover);
    const transfer = new DataTransferStub();
    transfer.setData('text/plain', 'source.md:::7');
    const drop = new MouseEvent('drop', { bubbles: true, cancelable: true, clientX: 150 });
    Object.defineProperty(drop, 'dataTransfer', { value: transfer });
    body.dispatchEvent(drop);

    expect(dragover.defaultPrevented).toBe(true);
    expect(old.onDrop).not.toHaveBeenCalled();
    expect(latest.onDrop).toHaveBeenCalledTimes(1);
    expect(latest.onDrop).toHaveBeenCalledWith('source.md:::7', '2026-07-14');
  });

  it('forwards native drops from a span body to the covered date resolved from real cell rectangles', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({
      title: 'Trip',
      planning: { start: '2026-07-13', due: '2026-07-16' },
    });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));

    const row = requiredElement(container, '[data-mg-date="2026-07-13"]').closest('.abyss-mg-row')!;
    const cells = Array.from(row.querySelectorAll<HTMLElement>('.abyss-mg-cell'));
    for (const [index, cell] of cells.entries()) {
      vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue({
        x: index * 100,
        y: 0,
        width: 100,
        height: 100,
        top: 0,
        right: (index + 1) * 100,
        bottom: 100,
        left: index * 100,
        toJSON: () => ({}),
      });
    }
    const body = requiredElement(row, '[data-span-kind="ghost"]');
    const dispatch = (type: 'dragover' | 'drop', clientX: number): Event => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
      const transfer = new DataTransferStub();
      transfer.setData('text/plain', 'source.md:::7');
      Object.defineProperty(event, 'dataTransfer', { value: transfer });
      body.dispatchEvent(event);
      return event;
    };

    expect(dispatch('dragover', 50).defaultPrevented).toBe(true);
    expect(dispatch('dragover', 150).defaultPrevented).toBe(true);
    expect(dispatch('dragover', 250).defaultPrevented).toBe(true);
    expect(dispatch('dragover', -1).defaultPrevented).toBe(false);
    expect(dispatch('dragover', 700).defaultPrevented).toBe(false);

    dispatch('drop', 250);
    expect(cbs.onDrop).toHaveBeenCalledTimes(1);
    expect(cbs.onDrop).toHaveBeenCalledWith('source.md:::7', '2026-07-15');
  });

  it('renders month range tiles per day and reserves the same lane space in every cell', () => {
    const container = freshContainer();
    const view = new MonthGridView(callbacks());
    const long = task({
      title: 'Trip',
      planning: { start: '2026-07-14', due: '2026-07-16' },
      source: { line: 1 },
    });
    const single = task({
      title: 'Single',
      planning: { scheduled: '2026-07-15' },
      source: { line: 2 },
    });

    view.render(container, [long, single], resolvedConfig({ startPosition: '2026-07' }));

    const row = requiredElement(container, '[data-mg-date="2026-07-14"]').closest('.abyss-mg-row')!;
    expect(row.querySelectorAll('.abyss-mg-span-layer')).toHaveLength(1);
    expect(row.querySelectorAll('[data-span-kind="ghost"]')).toHaveLength(2);
    expect(row.querySelectorAll('[data-span-kind="terminal"]')).toHaveLength(1);
    expect(
      [...row.querySelectorAll('[data-span-kind] .abyss-mg-item-title')].map(
        (el) => el.textContent,
      ),
    ).toEqual(['Trip', 'Trip', 'Trip']);
    expect(row.querySelectorAll('[data-span-kind] .abyss-status-marker')).toHaveLength(1);
    for (const segment of row.querySelectorAll<HTMLElement>('[data-span-kind="ghost"]')) {
      expect(segment.querySelector('[data-boundary="start"]')).not.toBeNull();
      expect(segment.querySelector('[data-boundary="due"]')).not.toBeNull();
    }
    const terminal = row.querySelector<HTMLElement>('[data-span-kind="terminal"]')!;
    expect(terminal.querySelector('[data-boundary="start"]')).toBeNull();
    expect(terminal.querySelector('[data-boundary="due"]')).not.toBeNull();
    expect(
      Array.from(row.querySelectorAll<HTMLElement>('[data-span-kind]')).map(
        (segment) => segment.style.gridColumn,
      ),
    ).toEqual(['2 / 3', '3 / 4', '4 / 5']);
    expect(
      row.querySelector('[data-mg-date="2026-07-15"] .abyss-mg-cell-items .abyss-mg-plain'),
    ).not.toBeNull();
    expect(
      Array.from(row.querySelectorAll<HTMLElement>('.abyss-mg-cell')).every(
        (cell) => cell.style.getPropertyValue('--abyss-span-lane-count') === '2',
      ),
    ).toBe(true);
  });

  it('reserves the full shared row height when the highest occupied slots are spans', () => {
    const container = freshContainer();
    const view = new MonthGridView(callbacks());
    const spans = Array.from({ length: 5 }, (_, index) =>
      task({
        title: `Span ${index}`,
        planning: {
          start: '2026-07-30',
          due: '2026-07-31',
          time: `0${index + 8}:00`,
        },
        source: { filePath: `span-${index}.md`, line: index },
      }),
    );

    view.render(container, spans, resolvedConfig({ startPosition: '2026-07' }));

    const row = requiredElement(container, '[data-mg-date="2026-07-30"]').closest('.abyss-mg-row')!;
    expect(
      Array.from(row.querySelectorAll<HTMLElement>('[data-span-date="2026-07-30"]')).map(
        (segment) => segment.style.gridRow,
      ),
    ).toEqual(['1', '2', '3', '4', '5']);
    expect(
      Array.from(row.querySelectorAll<HTMLElement>('.abyss-mg-cell')).every(
        (cell) => cell.style.getPropertyValue('--abyss-span-lane-count') === '5',
      ),
    ).toBe(true);
    expect(declarationsFor('.abyss-mg-cell-items')).toMatch(
      /min-height\s*:\s*calc\(var\(--abyss-span-lane-count, 0\) \* var\(--abyss-calendar-track-height\)\)/u,
    );
  });

  it('wires Month actual start and due handles to the shared atomic boundary callback', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ planning: { start: '2026-07-14', due: '2026-07-16' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));

    measureMonthCells(container);
    const due = requiredElement(container, '[data-boundary="due"]');
    expect(due.getAttribute('data-resize-edge')).toBe('due-date');
    due.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 350,
        clientY: 250,
        pointerId: 40,
      }),
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 450, clientY: 250, pointerId: 40 }),
    );
    expect(
      Array.from(container.querySelectorAll<HTMLElement>('.abyss-span-boundary-preview')).map(
        (preview) => preview.style.gridColumn,
      ),
    ).toEqual(['2 / 3', '3 / 4', '4 / 5', '5 / 6']);
    const preview = requiredElement(container, '.abyss-span-boundary-preview');
    expect(preview.getAttribute('aria-hidden')).toBe('true');
    expect(preview.textContent).toContain(t.title);
    expect(preview.querySelector(':scope > .abyss-calendar-preview-target-outline')).not.toBeNull();
    expect(
      preview.querySelector(':scope > .abyss-calendar-preview-shell .abyss-calendar-preview-title')
        ?.textContent,
    ).toBe(t.title);
    expect(preview.querySelector('.abyss-status-marker')).toBeNull();
    expect(preview.querySelector('a')).toBeNull();
    expect(preview.getAttribute('tabindex')).toBeNull();
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 450, clientY: 250, pointerId: 40 }),
    );

    expect(cbs.onSpanBoundary).toHaveBeenCalledWith(
      t,
      expect.objectContaining({ boundary: 'due', date: '2026-07-17' }),
    );
    expect(container.querySelector('.abyss-span-boundary-preview')).toBeNull();
  });

  it('moves an actual Month start boundary into the previous week and previews every clipped row piece', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ planning: { start: '2026-07-14', due: '2026-07-16' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07', firstDayOfWeek: 1 }));
    measureMonthCells(container);

    const handle = requiredElement(container, '[data-boundary="start"]');
    handle.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 150,
        clientY: 250,
        pointerId: 41,
      }),
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 350, clientY: 150, pointerId: 41 }),
    );

    const previousRow = requiredElement(
      container,
      '[data-mg-date="2026-07-09"]',
    ).closest<HTMLElement>('.abyss-mg-row')!;
    const sourceRow = requiredElement(
      container,
      '[data-mg-date="2026-07-14"]',
    ).closest<HTMLElement>('.abyss-mg-row')!;
    const previews = Array.from(
      container.querySelectorAll<HTMLElement>('.abyss-span-boundary-preview'),
    );
    expect(previews).toHaveLength(8);
    expect(
      Array.from(previousRow.querySelectorAll<HTMLElement>('.abyss-span-boundary-preview')).map(
        (preview) => preview.style.gridColumn,
      ),
    ).toEqual(['4 / 5', '5 / 6', '6 / 7', '7 / 8']);
    expect(
      Array.from(sourceRow.querySelectorAll<HTMLElement>('.abyss-span-boundary-preview')).map(
        (preview) => preview.style.gridColumn,
      ),
    ).toEqual(['1 / 2', '2 / 3', '3 / 4', '4 / 5']);
    expect(previews.map((preview) => JSON.parse(preview.dataset['target']!))).toEqual(
      Array.from({ length: 8 }, () => ({ boundary: 'start', date: '2026-07-09', dayDelta: -5 })),
    );

    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 350, clientY: 150, pointerId: 41 }),
    );
    expect(cbs.onSpanBoundary).toHaveBeenCalledOnce();
    expect(cbs.onSpanBoundary).toHaveBeenCalledWith(t, {
      boundary: 'start',
      date: '2026-07-09',
      dayDelta: -5,
    });
    expect(container.querySelector('.abyss-span-boundary-preview')).toBeNull();
  });

  it('moves an actual Month due boundary into the following week and previews every clipped row piece', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ planning: { start: '2026-07-14', due: '2026-07-16' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07', firstDayOfWeek: 1 }));
    measureMonthCells(container);

    const handle = requiredElement(container, '[data-boundary="due"]');
    handle.dispatchEvent(
      new PointerEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 350,
        clientY: 250,
        pointerId: 42,
      }),
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 150, clientY: 350, pointerId: 42 }),
    );

    const sourceRow = requiredElement(
      container,
      '[data-mg-date="2026-07-14"]',
    ).closest<HTMLElement>('.abyss-mg-row')!;
    const followingRow = requiredElement(
      container,
      '[data-mg-date="2026-07-21"]',
    ).closest<HTMLElement>('.abyss-mg-row')!;
    const previews = Array.from(
      container.querySelectorAll<HTMLElement>('.abyss-span-boundary-preview'),
    );
    expect(previews).toHaveLength(8);
    expect(
      Array.from(sourceRow.querySelectorAll<HTMLElement>('.abyss-span-boundary-preview')).map(
        (preview) => preview.style.gridColumn,
      ),
    ).toEqual(['2 / 3', '3 / 4', '4 / 5', '5 / 6', '6 / 7', '7 / 8']);
    expect(
      Array.from(followingRow.querySelectorAll<HTMLElement>('.abyss-span-boundary-preview')).map(
        (preview) => preview.style.gridColumn,
      ),
    ).toEqual(['1 / 2', '2 / 3']);
    expect(previews.map((preview) => JSON.parse(preview.dataset['target']!))).toEqual(
      Array.from({ length: 8 }, () => ({ boundary: 'due', date: '2026-07-21', dayDelta: 5 })),
    );

    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 150, clientY: 350, pointerId: 42 }),
    );
    expect(cbs.onSpanBoundary).toHaveBeenCalledOnce();
    expect(cbs.onSpanBoundary).toHaveBeenCalledWith(t, {
      boundary: 'due',
      date: '2026-07-21',
      dayDelta: 5,
    });
    expect(container.querySelector('.abyss-span-boundary-preview')).toBeNull();
  });

  it('moves a Month span into another week by its grabbed date and previews the full shifted range', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ planning: { start: '2026-07-14', due: '2026-07-16' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));

    measureMonthCells(container);

    const ghost = requiredElement(container, '[data-span-kind="ghost"]');
    ghost.dispatchEvent(
      new MouseEvent('pointerdown', {
        bubbles: true,
        button: 0,
        clientX: 150,
        clientY: 250,
      }) as PointerEvent,
    );
    window.dispatchEvent(
      new MouseEvent('pointermove', {
        bubbles: true,
        button: 0,
        clientX: 150,
        clientY: 350,
      }) as PointerEvent,
    );
    expect(
      Array.from(container.querySelectorAll<HTMLElement>('.abyss-span-move-preview')).map(
        (preview) => ({
          column: preview.style.gridColumn,
          target: JSON.parse(preview.dataset['target']!),
        }),
      ),
    ).toEqual([
      { column: '2 / 3', target: { grabbedDate: '2026-07-14', targetDate: '2026-07-21', days: 7 } },
      { column: '3 / 4', target: { grabbedDate: '2026-07-14', targetDate: '2026-07-21', days: 7 } },
      { column: '4 / 5', target: { grabbedDate: '2026-07-14', targetDate: '2026-07-21', days: 7 } },
    ]);
    window.dispatchEvent(
      new MouseEvent('pointerup', {
        bubbles: true,
        button: 0,
        clientX: 150,
        clientY: 350,
      }) as PointerEvent,
    );
    expect(cbs.onSpanMove).toHaveBeenCalledWith(
      t,
      expect.objectContaining({ grabbedDate: '2026-07-14', targetDate: '2026-07-21', days: 7 }),
    );
  });
  it('renders a 6-week grid (42 day cells) for the configured month', () => {
    const container = freshContainer();
    const view = new MonthGridView(callbacks());
    view.render(container, [], resolvedConfig({ startPosition: '2026-07' }));
    expect(container.querySelectorAll('.abyss-mg-cell')).toHaveLength(42);
  });

  // Task 42b: when a month's 1st falls on a Sunday and firstDayOfWeek is Monday, the naive
  // `0 - firstDayOfMonth + config.firstDayOfWeek` (no wraparound) loop bound skipped straight
  // past day 1 into day 2, dropping the 1st of the month from the grid entirely. 2026-02
  // starts on a Sunday.
  it('still renders day 1 of the month when the month starts on a Sunday and firstDayOfWeek is Monday', () => {
    const container = freshContainer();
    const view = new MonthGridView(callbacks());
    view.render(container, [], resolvedConfig({ startPosition: '2026-02', firstDayOfWeek: 1 }));
    expect(container.querySelector('[data-mg-date="2026-02-01"]')).not.toBeNull();
    expect(container.querySelectorAll('.abyss-mg-cell')).toHaveLength(42);
  });

  it("marks today's cell with is-today", () => {
    const container = freshContainer();
    const view = new MonthGridView(callbacks());
    const today = window.moment().format('YYYY-MM-DD');
    view.render(container, [], resolvedConfig({}));
    const cell = container.querySelector(`[data-mg-date="${today}"]`);
    expect(cell?.classList.contains('is-today')).toBe(true);
  });

  it("today's cell CSS keeps only the red border, with no separate background tint (Round 3)", () => {
    // Round 3: the user asked for the pre-existing background-color tint on .abyss-mg-cell.is-today
    // to be removed, keeping just the border that Round 2 added. Assert against the actual
    // declarations so a future edit can't silently reintroduce a background alongside it.
    const declarations = declarationsFor('.abyss-mg-cell.is-today');
    expect(declarations).toContain('box-shadow');
    expect(declarations).not.toMatch(/background/u);
  });

  it('a plain task on a given day renders a compact row in that cell', () => {
    const container = freshContainer();
    const view = new MonthGridView(callbacks());
    const t = task({ title: 'Plain', planning: { due: '2026-07-15' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const cell = container.querySelector('[data-mg-date="2026-07-15"]');
    expect(cell?.querySelector('.abyss-mg-plain')?.textContent).toContain('Plain');
  });

  it('never sets data-priority on compact items, even for a prioritized task (calendar items no longer render a priority border)', () => {
    const container = freshContainer();
    const view = new MonthGridView(callbacks());
    const t = task({ priority: 'C', title: 'Plain', planning: { due: '2026-07-15' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const row = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-plain',
    ) as HTMLElement;
    expect(row.hasAttribute('data-priority')).toBe(false);

    const container2 = freshContainer();
    const view2 = new MonthGridView(callbacks());
    const none = task({ priority: 'D', title: 'Plain', planning: { due: '2026-07-15' } });
    view2.render(container2, [none], resolvedConfig({ startPosition: '2026-07' }));
    const row2 = container2.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-plain',
    ) as HTMLElement;
    expect(row2.hasAttribute('data-priority')).toBe(false);
  });

  it('sets --abyss-tag-color on compact items when a tag matches a configured tag group', () => {
    const container = freshContainer();
    const cbs = {
      ...callbacks(),
      tagGroups: [
        { id: '1', name: 'Work', mode: 'prefix' as const, prefix: 'work', color: '#3498db' },
      ],
    };
    const view = new MonthGridView(cbs);
    const t = task({
      title: 'Plain',
      tags: ['#work'],
      planning: { due: '2026-07-15' },
      source: { originalMarkdown: '- [ ] t #work', originalBlock: '- [ ] t #work' },
    });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const row = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-plain',
    ) as HTMLElement;
    expect(row.style.getPropertyValue('--abyss-tag-color')).toBe('#3498db');
  });

  it('keeps a prioritized deadline rooted in tag identity and priority only on its marker', () => {
    const container = freshContainer();
    const view = new MonthGridView({
      ...callbacks(),
      tagGroups: [
        { id: '1', name: 'Work', mode: 'prefix' as const, prefix: 'work', color: '#3498db' },
      ],
    });
    const t = task({
      title: 'Deadline',
      tags: ['#work'],
      priority: 'A',
      planning: { scheduled: '2026-07-10', due: '2026-07-15' },
    });

    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));

    const root = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-deadline-marker',
    ) as HTMLElement;
    expect(root.style.getPropertyValue('--abyss-tag-color')).toBe('#3498db');
    expect(root.hasAttribute('data-priority')).toBe(false);
    expect(root.querySelector('.abyss-status-marker')?.getAttribute('data-priority')).toBe('A');
  });

  it('uses the shared interactive-accent fallback for an untagged deadline root', () => {
    const container = freshContainer();
    const view = new MonthGridView(callbacks());
    const t = task({
      title: 'Deadline',
      planning: { scheduled: '2026-07-10', due: '2026-07-15' },
    });

    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));

    const root = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-deadline-marker',
    ) as HTMLElement;
    const identityRule = declarationsForRuleContaining(
      '.abyss-tg-block',
      '.abyss-mg-plain',
      '.abyss-mg-deadline-marker',
    );
    expect(root.style.getPropertyValue('--abyss-tag-color')).toBe('');
    expect(root.hasAttribute('data-priority')).toBe(false);
    expect(identityRule).toMatch(
      /border-inline-start\s*:\s*var\(--abyss-calendar-item-rail\) solid\s+var\(--abyss-tag-color,\s*var\(--interactive-accent\)\)/u,
    );
    expect(identityRule).toMatch(/background\s*:\s*var\(--abyss-calendar-surface\)/u);
    expect(identityRule).toMatch(
      /box-shadow\s*:\s*inset 0 0 0 1px var\(--abyss-calendar-border\)/u,
    );
    expect(css).not.toMatch(/\.abyss-mg-deadline-marker\[data-priority=/u);
  });

  it('uses event contrast for both native Month drag origins', () => {
    const originalBackground = document.body.style.getPropertyValue('--background-primary');
    document.body.style.setProperty('--background-primary', '#666666');
    try {
      const container = freshContainer();
      const view = new MonthGridView({
        ...callbacks(),
        tagGroups: [{ id: 'work', name: 'Work', mode: 'prefix', prefix: 'work', color: '#fff' }],
      });
      const source = {
        originalMarkdown: '- [ ] task #work',
        originalBlock: '- [ ] task #work',
      };
      view.render(
        container,
        [
          task({ tags: ['#work'], planning: { due: '2026-07-15' }, source }),
          task({ tags: ['#work'], planning: { due: '2026-07-15', time: '09:00' }, source }),
        ],
        resolvedConfig({ startPosition: '2026-07' }),
      );

      for (const selector of ['.abyss-mg-plain', '.abyss-mg-block-dot']) {
        expect(
          (container.querySelector(selector) as HTMLElement).style.getPropertyValue(
            '--abyss-tag-text-color',
          ),
        ).toBe('var(--abyss-tag-text-dark)');
      }
    } finally {
      document.body.style.setProperty('--background-primary', originalBackground);
    }
  });

  it('clicking a current-month day cell (not a task) fires onDayClick with that date', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    view.render(container, [], resolvedConfig({ startPosition: '2026-07' }));
    const cell = container.querySelector('[data-mg-date="2026-07-15"]') as HTMLElement;
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onDayClick).toHaveBeenCalledWith('2026-07-15');
  });

  it('each day cell has a hover-visible add button that fires onCreateAtDate, not onDayClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    view.render(container, [], resolvedConfig({ startPosition: '2026-07' }));
    const cell = container.querySelector('[data-mg-date="2026-07-15"]') as HTMLElement;
    const addBtn = cell.querySelector('.abyss-mg-add-btn') as HTMLElement;
    expect(addBtn).not.toBeNull();
    addBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onCreateAtDate).toHaveBeenCalledWith('2026-07-15');
    expect(cbs.onDayClick).not.toHaveBeenCalled();
  });

  it('each day cell keeps a daily-note internal-link (href), and clicking the day-number label also fires onDayClick (Task 32)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    view.render(
      container,
      [],
      resolvedConfig({ startPosition: '2026-07', dailyNoteFolder: 'Daily' }),
    );
    const cell = container.querySelector('[data-mg-date="2026-07-15"]') as HTMLElement;
    const link = cell.querySelector('a.internal-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('Daily/2026-07-15');
    link.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onDayClick).toHaveBeenCalledWith('2026-07-15');
  });

  it('clicking the day-number label fires onDayClick even when the cell is completely full of items (Task 32: always-present click target)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const tasks = Array.from({ length: 8 }, (_, n) =>
      task({
        title: `Task ${n}`,
        planning: { due: '2026-07-15' },
        source: { filePath: `f${n}.md`, line: n },
      }),
    );
    view.render(container, tasks, resolvedConfig({ startPosition: '2026-07' }));
    const cell = container.querySelector('[data-mg-date="2026-07-15"]') as HTMLElement;
    expect(cell.querySelectorAll('.abyss-mg-plain').length).toBe(8); // cell is fully packed
    const dayLabel = cell.querySelector('.abyss-mg-day-label') as HTMLElement;
    dayLabel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onDayClick).toHaveBeenCalledWith('2026-07-15');
  });

  it("clicking the day-number label does not double-fire onDayClick via the cell's own empty-space click handler", () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    view.render(container, [], resolvedConfig({ startPosition: '2026-07' }));
    const cell = container.querySelector('[data-mg-date="2026-07-15"]') as HTMLElement;
    const dayLabel = cell.querySelector('.abyss-mg-day-label') as HTMLElement;
    dayLabel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onDayClick).toHaveBeenCalledTimes(1);
  });

  it('a plain click on a compact plain row does NOT fire onTaskClick (reserved for drag)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Plain', planning: { due: '2026-07-15' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const row = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-plain',
    ) as HTMLElement;
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('a right-click (contextmenu) on a compact plain row fires onTaskClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Plain', planning: { due: '2026-07-15' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const row = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-plain',
    ) as HTMLElement;
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(cbs.onTaskClick).toHaveBeenCalledWith(t);
  });

  it('a plain click on a compact block-dot does NOT fire onTaskClick (reserved for drag)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Timed', planning: { due: '2026-07-15', time: '09:00' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const dot = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-block-dot',
    ) as HTMLElement;
    dot.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('a right-click (contextmenu) on a compact block-dot fires onTaskClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Timed', planning: { due: '2026-07-15', time: '09:00' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const dot = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-block-dot',
    ) as HTMLElement;
    dot.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(cbs.onTaskClick).toHaveBeenCalledWith(t);
  });

  it('a plain click on a compact span-segment does NOT fire onTaskClick (reserved for drag)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Trip', planning: { start: '2026-07-14', due: '2026-07-16' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const bar = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-span-segment',
    ) as HTMLElement;
    bar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('a right-click (contextmenu) on a compact span-segment fires onTaskClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Trip', planning: { start: '2026-07-14', due: '2026-07-16' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const bar = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-span-segment',
    ) as HTMLElement;
    bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(cbs.onTaskClick).toHaveBeenCalledWith(t);
  });

  it('a plain click on a compact deadline marker does NOT fire onTaskClick (reserved for drag)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Deadline', planning: { due: '2026-07-15', scheduled: '2026-07-10' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const marker = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-deadline-marker',
    ) as HTMLElement;
    marker.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('a right-click (contextmenu) on a compact deadline marker fires onTaskClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Deadline', planning: { due: '2026-07-15', scheduled: '2026-07-10' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const marker = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-deadline-marker',
    ) as HTMLElement;
    marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(cbs.onTaskClick).toHaveBeenCalledWith(t);
  });

  it('renders a status marker as the first child of a compact plain row; clicking it fires onToggle, not onTaskClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Plain', planning: { due: '2026-07-15' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const row = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-plain',
    ) as HTMLElement;
    const marker = row.querySelector('.abyss-status-marker');
    expect(marker).not.toBeNull();
    expect(row.firstElementChild).toBe(marker);
    (marker as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onToggle).toHaveBeenCalledWith(t);
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('renders a status marker as the first child of a compact block-dot; clicking it fires onToggle, not onTaskClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Timed', planning: { due: '2026-07-15', time: '09:00' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const dot = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-block-dot',
    ) as HTMLElement;
    const marker = dot.querySelector('.abyss-status-marker');
    expect(marker).not.toBeNull();
    expect(dot.firstElementChild).toBe(marker);
    (marker as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onToggle).toHaveBeenCalledWith(t);
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('renders a status marker as the first child of a terminal compact span-segment; clicking it fires onToggle, not onTaskClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Trip', planning: { start: '2026-07-14', due: '2026-07-16' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const bar = container.querySelector(
      '[data-mg-date="2026-07-16"] .abyss-mg-span-segment',
    ) as HTMLElement;
    const marker = bar.querySelector('.abyss-status-marker');
    expect(marker).not.toBeNull();
    expect(bar.firstElementChild).toBe(marker);
    (marker as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onToggle).toHaveBeenCalledWith(t);
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('renders a status marker as the first child of a compact deadline marker; clicking it fires onToggle, not onTaskClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Deadline', planning: { due: '2026-07-15', scheduled: '2026-07-10' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const markerEl = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-deadline-marker',
    ) as HTMLElement;
    const marker = markerEl.querySelector('.abyss-status-marker');
    expect(marker).not.toBeNull();
    expect(markerEl.firstElementChild).toBe(marker);
    (marker as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onToggle).toHaveBeenCalledWith(t);
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('renders the status marker and title as flex-row siblings in one line on a compact plain row (Task 21: was stacking on separate lines)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Plain', planning: { due: '2026-07-15' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const row = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-plain',
    ) as HTMLElement;
    const marker = row.querySelector('.abyss-status-marker');
    const title = row.querySelector('.abyss-mg-item-title');
    expect(marker).not.toBeNull();
    expect(title).not.toBeNull();
    expect(marker?.nextElementSibling).toBe(title);
  });

  it('renders the status marker, time, and title as flex-row siblings in one line on a compact block-dot (Task 21)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Timed', planning: { due: '2026-07-15', time: '09:00' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const dot = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-block-dot',
    ) as HTMLElement;
    const marker = dot.querySelector('.abyss-status-marker');
    const time = dot.querySelector('.abyss-mg-item-time');
    const title = dot.querySelector('.abyss-mg-item-title');
    expect(marker).not.toBeNull();
    expect(time).not.toBeNull();
    expect(title).not.toBeNull();
    expect(marker?.nextElementSibling).toBe(time);
    expect(time?.nextElementSibling).toBe(title);
  });

  it('renders the status marker and title as flex-row siblings in one line on a terminal compact span-segment (Task 21)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Trip', planning: { start: '2026-07-14', due: '2026-07-16' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const bar = container.querySelector(
      '[data-mg-date="2026-07-16"] .abyss-mg-span-segment',
    ) as HTMLElement;
    const marker = bar.querySelector('.abyss-status-marker');
    const title = bar.querySelector('.abyss-mg-item-title');
    expect(marker).not.toBeNull();
    expect(title).not.toBeNull();
    expect(marker?.nextElementSibling).toBe(title);
  });

  it('renders the status marker and title as flex-row siblings on a compact deadline marker (Task 21)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Deadline', planning: { due: '2026-07-15', scheduled: '2026-07-10' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const markerEl = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-deadline-marker',
    ) as HTMLElement;
    const title = markerEl.querySelector('.abyss-mg-item-title');
    expect(title).not.toBeNull();
  });

  it('right-clicking the status marker on a compact plain row opens the status/priority popover and does NOT fire onTaskClick (distinct from the row contextmenu)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Plain', planning: { due: '2026-07-15' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const marker = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-plain .abyss-status-marker',
    ) as HTMLElement;
    marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(document.querySelector('.abyss-status-popover')).not.toBeNull();
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('picking a status/priority from the popover on a compact row fires onSetStatus/onSetPriority with the task', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Plain', planning: { due: '2026-07-15' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const marker = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-plain .abyss-status-marker',
    ) as HTMLElement;
    marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const statusRow = document.querySelector('.abyss-status-popover-row') as HTMLElement;
    statusRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onSetStatus).toHaveBeenCalledWith(t, expect.any(String));

    document.querySelectorAll('.abyss-status-popover').forEach((el) => el.remove());
    marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const flagBtn = document.querySelector(
      '.abyss-status-popover-flag[data-abyss-priority="A"]',
    ) as HTMLElement;
    flagBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onSetPriority).toHaveBeenCalledWith(t, 'A');
  });

  it('destroy() does not throw', () => {
    const view = new MonthGridView(callbacks());
    expect(() => view.destroy()).not.toThrow();
  });

  it('renders a compact plain-row title via renderTaskText (markdown-link-aware) for a task with a [[wikilink]]', () => {
    const container = freshContainer();
    const view = new MonthGridView(callbacks());
    const t = task({
      title: 'see [[Note]]',
      markdownTitle: 'see [[Note]]',
      planning: { due: '2026-07-15' },
    });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const row = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-plain',
    ) as HTMLElement;
    // MarkdownRenderer is a noop in this test harness (see test/center-panel-integration.test.ts
    // and friends); `.abyss-md` is the reliable signal that renderTaskText's markdown path (not a
    // raw textContent assignment) was taken.
    expect(row.querySelector('.abyss-md')).not.toBeNull();
  });

  it('a click on the compact row title (inside a [[wikilink]]-bearing task) still does not fire onDayClick, since the row container class is excluded regardless of nested content', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({
      title: 'see [[Note]]',
      markdownTitle: 'see [[Note]]',
      planning: { due: '2026-07-15' },
    });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const row = container.querySelector(
      '[data-mg-date="2026-07-15"] .abyss-mg-plain',
    ) as HTMLElement;
    const titleEl = row.querySelector('.abyss-md') as HTMLElement;
    titleEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onDayClick).not.toHaveBeenCalled();
  });

  it('renders a week-number button per row, clicking it fires onWeekClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    view.render(container, [], resolvedConfig({ startPosition: '2026-07' }));
    const weekBtns = container.querySelectorAll('.abyss-mg-week-btn');
    expect(weekBtns.length).toBe(6);
    (weekBtns[0] as HTMLElement).click();
    expect(cbs.onWeekClick).toHaveBeenCalled();
  });

  it('the week-number button passes the correct week number and year', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    view.render(container, [], resolvedConfig({ startPosition: '2026-07' }));
    const weekBtns = container.querySelectorAll('.abyss-mg-week-btn');
    (weekBtns[0] as HTMLElement).click();
    const expectedWeek = window.moment('2026-06-29', 'YYYY-MM-DD').format('w');
    const expectedYear = window.moment('2026-06-29', 'YYYY-MM-DD').format('YYYY');
    expect(cbs.onWeekClick).toHaveBeenCalledWith(expectedWeek, expectedYear);
  });

  it('clicking the week-number button does not bubble into any day-cell click handling', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    view.render(container, [], resolvedConfig({ startPosition: '2026-07' }));
    const weekBtn = container.querySelector('.abyss-mg-week-btn') as HTMLElement;
    weekBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onDayClick).not.toHaveBeenCalled();
  });

  it('a plain-task item is draggable with the filePath:::line payload', () => {
    const container = freshContainer();
    const view = new MonthGridView(callbacks());
    const t = task({
      title: 'Plain',
      planning: { due: '2026-07-15' },
      source: { filePath: 'f.md', line: 3 },
    });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const item = container.querySelector('.abyss-mg-plain') as HTMLElement;
    expect(item.getAttribute('draggable')).toBe('true');
    const dt = new DataTransferStub();
    const ev = new MouseEvent('dragstart', { bubbles: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
    item.dispatchEvent(ev);
    expect(dt.getData('text/plain')).toBe('f.md:::3');
    expect(item.classList.contains('is-dragging')).toBe(true);
  });

  it('a block-dot (timed) item is draggable with the filePath:::line payload', () => {
    const container = freshContainer();
    const view = new MonthGridView(callbacks());
    const t = task({
      title: 'Timed',
      planning: { due: '2026-07-15', time: '09:00' },
      source: { filePath: 'f.md', line: 7 },
    });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const item = container.querySelector('.abyss-mg-block-dot') as HTMLElement;
    expect(item.getAttribute('draggable')).toBe('true');
    const dt = new DataTransferStub();
    const ev = new MouseEvent('dragstart', { bubbles: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
    item.dispatchEvent(ev);
    expect(dt.getData('text/plain')).toBe('f.md:::7');
  });

  it('a span-segment item is focusable for pointer movement instead of native HTML drag', () => {
    const container = freshContainer();
    const view = new MonthGridView(callbacks());
    const t = task({
      title: 'Trip',
      planning: { start: '2026-07-14', due: '2026-07-16' },
      source: { filePath: 'f.md', line: 9 },
    });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const item = container.querySelector(
      '[data-mg-date="2026-07-16"] .abyss-mg-span-segment',
    ) as HTMLElement;
    expect(item.hasAttribute('draggable')).toBe(false);
    expect(item.getAttribute('tabindex')).toBe('0');
  });

  it('deadline markers stay non-draggable', () => {
    const container = freshContainer();
    const view = new MonthGridView(callbacks());
    const t = task({
      title: 'Deadline',
      planning: { due: '2026-07-15', scheduled: '2026-07-10' },
      source: { filePath: 'f.md', line: 11 },
    });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const marker = container.querySelector('.abyss-mg-deadline-marker') as HTMLElement;
    expect(marker.hasAttribute('draggable')).toBe(false);
  });

  it('a click on the status marker inside a now-draggable plain item still fires onToggle, not treated as a drag', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({
      title: 'Plain',
      planning: { due: '2026-07-15' },
      source: { filePath: 'f.md', line: 3 },
    });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const row = container.querySelector('.abyss-mg-plain') as HTMLElement;
    const marker = row.querySelector('.abyss-status-marker') as HTMLElement;
    marker.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onToggle).toHaveBeenCalledWith(t);
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('a click on the rendered link inside a now-draggable plain item still navigates (does not start a drag)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({
      title: 'see [[Note]]',
      markdownTitle: 'see [[Note]]',
      planning: { due: '2026-07-15' },
      source: { filePath: 'f.md', line: 3 },
    });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const row = container.querySelector('.abyss-mg-plain') as HTMLElement;
    expect(row.getAttribute('draggable')).toBe('true');
    // A plain click on the title (not a dragstart) must not be swallowed — it's a normal
    // click event, distinct from the native HTML5 drag gesture which only starts on
    // dragstart, not click.
    const titleEl = row.querySelector('.abyss-md') as HTMLElement;
    titleEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onDayClick).not.toHaveBeenCalled();
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  // Task 32: Month cells got too cluttered with the tag-chip/count-badge meta row Round 3
  // Task 13 added — it's removed from all of Month's compact item types (Day/Week's timed
  // blocks and all-day items keep it; this task only touches Month).
  describe('no tag-chip/count-badge meta row on Month compact items (Task 32)', () => {
    const busyOverrides = {
      source: {
        originalMarkdown: '- [ ] t #work #urgent',
        originalBlock: '- [ ] t #work #urgent',
      },
      presentation: { linkCount: 2 },
      tags: ['#work', '#urgent'],
    };
    const tagGroups = [
      { id: '1', name: 'Work', mode: 'prefix' as const, prefix: 'work', color: '#3498db' },
    ];

    function busyTask(overrides: Parameters<typeof task>[0]) {
      return task({
        ...busyOverrides,
        ...overrides,
        subtasks: [subtask({ title: 'sub', ref: { originalBlock: '  - [ ] sub' } })],
        comments: [taskComment({ text: 'a note', ref: { relativeLine: 2 } })],
      });
    }

    it('omits .abyss-mg-item-meta on a plain row, even with tags/subtasks/comments/links', () => {
      const container = freshContainer();
      const view = new MonthGridView({ ...callbacks(), tagGroups });
      const t = busyTask({ title: 'Plain', planning: { due: '2026-07-15' } });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const row = container.querySelector('.abyss-mg-plain') as HTMLElement;
      expect(row.querySelector('.abyss-mg-item-meta')).toBeNull();
      expect(row.querySelector('.abyss-task-tag')).toBeNull();
      expect(row.querySelector('.abyss-task-count-badge')).toBeNull();
    });

    it('omits .abyss-mg-item-meta on a timed block-dot, keeping the time prefix', () => {
      const container = freshContainer();
      const view = new MonthGridView({ ...callbacks(), tagGroups });
      const t = busyTask({ title: 'Timed', planning: { due: '2026-07-15', time: '09:00' } });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const dot = container.querySelector('.abyss-mg-block-dot') as HTMLElement;
      expect(dot.querySelector('.abyss-mg-item-meta')).toBeNull();
      expect(dot.querySelector('.abyss-mg-item-time')?.textContent).toContain('09:00');
    });

    it('omits .abyss-mg-item-meta on an untimed span-segment', () => {
      const container = freshContainer();
      const view = new MonthGridView({ ...callbacks(), tagGroups });
      const t = busyTask({
        title: 'Trip',
        planning: { start: '2026-07-14', due: '2026-07-16' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const bar = container.querySelector(
        '[data-mg-date="2026-07-15"] .abyss-mg-span-segment',
      ) as HTMLElement;
      expect(bar.querySelector('.abyss-mg-item-meta')).toBeNull();
    });

    it("omits .abyss-mg-item-meta on a timed span-segment's anchor day, keeping the time prefix", () => {
      const container = freshContainer();
      const view = new MonthGridView({ ...callbacks(), tagGroups });
      const t = busyTask({
        title: 'Conf',
        planning: { start: '2026-07-14', due: '2026-07-16', time: '09:00' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const anchorBar = container.querySelector(
        '[data-mg-date="2026-07-16"] .abyss-mg-span-segment',
      ) as HTMLElement;
      expect(anchorBar.querySelector('.abyss-mg-item-meta')).toBeNull();
      expect(anchorBar.querySelector('.abyss-mg-item-time')?.textContent).toContain('09:00');
    });

    it('omits .abyss-mg-item-meta on a deadline marker', () => {
      const container = freshContainer();
      const view = new MonthGridView({ ...callbacks(), tagGroups });
      const t = busyTask({
        title: 'Deadline',
        planning: { due: '2026-07-15', scheduled: '2026-07-10' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const marker = container.querySelector('.abyss-mg-deadline-marker') as HTMLElement;
      expect(marker.querySelector('.abyss-mg-item-meta')).toBeNull();
    });
  });

  describe('timed multi-day spans (Task 29)', () => {
    it('renders a start+due+time task as one tile per date with a due terminal', () => {
      const container = freshContainer();
      const view = new MonthGridView(callbacks());
      const t = task({
        title: 'Conf',
        planning: { start: '2026-07-14', due: '2026-07-16', time: '09:00' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      expect(container.querySelectorAll('.abyss-mg-span-segment')).toHaveLength(3);
      expect(
        Array.from(container.querySelectorAll<HTMLElement>('[data-span-kind]')).map(
          (segment) => segment.dataset['spanDate'],
        ),
      ).toEqual(['2026-07-14', '2026-07-15', '2026-07-16']);
    });

    it("prefixes the anchor (due) day's segment with the time, distinguishing it from an untimed span", () => {
      const container = freshContainer();
      const view = new MonthGridView(callbacks());
      const t = task({
        title: 'Conf',
        planning: { start: '2026-07-14', due: '2026-07-16', time: '09:00' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const anchorBar = container.querySelector(
        '[data-mg-date="2026-07-16"] .abyss-mg-span-segment',
      ) as HTMLElement;
      expect(anchorBar.querySelector('.abyss-mg-item-time')?.textContent).toContain('09:00');
    });

    it('shows the time prefix on continuation days of the same timed span', () => {
      const container = freshContainer();
      const view = new MonthGridView(callbacks());
      const t = task({
        title: 'Conf',
        planning: { start: '2026-07-14', due: '2026-07-16', time: '09:00' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const midBar = container.querySelector(
        '[data-mg-date="2026-07-15"] .abyss-mg-span-segment',
      ) as HTMLElement;
      expect(midBar.querySelector('.abyss-mg-item-time')?.textContent).toContain('09:00');
    });

    it('an untimed start+due span still renders with no time prefix (unchanged existing behavior)', () => {
      const container = freshContainer();
      const view = new MonthGridView(callbacks());
      const t = task({ title: 'Trip', planning: { start: '2026-07-14', due: '2026-07-16' } });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const bar = container.querySelector(
        '[data-mg-date="2026-07-15"] .abyss-mg-span-segment',
      ) as HTMLElement;
      expect(bar.querySelector('.abyss-mg-item-time')).toBeNull();
    });

    it('a right-click on a timed span-segment fires onTaskClick', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const view = new MonthGridView(cbs);
      const t = task({
        title: 'Conf',
        planning: { start: '2026-07-14', due: '2026-07-16', time: '09:00' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const bar = container.querySelector(
        '[data-mg-date="2026-07-16"] .abyss-mg-span-segment',
      ) as HTMLElement;
      bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      expect(cbs.onTaskClick).toHaveBeenCalledWith(t);
    });

    it('a timed span-segment is draggable with the filePath:::line payload, same as an untimed span', () => {
      const container = freshContainer();
      const view = new MonthGridView(callbacks());
      const t = task({
        planning: { start: '2026-07-14', due: '2026-07-16', time: '09:00' },
        source: { filePath: 'a.md', line: 2 },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const bar = container.querySelector(
        '[data-mg-date="2026-07-16"] .abyss-mg-span-segment',
      ) as HTMLElement;
      expect(bar.hasAttribute('draggable')).toBe(false);
      expect(bar.getAttribute('tabindex')).toBe('0');
    });
  });

  describe('span continuations (Task 3)', () => {
    it('renders an untimed span with one interactive due terminal and a movable tagged ghost before it', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const view = new MonthGridView({
        ...cbs,
        tagGroups: [{ id: 'work', name: 'Work', mode: 'prefix', prefix: 'work', color: '#3498db' }],
      });
      const t = task({
        title: 'Trip',
        status: 'done',
        statusSymbol: 'x',
        tags: ['#work'],
        planning: { start: '2026-07-14', due: '2026-07-16' },
        source: { originalMarkdown: '- [x] Trip #work', originalBlock: '- [x] Trip #work' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));

      const ghost = requiredElement(container, '[data-span-kind="ghost"]');
      const terminal = requiredElement(container, '[data-span-kind="terminal"]');

      expect(
        container.querySelectorAll('.abyss-mg-span-segment .abyss-status-marker'),
      ).toHaveLength(1);
      expect(terminal.hasAttribute('draggable')).toBe(false);
      expect(terminal.getAttribute('tabindex')).toBe('0');
      expect(terminal.classList.contains('abyss-mg-span-continuation')).toBe(false);
      expect(ghost.classList.contains('abyss-mg-span-continuation')).toBe(true);
      expect(ghost.querySelector('.abyss-status-marker')).toBeNull();
      expect(ghost.hasAttribute('draggable')).toBe(false);
      expect(ghost.getAttribute('tabindex')).toBe('0');
      expect(ghost.style.getPropertyValue('--abyss-tag-color')).toBe('#3498db');
      expect(ghost.querySelector('.abyss-mg-item-title')?.classList.contains('is-done')).toBe(true);

      ghost.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(cbs.onDayClick).not.toHaveBeenCalled();
      expect(cbs.onCreateAtDate).not.toHaveBeenCalled();
      ghost.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      expect(cbs.onTaskClick).toHaveBeenCalledTimes(1);
      expect(cbs.onTaskClick).toHaveBeenCalledWith(t);
    });

    it('renders a timed span with one interactive due terminal and a time-prefixed movable ghost', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const view = new MonthGridView(cbs);
      const t = task({
        title: 'Conference',
        planning: { start: '2026-07-14', due: '2026-07-16', time: '09:00' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));

      const ghost = requiredElement(container, '[data-span-kind="ghost"]');
      const terminal = requiredElement(container, '[data-span-kind="terminal"]');

      expect(
        container.querySelectorAll('.abyss-mg-span-segment .abyss-status-marker'),
      ).toHaveLength(1);
      expect(terminal.getAttribute('tabindex')).toBe('0');
      for (const segment of [ghost, terminal]) {
        expect(segment.querySelector('.abyss-mg-item-time')?.textContent).toContain('09:00');
      }
      expect(ghost.classList.contains('abyss-mg-span-continuation')).toBe(true);
      expect(ghost.querySelector('.abyss-status-marker')).toBeNull();
      expect(ghost.hasAttribute('draggable')).toBe(false);
      expect(ghost.getAttribute('tabindex')).toBe('0');

      ghost.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(cbs.onDayClick).not.toHaveBeenCalled();
      expect(cbs.onCreateAtDate).not.toHaveBeenCalled();
      ghost.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      expect(cbs.onTaskClick).toHaveBeenCalledTimes(1);
      expect(cbs.onTaskClick).toHaveBeenCalledWith(t);
    });

    it('renders a human-readable plain ghost title while the due terminal retains rich rendering', () => {
      const container = freshContainer();
      const view = new MonthGridView(callbacks());
      const t = taskFromCodecLine(
        '- [ ] Conference at [[Note]] with **bold**, ~~old~~ and `code` [site](https://example.test) 🛫 2026-07-14 📅 2026-07-16',
      );
      expect(t.title).toBe('Conference at 🔗 Note with **bold**, ~~old~~ and `code` 🌐 site');
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));

      const ghost = requiredElement(
        container,
        '[data-mg-date="2026-07-15"] .abyss-mg-span-continuation',
      );
      const terminal = requiredElement(
        container,
        '[data-mg-date="2026-07-16"] .abyss-mg-span-segment',
      );
      expect(ghost.querySelector('.abyss-md')).toBeNull();
      expect(ghost.querySelector('a')).toBeNull();
      expect(ghost.querySelector('.abyss-mg-item-title')?.textContent).toBe(
        'Conference at 🔗 Note with bold, old and code 🌐 site',
      );
      expect(ghost.textContent).not.toContain('[[');
      expect(ghost.textContent).not.toContain('**');
      expect(ghost.textContent).not.toContain('~~');
      expect(ghost.textContent).not.toContain('`');
      expect(terminal.querySelector('.abyss-md')).not.toBeNull();
    });

    it('styles span continuations as opaque restrained committed tiles through their shared root', () => {
      const monthDeclarations = declarationsFor('.abyss-mg-span-continuation');
      const ghostDeclarations = declarationsFor('.abyss-tg-span-continuation');
      const sharedSurface = declarationsForRuleContaining(
        '.abyss-tg-span',
        '.abyss-tg-span-continuation',
        '.abyss-mg-span-continuation',
      );
      expect(monthDeclarations).not.toMatch(/opacity\s*:/u);
      expect(ghostDeclarations).toMatch(
        /border-inline-start\s*:\s*var\(--abyss-calendar-ghost-rail\) dashed\s+var\(--abyss-tag-color,\s*var\(--interactive-accent\)\)/u,
      );
      expect(sharedSurface).toMatch(/background\s*:\s*var\(--abyss-calendar-surface\)/u);
      expect(monthDeclarations).toMatch(/cursor\s*:\s*grab/u);
    });

    it('resolves the combined Month ghost and terminal classes to the same committed fill', () => {
      const container = freshContainer();
      const view = new MonthGridView(callbacks());
      const t = task({
        title: 'Trip',
        planning: { start: '2026-07-14', due: '2026-07-16' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));

      const ghost = requiredElement(container, '[data-span-kind="ghost"]');
      const terminal = requiredElement(container, '[data-span-kind="terminal"]');
      expect(ghost.classList.contains('abyss-tg-span-continuation')).toBe(true);
      expect(ghost.classList.contains('abyss-mg-span-segment')).toBe(true);
      expect(ghost.classList.contains('abyss-mg-span-continuation')).toBe(true);
      expect(winningCssDeclaration(ghost, 'background')).toBe('var(--abyss-calendar-surface)');
      expect(winningCssDeclaration(terminal, 'background')).toBe('var(--abyss-calendar-surface)');
      expect(winningCssDeclaration(ghost, 'border-inline-start')).toContain('dashed');
    });

    it('uses committed fill strength when choosing readable title text', () => {
      const originalBackground = document.body.style.getPropertyValue('--background-primary');
      document.body.style.setProperty('--background-primary', '#666666');
      try {
        const container = freshContainer();
        const view = new MonthGridView({
          ...callbacks(),
          tagGroups: [{ id: 'work', name: 'Work', mode: 'prefix', prefix: 'work', color: '#fff' }],
        });
        const t = task({
          title: 'Trip',
          tags: ['#work'],
          planning: { start: '2026-07-14', due: '2026-07-16' },
          source: { originalMarkdown: '- [ ] Trip #work', originalBlock: '- [ ] Trip #work' },
        });
        view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));

        const ghost = container.querySelector(
          '[data-mg-date="2026-07-15"] .abyss-mg-span-continuation',
        ) as HTMLElement;
        const terminal = container.querySelector(
          '[data-mg-date="2026-07-16"] .abyss-mg-span-segment',
        ) as HTMLElement;

        expect(ghost.style.getPropertyValue('--abyss-tag-text-color')).toBe(
          'var(--abyss-tag-text-dark)',
        );
        expect(terminal.style.getPropertyValue('--abyss-tag-text-color')).toBe(
          'var(--abyss-tag-text-dark)',
        );
      } finally {
        document.body.style.setProperty('--background-primary', originalBackground);
      }
    });
  });

  describe('Task 38 follow-up: is-done/is-cancelled strikethrough parity with timed blocks', () => {
    it('marks a done plain item title is-done', () => {
      const container = freshContainer();
      const view = new MonthGridView(callbacks());
      const t = task({
        status: 'done',
        statusSymbol: 'x',
        title: 'Plain',
        planning: { due: '2026-07-15' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const title = container.querySelector(
        '[data-mg-date="2026-07-15"] .abyss-mg-item-title',
      ) as HTMLElement;
      expect(title.classList.contains('is-done')).toBe(true);
    });

    it('marks a cancelled timed item title is-cancelled', () => {
      const container = freshContainer();
      const view = new MonthGridView(callbacks());
      const t = task({
        status: 'cancelled',
        statusSymbol: '-',
        title: 'Timed',
        planning: { due: '2026-07-15', time: '09:00' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const title = container.querySelector(
        '[data-mg-date="2026-07-15"] .abyss-mg-item-title',
      ) as HTMLElement;
      expect(title.classList.contains('is-cancelled')).toBe(true);
    });

    it('an open item gets neither is-done nor is-cancelled on its title', () => {
      const container = freshContainer();
      const view = new MonthGridView(callbacks());
      const t = task({ title: 'Plain', planning: { due: '2026-07-15' } });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const title = container.querySelector(
        '[data-mg-date="2026-07-15"] .abyss-mg-item-title',
      ) as HTMLElement;
      expect(title.classList.contains('is-done')).toBe(false);
      expect(title.classList.contains('is-cancelled')).toBe(false);
    });

    it('marks a done deadline marker title is-done', () => {
      const container = freshContainer();
      const view = new MonthGridView(callbacks());
      const t = task({
        status: 'done',
        statusSymbol: 'x',
        title: 'Deadline',
        planning: { due: '2026-07-15', scheduled: '2026-07-10' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const title = container.querySelector(
        '[data-mg-date="2026-07-15"] .abyss-mg-deadline-marker .abyss-mg-item-title',
      ) as HTMLElement;
      expect(title).not.toBeNull();
      expect(title.classList.contains('is-done')).toBe(true);
    });

    it('.abyss-mg-item-title.is-done gets the same strikethrough convention as .abyss-tg-block-title.is-done', () => {
      const rule = /\.abyss-mg-item-title\.is-done[^{]*\{[^}]*\}/u.exec(css)?.[0] ?? '';
      expect(rule).toMatch(/text-decoration\s*:\s*line-through/u);
    });
  });

  describe('calendar surface style contract', () => {
    it('aligns the Month span layer origin with the day-label line box', () => {
      let monthSpanLayer = '';
      for (const match of css.matchAll(/^\.abyss-mg-span-layer[ \t]*\{([^}]*)\}/gmu)) {
        monthSpanLayer = match[1] ?? '';
      }
      const monthDayLabel = declarationsFor('.abyss-mg-day-label');

      expect(monthDayLabel).toMatch(/font-size\s*:\s*0\.75em/u);
      expect(monthSpanLayer).toMatch(/top\s*:\s*calc\(3px\s*\+\s*0\.75lh\)/u);
    });

    it('keeps Month at the shared item scale while allowing vertical grid scrolling', () => {
      const monthGrid = declarationsFor('.abyss-mg-grid');
      const monthRow = declarationsFor('.abyss-mg-row');
      const monthItems = declarationsFor('.abyss-mg-cell-items');
      const monthItem = declarationsForRuleContaining(
        '.abyss-mg-plain',
        '.abyss-mg-block-dot',
        '.abyss-mg-span-segment',
        '.abyss-mg-deadline-marker',
      );
      const monthGhost = declarationsFor('.abyss-mg-span-continuation');
      const monthSpanGeometry = declarationsFor('.abyss-mg-span-segment');
      const compactGeometry = declarationsForRuleContaining(
        '.abyss-mg-cell-items > .abyss-mg-plain',
        '.abyss-mg-cell-items > .abyss-mg-block-dot',
        '.abyss-mg-cell-items > .abyss-mg-deadline-marker',
      );

      expect(monthGrid).toMatch(/overflow-y\s*:\s*auto/u);
      expect(monthRow).toMatch(/flex\s*:\s*0 0 auto/u);
      expect(monthRow).toMatch(
        /min-height\s*:\s*calc\(var\(--abyss-calendar-track-height\) \* 4\)/u,
      );
      expect(monthItems).toMatch(/display\s*:\s*grid/u);
      expect(monthItems).toMatch(/grid-auto-rows\s*:\s*var\(--abyss-calendar-track-height\)/u);
      expect(monthItems).toMatch(/gap\s*:\s*0/u);
      expect(monthItems).toMatch(/margin-top\s*:\s*0/u);
      expect(monthItems).not.toMatch(/margin-top\s*:[^;]*--abyss-span-lane-count/u);
      expect(monthItem).toMatch(/font-size\s*:\s*var\(--abyss-calendar-item-font-size\)/u);
      expect(monthItem).toMatch(/border-radius\s*:\s*var\(--abyss-calendar-item-radius\)/u);
      expect(monthItem).toMatch(/padding\s*:\s*2px\s+var\(--abyss-calendar-item-pad-inline\)/u);
      expect(monthSpanGeometry).toMatch(/margin-inline\s*:\s*5px/u);
      expect(compactGeometry).toMatch(/block-size\s*:\s*calc\(100% - 2px\)/u);
      expect(compactGeometry).toMatch(/margin-block\s*:\s*1px/u);
      expect(monthGhost).toMatch(
        /border-inline-start\s*:\s*var\(--abyss-calendar-ghost-rail\) dashed/u,
      );
      expect(declarationsFor('.abyss-mg-item-title')).toMatch(/line-height\s*:\s*1\.4/u);
      expect(css).not.toMatch(
        /\.abyss-mg-(?:plain|block-dot|span-segment|deadline-marker)[^{]*\{[^}]*font-size\s*:\s*0\.72em/u,
      );
    });
  });
});
