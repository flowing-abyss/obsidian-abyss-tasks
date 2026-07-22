import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { MonthGridView } from '../src/views/MonthGridView';
import {
  DataTransferStub,
  freshContainer,
  resolvedConfig,
  subtask,
  task,
  taskComment,
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

function requiredElement(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Expected element matching ${selector}`);
  return element;
}

function callbacks() {
  return {
    app: fakeApp,
    onDayClick: vi.fn(),
    onCreateAtDate: vi.fn(),
    onTaskClick: vi.fn(),
    onDrop: vi.fn(),
    onToggle: vi.fn(),
    onSetStatus: vi.fn(),
    onSetPriority: vi.fn(),
    onWeekClick: vi.fn(),
    statusRegistry: registry,
  };
}

describe('MonthGridView', () => {
  it('renders a 6-week grid (42 day cells) for the configured month', () => {
    const container = freshContainer();
    const view = new MonthGridView(callbacks());
    view.render(container, [], resolvedConfig({ startPosition: '2026-07' }));
    expect(container.querySelectorAll('.tc-mg-cell')).toHaveLength(42);
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
    expect(container.querySelectorAll('.tc-mg-cell')).toHaveLength(42);
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
    // Round 3: the user asked for the pre-existing background-color tint on .tc-mg-cell.is-today
    // to be removed, keeping just the border that Round 2 added. Assert against the actual
    // declarations so a future edit can't silently reintroduce a background alongside it.
    const declarations = declarationsFor('.tc-mg-cell.is-today');
    expect(declarations).toContain('box-shadow');
    expect(declarations).not.toMatch(/background/u);
  });

  it('a plain task on a given day renders a compact row in that cell', () => {
    const container = freshContainer();
    const view = new MonthGridView(callbacks());
    const t = task({ title: 'Plain', planning: { due: '2026-07-15' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const cell = container.querySelector('[data-mg-date="2026-07-15"]');
    expect(cell?.querySelector('.tc-mg-plain')?.textContent).toContain('Plain');
  });

  it('never sets data-priority on compact items, even for a prioritized task (calendar items no longer render a priority border)', () => {
    const container = freshContainer();
    const view = new MonthGridView(callbacks());
    const t = task({ priority: 'C', title: 'Plain', planning: { due: '2026-07-15' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const row = container.querySelector('[data-mg-date="2026-07-15"] .tc-mg-plain') as HTMLElement;
    expect(row.hasAttribute('data-priority')).toBe(false);

    const container2 = freshContainer();
    const view2 = new MonthGridView(callbacks());
    const none = task({ priority: 'D', title: 'Plain', planning: { due: '2026-07-15' } });
    view2.render(container2, [none], resolvedConfig({ startPosition: '2026-07' }));
    const row2 = container2.querySelector(
      '[data-mg-date="2026-07-15"] .tc-mg-plain',
    ) as HTMLElement;
    expect(row2.hasAttribute('data-priority')).toBe(false);
  });

  it('sets --tc-tag-color on compact items when a tag matches a configured tag group', () => {
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
    const row = container.querySelector('[data-mg-date="2026-07-15"] .tc-mg-plain') as HTMLElement;
    expect(row.style.getPropertyValue('--tc-tag-color')).toBe('#3498db');
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
    const addBtn = cell.querySelector('.tc-mg-add-btn') as HTMLElement;
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
    expect(cell.querySelectorAll('.tc-mg-plain').length).toBe(8); // cell is fully packed
    const dayLabel = cell.querySelector('.tc-mg-day-label') as HTMLElement;
    dayLabel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onDayClick).toHaveBeenCalledWith('2026-07-15');
  });

  it("clicking the day-number label does not double-fire onDayClick via the cell's own empty-space click handler", () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    view.render(container, [], resolvedConfig({ startPosition: '2026-07' }));
    const cell = container.querySelector('[data-mg-date="2026-07-15"]') as HTMLElement;
    const dayLabel = cell.querySelector('.tc-mg-day-label') as HTMLElement;
    dayLabel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onDayClick).toHaveBeenCalledTimes(1);
  });

  it('a plain click on a compact plain row does NOT fire onTaskClick (reserved for drag)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Plain', planning: { due: '2026-07-15' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const row = container.querySelector('[data-mg-date="2026-07-15"] .tc-mg-plain') as HTMLElement;
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('a right-click (contextmenu) on a compact plain row fires onTaskClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Plain', planning: { due: '2026-07-15' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const row = container.querySelector('[data-mg-date="2026-07-15"] .tc-mg-plain') as HTMLElement;
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
      '[data-mg-date="2026-07-15"] .tc-mg-block-dot',
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
      '[data-mg-date="2026-07-15"] .tc-mg-block-dot',
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
      '[data-mg-date="2026-07-15"] .tc-mg-span-segment',
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
      '[data-mg-date="2026-07-15"] .tc-mg-span-segment',
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
      '[data-mg-date="2026-07-15"] .tc-mg-deadline-marker',
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
      '[data-mg-date="2026-07-15"] .tc-mg-deadline-marker',
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
    const row = container.querySelector('[data-mg-date="2026-07-15"] .tc-mg-plain') as HTMLElement;
    const marker = row.querySelector('.tc-status-marker');
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
      '[data-mg-date="2026-07-15"] .tc-mg-block-dot',
    ) as HTMLElement;
    const marker = dot.querySelector('.tc-status-marker');
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
      '[data-mg-date="2026-07-16"] .tc-mg-span-segment',
    ) as HTMLElement;
    const marker = bar.querySelector('.tc-status-marker');
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
      '[data-mg-date="2026-07-15"] .tc-mg-deadline-marker',
    ) as HTMLElement;
    const marker = markerEl.querySelector('.tc-status-marker');
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
    const row = container.querySelector('[data-mg-date="2026-07-15"] .tc-mg-plain') as HTMLElement;
    const marker = row.querySelector('.tc-status-marker');
    const title = row.querySelector('.tc-mg-item-title');
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
      '[data-mg-date="2026-07-15"] .tc-mg-block-dot',
    ) as HTMLElement;
    const marker = dot.querySelector('.tc-status-marker');
    const time = dot.querySelector('.tc-mg-item-time');
    const title = dot.querySelector('.tc-mg-item-title');
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
      '[data-mg-date="2026-07-16"] .tc-mg-span-segment',
    ) as HTMLElement;
    const marker = bar.querySelector('.tc-status-marker');
    const title = bar.querySelector('.tc-mg-item-title');
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
      '[data-mg-date="2026-07-15"] .tc-mg-deadline-marker',
    ) as HTMLElement;
    const title = markerEl.querySelector('.tc-mg-item-title');
    expect(title).not.toBeNull();
  });

  it('right-clicking the status marker on a compact plain row opens the status/priority popover and does NOT fire onTaskClick (distinct from the row contextmenu)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Plain', planning: { due: '2026-07-15' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const marker = container.querySelector(
      '[data-mg-date="2026-07-15"] .tc-mg-plain .tc-status-marker',
    ) as HTMLElement;
    marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(document.querySelector('.tc-status-popover')).not.toBeNull();
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('picking a status/priority from the popover on a compact row fires onSetStatus/onSetPriority with the task', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    const t = task({ title: 'Plain', planning: { due: '2026-07-15' } });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const marker = container.querySelector(
      '[data-mg-date="2026-07-15"] .tc-mg-plain .tc-status-marker',
    ) as HTMLElement;
    marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const statusRow = document.querySelector('.tc-status-popover-row') as HTMLElement;
    statusRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onSetStatus).toHaveBeenCalledWith(t, expect.any(String));

    document.querySelectorAll('.tc-status-popover').forEach((el) => el.remove());
    marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const flagBtn = document.querySelector(
      '.tc-status-popover-flag[data-tc-priority="A"]',
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
    const row = container.querySelector('[data-mg-date="2026-07-15"] .tc-mg-plain') as HTMLElement;
    // MarkdownRenderer is a noop in this test harness (see test/center-panel-integration.test.ts
    // and friends); `.tc-md` is the reliable signal that renderTaskText's markdown path (not a
    // raw textContent assignment) was taken.
    expect(row.querySelector('.tc-md')).not.toBeNull();
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
    const row = container.querySelector('[data-mg-date="2026-07-15"] .tc-mg-plain') as HTMLElement;
    const titleEl = row.querySelector('.tc-md') as HTMLElement;
    titleEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onDayClick).not.toHaveBeenCalled();
  });

  it('renders a week-number button per row, clicking it fires onWeekClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    view.render(container, [], resolvedConfig({ startPosition: '2026-07' }));
    const weekBtns = container.querySelectorAll('.tc-mg-week-btn');
    expect(weekBtns.length).toBe(6);
    (weekBtns[0] as HTMLElement).click();
    expect(cbs.onWeekClick).toHaveBeenCalled();
  });

  it('the week-number button passes the correct week number and year', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const view = new MonthGridView(cbs);
    view.render(container, [], resolvedConfig({ startPosition: '2026-07' }));
    const weekBtns = container.querySelectorAll('.tc-mg-week-btn');
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
    const weekBtn = container.querySelector('.tc-mg-week-btn') as HTMLElement;
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
    const item = container.querySelector('.tc-mg-plain') as HTMLElement;
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
    const item = container.querySelector('.tc-mg-block-dot') as HTMLElement;
    expect(item.getAttribute('draggable')).toBe('true');
    const dt = new DataTransferStub();
    const ev = new MouseEvent('dragstart', { bubbles: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
    item.dispatchEvent(ev);
    expect(dt.getData('text/plain')).toBe('f.md:::7');
  });

  it('a span-segment item is draggable with the filePath:::line payload', () => {
    const container = freshContainer();
    const view = new MonthGridView(callbacks());
    const t = task({
      title: 'Trip',
      planning: { start: '2026-07-14', due: '2026-07-16' },
      source: { filePath: 'f.md', line: 9 },
    });
    view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
    const item = container.querySelector(
      '[data-mg-date="2026-07-16"] .tc-mg-span-segment',
    ) as HTMLElement;
    expect(item.getAttribute('draggable')).toBe('true');
    const dt = new DataTransferStub();
    const ev = new MouseEvent('dragstart', { bubbles: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
    item.dispatchEvent(ev);
    expect(dt.getData('text/plain')).toBe('f.md:::9');
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
    const marker = container.querySelector('.tc-mg-deadline-marker') as HTMLElement;
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
    const row = container.querySelector('.tc-mg-plain') as HTMLElement;
    const marker = row.querySelector('.tc-status-marker') as HTMLElement;
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
    const row = container.querySelector('.tc-mg-plain') as HTMLElement;
    expect(row.getAttribute('draggable')).toBe('true');
    // A plain click on the title (not a dragstart) must not be swallowed — it's a normal
    // click event, distinct from the native HTML5 drag gesture which only starts on
    // dragstart, not click.
    const titleEl = row.querySelector('.tc-md') as HTMLElement;
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

    it('omits .tc-mg-item-meta on a plain row, even with tags/subtasks/comments/links', () => {
      const container = freshContainer();
      const view = new MonthGridView({ ...callbacks(), tagGroups });
      const t = busyTask({ title: 'Plain', planning: { due: '2026-07-15' } });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const row = container.querySelector('.tc-mg-plain') as HTMLElement;
      expect(row.querySelector('.tc-mg-item-meta')).toBeNull();
      expect(row.querySelector('.tc-task-tag')).toBeNull();
      expect(row.querySelector('.tc-task-count-badge')).toBeNull();
    });

    it('omits .tc-mg-item-meta on a timed block-dot, keeping the time prefix', () => {
      const container = freshContainer();
      const view = new MonthGridView({ ...callbacks(), tagGroups });
      const t = busyTask({ title: 'Timed', planning: { due: '2026-07-15', time: '09:00' } });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const dot = container.querySelector('.tc-mg-block-dot') as HTMLElement;
      expect(dot.querySelector('.tc-mg-item-meta')).toBeNull();
      expect(dot.querySelector('.tc-mg-item-time')?.textContent).toContain('09:00');
    });

    it('omits .tc-mg-item-meta on an untimed span-segment', () => {
      const container = freshContainer();
      const view = new MonthGridView({ ...callbacks(), tagGroups });
      const t = busyTask({
        title: 'Trip',
        planning: { start: '2026-07-14', due: '2026-07-16' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const bar = container.querySelector(
        '[data-mg-date="2026-07-15"] .tc-mg-span-segment',
      ) as HTMLElement;
      expect(bar.querySelector('.tc-mg-item-meta')).toBeNull();
    });

    it("omits .tc-mg-item-meta on a timed span-segment's anchor day, keeping the time prefix", () => {
      const container = freshContainer();
      const view = new MonthGridView({ ...callbacks(), tagGroups });
      const t = busyTask({
        title: 'Conf',
        planning: { start: '2026-07-14', due: '2026-07-16', time: '09:00' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const anchorBar = container.querySelector(
        '[data-mg-date="2026-07-16"] .tc-mg-span-segment',
      ) as HTMLElement;
      expect(anchorBar.querySelector('.tc-mg-item-meta')).toBeNull();
      expect(anchorBar.querySelector('.tc-mg-item-time')?.textContent).toContain('09:00');
    });

    it('omits .tc-mg-item-meta on a deadline marker', () => {
      const container = freshContainer();
      const view = new MonthGridView({ ...callbacks(), tagGroups });
      const t = busyTask({
        title: 'Deadline',
        planning: { due: '2026-07-15', scheduled: '2026-07-10' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const marker = container.querySelector('.tc-mg-deadline-marker') as HTMLElement;
      expect(marker.querySelector('.tc-mg-item-meta')).toBeNull();
    });
  });

  describe('timed multi-day spans (Task 29)', () => {
    it('renders a start+due+time task as a span-segment on every spanned day', () => {
      const container = freshContainer();
      const view = new MonthGridView(callbacks());
      const t = task({
        title: 'Conf',
        planning: { start: '2026-07-14', due: '2026-07-16', time: '09:00' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      for (const date of ['2026-07-14', '2026-07-15', '2026-07-16']) {
        const bar = container.querySelector(`[data-mg-date="${date}"] .tc-mg-span-segment`);
        expect(bar).not.toBeNull();
      }
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
        '[data-mg-date="2026-07-16"] .tc-mg-span-segment',
      ) as HTMLElement;
      expect(anchorBar.querySelector('.tc-mg-item-time')?.textContent).toContain('09:00');
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
        '[data-mg-date="2026-07-15"] .tc-mg-span-segment',
      ) as HTMLElement;
      expect(midBar.querySelector('.tc-mg-item-time')?.textContent).toContain('09:00');
    });

    it('an untimed start+due span still renders with no time prefix (unchanged existing behavior)', () => {
      const container = freshContainer();
      const view = new MonthGridView(callbacks());
      const t = task({ title: 'Trip', planning: { start: '2026-07-14', due: '2026-07-16' } });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const bar = container.querySelector(
        '[data-mg-date="2026-07-15"] .tc-mg-span-segment',
      ) as HTMLElement;
      expect(bar.querySelector('.tc-mg-item-time')).toBeNull();
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
        '[data-mg-date="2026-07-16"] .tc-mg-span-segment',
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
        '[data-mg-date="2026-07-16"] .tc-mg-span-segment',
      ) as HTMLElement;
      expect(bar.getAttribute('draggable')).toBe('true');
    });
  });

  describe('span continuations (Task 3)', () => {
    it('renders an untimed span with one interactive due terminal and non-interactive tagged ghosts before it', () => {
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

      const segments = ['2026-07-14', '2026-07-15', '2026-07-16'].map((date) =>
        requiredElement(container, `[data-mg-date="${date}"] .tc-mg-span-segment`),
      );
      const startGhost = segments[0]!;
      const middleGhost = segments[1]!;
      const terminal = segments[2]!;

      expect(container.querySelectorAll('.tc-mg-span-segment .tc-status-marker')).toHaveLength(1);
      expect(terminal.getAttribute('draggable')).toBe('true');
      expect(terminal.classList.contains('tc-mg-span-continuation')).toBe(false);
      for (const ghost of [startGhost, middleGhost]) {
        expect(ghost.classList.contains('tc-mg-span-continuation')).toBe(true);
        expect(ghost.querySelector('.tc-status-marker')).toBeNull();
        expect(ghost.hasAttribute('draggable')).toBe(false);
        expect(ghost.style.getPropertyValue('--tc-tag-color')).toBe('#3498db');
        expect(ghost.querySelector('.tc-mg-item-title')?.classList.contains('is-done')).toBe(true);
      }

      middleGhost.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(cbs.onDayClick).not.toHaveBeenCalled();
      expect(cbs.onCreateAtDate).not.toHaveBeenCalled();
      middleGhost.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      expect(cbs.onTaskClick).toHaveBeenCalledTimes(1);
      expect(cbs.onTaskClick).toHaveBeenCalledWith(t);
    });

    it('renders a timed span with one interactive due terminal and time-prefixed ghosts before it', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const view = new MonthGridView(cbs);
      const t = task({
        title: 'Conference',
        planning: { start: '2026-07-14', due: '2026-07-16', time: '09:00' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));

      const segments = ['2026-07-14', '2026-07-15', '2026-07-16'].map((date) =>
        requiredElement(container, `[data-mg-date="${date}"] .tc-mg-span-segment`),
      );
      const startGhost = segments[0]!;
      const middleGhost = segments[1]!;
      const terminal = segments[2]!;

      expect(container.querySelectorAll('.tc-mg-span-segment .tc-status-marker')).toHaveLength(1);
      expect(terminal.getAttribute('draggable')).toBe('true');
      for (const segment of segments) {
        expect(segment.querySelector('.tc-mg-item-time')?.textContent).toContain('09:00');
      }
      for (const ghost of [startGhost, middleGhost]) {
        expect(ghost.classList.contains('tc-mg-span-continuation')).toBe(true);
        expect(ghost.querySelector('.tc-status-marker')).toBeNull();
        expect(ghost.hasAttribute('draggable')).toBe(false);
      }

      middleGhost.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(cbs.onDayClick).not.toHaveBeenCalled();
      expect(cbs.onCreateAtDate).not.toHaveBeenCalled();
      middleGhost.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      expect(cbs.onTaskClick).toHaveBeenCalledTimes(1);
      expect(cbs.onTaskClick).toHaveBeenCalledWith(t);
    });

    it('renders a human-readable plain ghost title while the due terminal retains rich rendering', () => {
      const container = freshContainer();
      const view = new MonthGridView(callbacks());
      const t = task({
        title: 'Conference at Note with bold text',
        markdownTitle: 'Conference at [[Note]] with **bold text**',
        planning: { start: '2026-07-14', due: '2026-07-16' },
      });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));

      const ghost = requiredElement(
        container,
        '[data-mg-date="2026-07-15"] .tc-mg-span-continuation',
      );
      const terminal = requiredElement(
        container,
        '[data-mg-date="2026-07-16"] .tc-mg-span-segment',
      );
      expect(ghost.querySelector('.tc-md')).toBeNull();
      expect(ghost.querySelector('a')).toBeNull();
      expect(ghost.querySelector('.tc-mg-item-title')?.textContent).toBe(
        'Conference at Note with bold text',
      );
      expect(ghost.textContent).not.toContain('[[');
      expect(ghost.textContent).not.toContain('**');
      expect(terminal.querySelector('.tc-md')).not.toBeNull();
    });

    it('styles span continuations as translucent dashed tag-aware ghosts', () => {
      const declarations = declarationsFor('.tc-mg-span-continuation');
      expect(declarations).toMatch(/opacity\s*:\s*0\.55/u);
      expect(declarations).toMatch(
        /border\s*:\s*1px dashed var\(--tc-tag-color,\s*var\(--background-modifier-border\)\)/u,
      );
      expect(declarations).toMatch(
        /background\s*:\s*color-mix\(\s*in srgb,\s*var\(--tc-tag-color,\s*var\(--interactive-accent\)\) 18%,\s*transparent\s*\)/u,
      );
      expect(declarations).toMatch(/cursor\s*:\s*default/u);
    });

    it("uses the ghost's 18% tag fill when choosing a readable title-text variant", () => {
      const originalBackground = document.body.style.getPropertyValue('--background-primary');
      document.body.style.setProperty('--background-primary', '#444444');
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
          '[data-mg-date="2026-07-15"] .tc-mg-span-continuation',
        ) as HTMLElement;
        const terminal = container.querySelector(
          '[data-mg-date="2026-07-16"] .tc-mg-span-segment',
        ) as HTMLElement;

        expect(ghost.style.getPropertyValue('--tc-tag-text-color')).toBe(
          'var(--tc-tag-text-light)',
        );
        expect(terminal.style.getPropertyValue('--tc-tag-text-color')).toBe(
          'var(--tc-tag-text-dark)',
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
        '[data-mg-date="2026-07-15"] .tc-mg-item-title',
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
        '[data-mg-date="2026-07-15"] .tc-mg-item-title',
      ) as HTMLElement;
      expect(title.classList.contains('is-cancelled')).toBe(true);
    });

    it('an open item gets neither is-done nor is-cancelled on its title', () => {
      const container = freshContainer();
      const view = new MonthGridView(callbacks());
      const t = task({ title: 'Plain', planning: { due: '2026-07-15' } });
      view.render(container, [t], resolvedConfig({ startPosition: '2026-07' }));
      const title = container.querySelector(
        '[data-mg-date="2026-07-15"] .tc-mg-item-title',
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
        '[data-mg-date="2026-07-15"] .tc-mg-deadline-marker .tc-mg-item-title',
      ) as HTMLElement;
      expect(title).not.toBeNull();
      expect(title.classList.contains('is-done')).toBe(true);
    });

    it('.tc-mg-item-title.is-done gets the same strikethrough convention as .tc-tg-block-title.is-done', () => {
      const rule = /\.tc-mg-item-title\.is-done[^{]*\{[^}]*\}/u.exec(css)?.[0] ?? '';
      expect(rule).toMatch(/text-decoration\s*:\s*line-through/u);
    });
  });
});
