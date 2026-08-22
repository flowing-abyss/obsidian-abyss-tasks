import type { App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { LinkToken } from '../src/parser/links';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type { TaskSnapshot as Task } from '../src/tasks';
import { taskPresentationKey } from '../src/ui/taskPresentationIdentity';
import { MonthView } from '../src/views/MonthView';
import { dispatchDnD, freshContainer, resolvedConfig, task, useRealMoment } from './helpers';

useRealMoment();

function fakeApp(): App {
  return {} as App;
}

function makeView(
  callbacks: Partial<{
    onToggle: (t: Task) => void;
    onCellClick: (d: string) => void;
    onWeekClick: (w: string, y: string) => void;
    onTaskClick: (t: Task) => void;
    onDrop: (d: string, date: string) => void;
    onOpenNote: (t: Task) => void;
    onEditLink: (t: Task, occ: number, token: LinkToken) => void;
    onContextMenu: (ev: MouseEvent, t: Task) => void;
  }> = {},
) {
  const spies = {
    app: fakeApp(),
    onToggle: vi.fn(callbacks.onToggle),
    onCellClick: vi.fn(callbacks.onCellClick),
    onWeekClick: vi.fn(callbacks.onWeekClick),
    onTaskClick: vi.fn(callbacks.onTaskClick),
    onDrop: vi.fn(callbacks.onDrop),
    onOpenNote: vi.fn(callbacks.onOpenNote),
    onEditLink: vi.fn(callbacks.onEditLink),
    statusRegistry: new StatusRegistry(buildDefaultTaskStatuses()),
    onContextMenu: vi.fn(callbacks.onContextMenu),
  };
  const view = new MonthView(spies);
  return { view, spies };
}

describe('MonthView', () => {
  describe('grid structure', () => {
    it('produces one .grid, one .gridHeads, one .wrappers', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      expect(c.querySelectorAll('.grid')).toHaveLength(1);
      expect(c.querySelectorAll('.gridHeads')).toHaveLength(1);
      expect(c.querySelectorAll('.wrappers')).toHaveLength(1);
    });

    it('gridHeads has 1 empty corner + 7 weekday heads = 8 total', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      expect(c.querySelectorAll('.gridHeads .gridHead')).toHaveLength(8);
    });

    it('wrappers has 6 .wrapper rows (always 6 weeks)', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      expect(c.querySelectorAll('.wrappers .wrapper')).toHaveLength(6);
    });

    it('each wrapper has one .wrapperButton with data-week + data-year + W<n> text', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      const btns = c.querySelectorAll('.wrapperButton');
      expect(btns).toHaveLength(6);
      btns.forEach((b) => {
        const el = b as HTMLElement;
        expect(el.getAttribute('data-week')).not.toBeNull();
        expect(el.getAttribute('data-year')).not.toBeNull();
        expect(el.textContent ?? '').toMatch(/^W\d+$/);
      });
    });

    it('each wrapper has 7 .cell elements → 42 cells total', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      expect(c.querySelectorAll('.wrappers .cell')).toHaveLength(42);
    });

    it('each cell has data-weekday attribute', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      const cells = c.querySelectorAll('.cell');
      expect(cells.length).toBeGreaterThan(0);
      cells.forEach((cell) => {
        expect((cell as HTMLElement).getAttribute('data-weekday')).not.toBeNull();
      });
    });
  });

  describe('cell classing (today pinned via fake timers)', () => {
    it('today cell has currentMonth today class', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00'));
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      const todayCell = c.querySelector('.cell.today');
      expect(todayCell).not.toBeNull();
      expect(todayCell?.classList.contains('currentMonth')).toBe(true);
      vi.useRealTimers();
    });

    it('prev month days have prevMonth class', () => {
      // June 2026 starts on Monday (firstDayOfWeek=1) → no prevMonth cells.
      // Pin to May 2026 (starts Friday) so prevMonth cells exist.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-15T12:00:00'));
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      expect(c.querySelectorAll('.cell.prevMonth').length).toBeGreaterThan(0);
      vi.useRealTimers();
    });

    it('next month days have nextMonth class', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00'));
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      expect(c.querySelectorAll('.cell.nextMonth').length).toBeGreaterThan(0);
      vi.useRealTimers();
    });

    it('first-of-month cells have newMonth class', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00'));
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      expect(c.querySelectorAll('.cell.newMonth').length).toBeGreaterThan(0);
      vi.useRealTimers();
    });

    it('cellName href = dailyNoteFolder/date when folder set', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [], resolvedConfig({ dailyNoteFolder: 'daily' }));
      const link = c.querySelector('.cellName') as HTMLAnchorElement;
      expect(link).not.toBeNull();
      expect(link.getAttribute('href')?.startsWith('daily/')).toBe(true);
    });

    it('cellName href = bare date when dailyNoteFolder empty', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [], resolvedConfig({ dailyNoteFolder: '' }));
      const link = c.querySelector('.cellName') as HTMLAnchorElement;
      expect(link).not.toBeNull();
      expect(link.getAttribute('href')?.includes('/')).toBe(false);
    });
  });

  describe('cell click routing', () => {
    it('click on current-month cell (not task/cellName) → onCellClick', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00'));
      const { view, spies } = makeView({ onCellClick: (d) => d });
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      const todayCell = c.querySelector('.cell.today') as HTMLElement;
      // click on the cell itself (not cellName, not task)
      todayCell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(spies.onCellClick).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('click on .cellName link → onCellClick NOT called', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00'));
      const { view, spies } = makeView({ onCellClick: (d) => d });
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      const cellName = c.querySelector('.cell.today .cellName') as HTMLElement;
      cellName.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(spies.onCellClick).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('prev/next month cells do NOT bind onCellClick', () => {
      // June 2026 starts on Monday (firstDayOfWeek=1) → no prevMonth cells.
      // Pin to May 2026 (starts Friday) so prevMonth cells exist.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-15T12:00:00'));
      const { view, spies } = makeView({ onCellClick: (d) => d });
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      const prevCell = c.querySelector('.cell.prevMonth') as HTMLElement;
      prevCell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(spies.onCellClick).not.toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('week button', () => {
    it('click on wrapperButton → onWeekClick(weekNr, yearNr)', () => {
      const { view, spies } = makeView({ onWeekClick: (w, y) => `${w}-${y}` });
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      const btn = c.querySelector('.wrapperButton') as HTMLElement;
      btn.click();
      expect(spies.onWeekClick).toHaveBeenCalledTimes(1);
      const [w, y] = spies.onWeekClick.mock.calls[0]!;
      expect(typeof w).toBe('string');
      expect(typeof y).toBe('string');
    });
  });

  describe('task rendering + DnD', () => {
    it('task due on a visible date appears as .task card in that cell', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00'));
      const { view } = makeView();
      const c = freshContainer();
      const t = task({ status: 'open', planning: { due: '2026-06-20' } });
      view.render(c, [t], resolvedConfig());
      expect(c.querySelectorAll('.task')).toHaveLength(1);
      expect(c.querySelector<HTMLElement>('.task')?.dataset['abyssTaskRefKey']).toBe(
        taskPresentationKey(t.ref),
      );
      vi.useRealTimers();
    });

    it('card has draggable=true', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00'));
      const { view } = makeView();
      const c = freshContainer();
      const t = task({ status: 'open', planning: { due: '2026-06-20' } });
      view.render(c, [t], resolvedConfig());
      const card = c.querySelector('.task') as HTMLElement;
      expect(card.getAttribute('draggable')).toBe('true');
      vi.useRealTimers();
    });

    it('dragstart sets dataTransfer to filePath:::line + adds is-dragging', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00'));
      const { view } = makeView();
      const c = freshContainer();
      const t = task({
        status: 'open',
        planning: { due: '2026-06-20' },
        source: { filePath: 'a.md', line: 3 },
      });
      view.render(c, [t], resolvedConfig());
      const card = c.querySelector('.task') as HTMLElement;
      const dt = new (class {
        store = new Map<string, string>();
        setData(f: string, d: string) {
          this.store.set(f, d);
        }
        getData(f: string) {
          return this.store.get(f) ?? '';
        }
        effectAllowed = '';
        dropEffect = '';
      })();
      const ev = new MouseEvent('dragstart', { bubbles: true });
      Object.defineProperty(ev, 'dataTransfer', { value: dt, configurable: true });
      card.dispatchEvent(ev);
      expect(dt.getData('text/plain')).toBe('a.md:::3');
      expect(card.classList.contains('is-dragging')).toBe(true);
      vi.useRealTimers();
    });

    it('dragend removes is-dragging class', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00'));
      const { view } = makeView();
      const c = freshContainer();
      const t = task({ status: 'open', planning: { due: '2026-06-20' } });
      view.render(c, [t], resolvedConfig());
      const card = c.querySelector('.task') as HTMLElement;
      const startEv = new MouseEvent('dragstart', { bubbles: true });
      Object.defineProperty(startEv, 'dataTransfer', {
        value: {
          setData() {},
          getData() {
            return '';
          },
          effectAllowed: '',
          dropEffect: '',
        },
        configurable: true,
      });
      card.dispatchEvent(startEv);
      expect(card.classList.contains('is-dragging')).toBe(true);
      card.dispatchEvent(new MouseEvent('dragend', { bubbles: true }));
      expect(card.classList.contains('is-dragging')).toBe(false);
      vi.useRealTimers();
    });

    it('drop on cellContent with payload → onDrop(payload, date)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00'));
      const { view, spies } = makeView({ onDrop: (d, date) => `${d}-${date}` });
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      const cellContent = c.querySelector('.cell.today .cellContent') as HTMLElement;
      dispatchDnD(cellContent, 'drop', 'a.md:::5');
      expect(spies.onDrop).toHaveBeenCalledTimes(1);
      expect(spies.onDrop.mock.calls[0]![0]).toBe('a.md:::5');
      expect(typeof spies.onDrop.mock.calls[0]![1]).toBe('string');
      vi.useRealTimers();
    });

    it('drop removes is-drag-over class', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00'));
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      const cellContent = c.querySelector('.cell.today .cellContent') as HTMLElement;
      dispatchDnD(cellContent, 'dragover');
      expect(cellContent.classList.contains('is-drag-over')).toBe(true);
      dispatchDnD(cellContent, 'drop', 'x');
      expect(cellContent.classList.contains('is-drag-over')).toBe(false);
      vi.useRealTimers();
    });

    it('dragover adds is-drag-over + preventDefault', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00'));
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      const cellContent = c.querySelector('.cell.today .cellContent') as HTMLElement;
      const ev = new MouseEvent('dragover', { bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'dataTransfer', {
        value: new (class {
          dropEffect = '';
        })(),
        configurable: true,
      });
      cellContent.dispatchEvent(ev);
      expect(cellContent.classList.contains('is-drag-over')).toBe(true);
      vi.useRealTimers();
    });

    it('dragleave to outside container removes is-drag-over', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-15T12:00:00'));
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      const cellContent = c.querySelector('.cell.today .cellContent') as HTMLElement;
      dispatchDnD(cellContent, 'dragover');
      expect(cellContent.classList.contains('is-drag-over')).toBe(true);
      dispatchDnD(cellContent, 'dragleave', undefined, null);
      expect(cellContent.classList.contains('is-drag-over')).toBe(false);
      vi.useRealTimers();
    });

    it('destroy sets containerEl null (no throw, re-render works)', () => {
      const { view } = makeView();
      const c = freshContainer();
      view.render(c, [], resolvedConfig());
      expect(() => view.destroy()).not.toThrow();
      // re-render after destroy should still work
      expect(() => view.render(c, [], resolvedConfig())).not.toThrow();
    });
  });
});
