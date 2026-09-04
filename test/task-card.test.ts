import { Component, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import type { TaskSnapshot as Task } from '../src/tasks';
import { createTaskCard, type TaskCardOptions } from '../src/ui/TaskCard';
import { expectDefined, task, useRealMoment, withMobile } from './helpers';

useRealMoment();

function fakeApp(): App {
  return {} as App;
}

const statusRegistry = new StatusRegistry(buildDefaultTaskStatuses());

function baseOptions(overrides: Partial<TaskCardOptions> = {}): TaskCardOptions {
  return {
    app: fakeApp(),
    component: new Component(),
    onOpenNote: vi.fn(),
    statusRegistry,
    onContextMenu: vi.fn(),
    ...overrides,
  };
}

describe('createTaskCard', () => {
  describe('color styling (transColor via style attribute)', () => {
    it('noteColor only: derives dark/light via transColor (pinned values)', () => {
      const el = createTaskCard(
        task({ presentation: { noteColor: '#3a3a3a' } }),
        'due',
        baseOptions(),
      );
      const style = el.getAttribute('style');
      expect(style).toBe(
        '--task-background:#3a3a3a33;--task-color:#3a3a3a;--dark-task-text-color:#000000;--light-task-text-color:#7a7a7a',
      );
    });

    it('noteTextColor only: gray background, text colors via transColor of noteTextColor', () => {
      const el = createTaskCard(
        task({ presentation: { noteTextColor: '#ff8800' } }),
        'due',
        baseOptions(),
      );
      expect(el.getAttribute('style')).toBe(
        '--task-background:#7D7D7D33;--task-color:#7D7D7D;--dark-task-text-color:#992200;--light-task-text-color:#ffc840',
      );
    });

    it('both noteColor and noteTextColor: text colors set directly, no transColor call', () => {
      const el = createTaskCard(
        task({ presentation: { noteColor: '#abcdef', noteTextColor: '#123456' } }),
        'due',
        baseOptions(),
      );
      expect(el.getAttribute('style')).toBe(
        '--task-background:#abcdef33;--task-color:#abcdef;--dark-task-text-color:#123456;--light-task-text-color:#123456',
      );
    });

    it('neither: fixed defaults', () => {
      const el = createTaskCard(task(), 'due', baseOptions());
      expect(el.getAttribute('style')).toBe(
        '--task-background:#7D7D7D33;--task-color:#7D7D7D;--dark-task-text-color:#4d4d4d;--light-task-text-color:#a8a8a8',
      );
    });
  });

  describe('DOM structure', () => {
    it('returns an HTMLElement', () => {
      const el = createTaskCard(task(), 'due', baseOptions());
      expect(el).toBeInstanceOf(HTMLElement);
    });

    it('root div has class "task {cls} noNoteIcon" when no noteIcon', () => {
      const el = createTaskCard(task(), 'due', baseOptions());
      expect(el.className).toBe('task due noNoteIcon');
    });

    it('root div has class "task {cls}" (no noNoteIcon) when noteIcon present', () => {
      const el = createTaskCard(task({ presentation: { noteIcon: '🔵' } }), 'due', baseOptions());
      expect(el.className).toBe('task due');
    });

    it('sets data-task-text and title to task.title', () => {
      const el = createTaskCard(task({ title: 'Buy milk' }), 'due', baseOptions());
      expect(el.getAttribute('data-task-text')).toBe('Buy milk');
      expect(el.getAttribute('title')).toBe('Buy milk');
    });

    it('sets data-due iff task.due', () => {
      expect(
        createTaskCard(
          task({ planning: { due: '2026-06-24' } }),
          'due',
          baseOptions(),
        ).getAttribute('data-due'),
      ).toBe('2026-06-24');
      expect(createTaskCard(task(), 'due', baseOptions()).getAttribute('data-due')).toBeNull();
    });
  });

  describe('status marker (default mode)', () => {
    it('renders a status marker in default mode, data-status-type "done" iff status === done', () => {
      const openMarker = createTaskCard(
        task({ status: 'open', statusSymbol: ' ' }),
        'due',
        baseOptions(),
      ).querySelector<HTMLElement>('.abyss-status-marker');
      expect(openMarker?.getAttribute('data-status-type')).toBe('todo');
      const doneMarker = createTaskCard(
        task({ status: 'done', statusSymbol: 'x' }),
        'due',
        baseOptions(),
      ).querySelector<HTMLElement>('.abyss-status-marker');
      expect(doneMarker?.getAttribute('data-status-type')).toBe('done');
    });

    it('omits the status marker in timeblock mode', () => {
      const el = createTaskCard(task(), 'due', baseOptions({ mode: 'timeblock' }));
      expect(el.querySelector('.abyss-status-marker')).toBeNull();
    });

    it('invokes onToggle once on click', () => {
      const onToggle = vi.fn();
      const el = createTaskCard(task({ title: 'x' }), 'due', baseOptions({ onToggle }));
      const marker = el.querySelector('.abyss-status-marker') as HTMLElement;
      marker.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      expect(onToggle).toHaveBeenCalledTimes(1);
      expect((onToggle.mock.calls[0]?.[0] as Task).title).toBe('x');
    });

    it('invokes onContextMenu with the event and task on right-click', () => {
      const onContextMenu = vi.fn();
      const t = task({ title: 'y' });
      const el = createTaskCard(t, 'due', baseOptions({ onContextMenu }));
      const marker = el.querySelector('.abyss-status-marker') as HTMLElement;
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      marker.dispatchEvent(ev);
      expect(onContextMenu).toHaveBeenCalledWith(ev, t);
    });
  });

  describe('note link (de-anchored)', () => {
    it('renders a non-anchor .inner-link wrapper (no nested <a> for the card itself)', () => {
      const el = createTaskCard(task({ source: { filePath: 'notes/x.md' } }), 'due', baseOptions());
      const link = el.querySelector('.inner-link');
      expect(link).not.toBeNull();
      expect(link?.tagName).not.toBe('A');
    });

    it('clicking the card content invokes onOpenNote with the task', () => {
      const onOpenNote = vi.fn();
      const t = task({ source: { filePath: 'notes/x.md' } });
      const el = createTaskCard(t, 'due', baseOptions({ onOpenNote }));
      const link = el.querySelector<HTMLElement>('.inner-link');
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(onOpenNote).toHaveBeenCalledTimes(1);
      expect(onOpenNote.mock.calls[0]?.[0]).toBe(t);
    });

    it('routes a body context interaction without handling the sibling status marker', () => {
      const onTaskBodyContextMenu = vi.fn();
      const t = task({ source: { filePath: 'notes/x.md' } });
      const el = createTaskCard(t, 'due', baseOptions({ onTaskBodyContextMenu }));
      const body = expectDefined(el.querySelector<HTMLElement>('.inner-link'));
      const marker = expectDefined(el.querySelector<HTMLElement>('.abyss-status-marker'));
      const bodyEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });

      body.dispatchEvent(bodyEvent);
      expect(bodyEvent.defaultPrevented).toBe(true);
      expect(onTaskBodyContextMenu).toHaveBeenCalledWith(bodyEvent, t, body);

      const nestedLink = body.createEl('a', { text: 'Linked task text' });
      const linkEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      nestedLink.dispatchEvent(linkEvent);
      expect(linkEvent.defaultPrevented).toBe(false);
      expect(onTaskBodyContextMenu).toHaveBeenCalledOnce();

      marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      expect(onTaskBodyContextMenu).toHaveBeenCalledOnce();
    });
  });

  describe('icon', () => {
    it('maps each known taskClass to its icon', () => {
      const expected: Record<string, string> = {
        done: '✅',
        due: '📅',
        scheduled: '⏳',
        overdue: '⚠️',
        process: '⏺️',
        cancelled: '🚫',
        start: '🛫',
        dailyNote: '📄',
      };
      for (const [cls, icon] of Object.entries(expected)) {
        const el = createTaskCard(task(), cls, baseOptions());
        expect(el.querySelector('.icon')?.textContent).toBe(icon);
      }
    });

    it('uses the shared recurrence badge instead of a repeat emoji for a recurring task', () => {
      const el = createTaskCard(task({ recurrence: 'every week' }), 'recurrence', baseOptions());

      const badge = el.querySelector<HTMLElement>('.abyss-recurrence-badge');
      expect(badge?.dataset['recurrenceValidity']).toBe('valid');
      expect(badge?.getAttribute('aria-label')).toBe('Repeats: every week');
      expect(el.textContent).not.toContain('🔁');
      expect(el.querySelectorAll('.abyss-recurrence-badge-icon')).toHaveLength(1);
    });

    it('uses empty string for an unknown taskClass', () => {
      const el = createTaskCard(task(), 'unknownClass', baseOptions());
      expect(el.querySelector('.icon')?.textContent).toBe('');
    });
  });

  describe('data-relative', () => {
    it('populates data-relative from window.moment(due).fromNow() when due', () => {
      vi.useFakeTimers({ now: new Date('2026-06-24T10:00:00Z').getTime() });
      const el = createTaskCard(task({ planning: { due: '2026-06-24' } }), 'due', baseOptions());
      // exact phrasing depends on locale/timezone; assert it is non-empty
      expect(el.querySelector<HTMLElement>('.description')?.dataset['relative']).toBeTruthy();
      vi.useRealTimers();
    });

    it('sets data-relative to empty string when no due', () => {
      const el = createTaskCard(task(), 'due', baseOptions());
      expect(el.querySelector<HTMLElement>('.description')?.dataset['relative']).toBe('');
    });
  });

  describe('mobile long-press', () => {
    withMobile(true);

    it('attaches long-press and sets userSelect styles', () => {
      const el = createTaskCard(task(), 'due', baseOptions());
      expect(el.style.userSelect).toBe('none');
      expect(el.style.getPropertyValue('-webkit-user-select')).toBe('none');
      expect(el.style.touchAction).toBe('manipulation');
    });
  });
});
