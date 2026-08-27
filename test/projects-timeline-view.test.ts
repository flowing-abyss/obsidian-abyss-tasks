// eslint-disable-next-line import/no-nodejs-modules -- responsive geometry contract loads shipped CSS.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  renderTimeline,
  renderWorkNotesTimeline,
  type TimelineEntry,
} from '../src/panels/projects/ProjectsTimelineView';
import type { LogicalViewportSession } from '../src/panels/projects/ProjectWorkspaceSession';
import type { TimelineItem } from '../src/panels/projects/timelineProjection';
import type { WorkNoteSnapshot } from '../src/projects/work-notes/types';
import { flushMicrotasks, freshContainer } from './helpers';

const shippedStyles = readFileSync(`${import.meta.dirname}/../styles.css`, 'utf8');

interface Fixture {
  readonly id: string;
}

function point(id: string, date = '2026-08-27'): TimelineEntry<Fixture> {
  return {
    value: { id },
    label: id,
    item: {
      kind: 'point',
      key: `task:${id}`,
      atMs: Date.parse(`${date}T00:00:00.000Z`),
      role: 'due',
    },
    dateByRole: { due: date },
  };
}

function entry(item: TimelineItem, id: string): TimelineEntry<Fixture> {
  return { value: { id }, label: id, item, dateByRole: {} };
}

function range(id: string): TimelineEntry<Fixture> {
  return {
    value: { id },
    label: id,
    item: {
      kind: 'range',
      key: `task:${id}`,
      startMs: Date.UTC(2026, 7, 27),
      endMs: Date.UTC(2026, 7, 29),
    },
    dateByRole: { start: '2026-08-27', end: '2026-08-29' },
  };
}

describe('shared Timeline view', () => {
  it('draws ranges and retained-role points against the shared date spine', () => {
    const container = freshContainer();
    renderTimeline(container, {
      entries: [
        {
          value: { id: 'Range' },
          label: 'Range',
          item: {
            kind: 'range',
            key: 'project:Range',
            startMs: Date.UTC(2026, 7, 27),
            endMs: Date.UTC(2026, 7, 29),
          },
          dateByRole: { start: '2026-08-27', end: '2026-08-29' },
        },
        point('Point', '2026-08-28'),
      ],
      dateWindow: { from: '2026-08-26', to: '2026-08-30' },
    });

    expect(container.querySelector('[data-timeline-range]')).not.toBeNull();
    expect(container.querySelector('[data-timeline-point="due"]')).not.toBeNull();
  });

  it('keeps long ranges visible in a bounded date spine that still reaches the final date', () => {
    const container = freshContainer();
    renderTimeline(container, {
      entries: [
        {
          value: { id: 'Year' },
          label: 'Year',
          item: {
            kind: 'range',
            key: 'project:Year',
            startMs: Date.UTC(2026, 0, 1),
            endMs: Date.UTC(2026, 11, 31),
          },
          dateByRole: { start: '2026-01-01', end: '2026-12-31' },
        },
      ],
      dateWindow: { from: '2026-01-01', to: '2026-12-31' },
    });

    expect(container.querySelectorAll('[data-timeline-drop-date]').length).toBeLessThanOrEqual(42);
    expect(container.querySelector('[data-timeline-drop-date="2026-12-31"]')).not.toBeNull();
    expect(container.querySelector('[data-timeline-range]')).not.toBeNull();
  });

  it('routes drag, keyboard, and native date-picker changes through the same retained-role command', async () => {
    const container = freshContainer();
    const onSetDate = vi.fn().mockResolvedValue({ type: 'ok' });
    renderTimeline(container, {
      entries: [point('A')],
      onSetDate,
      dateWindow: { from: '2026-08-26', to: '2026-08-30' },
    });
    const handle = container.querySelector<HTMLElement>('[data-timeline-role="due"]')!;
    const picker = container.querySelector<HTMLInputElement>('[data-timeline-date-picker="due"]')!;

    handle.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    picker.value = '2026-08-29';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    handle.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }));
    container
      .querySelector<HTMLElement>('[data-timeline-drop-date="2026-08-30"]')!
      .dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    await flushMicrotasks();

    expect(onSetDate.mock.calls.map((call) => call.slice(1, 3))).toEqual([
      ['due', '2026-08-28'],
      ['due', '2026-08-29'],
      ['due', '2026-08-30'],
    ]);
  });

  it('keeps invalid and undated items outside the desktop date grid', () => {
    const container = freshContainer();
    renderTimeline(container, {
      entries: [
        point('Dated'),
        entry({ kind: 'undated', key: 'project:Undated' }, 'Undated'),
        entry({ kind: 'invalid', key: 'project:Broken', reason: 'reversed' }, 'Broken'),
      ],
    });

    expect(container.querySelectorAll('.abyss-timeline-row')).toHaveLength(1);
    expect(container.querySelector('.abyss-timeline-undated')?.textContent).toContain('Undated');
    expect(container.querySelector('.abyss-timeline-invalid')?.textContent).toContain('Broken');
    expect(container.querySelector('.abyss-timeline-invalid')?.textContent).toContain('reversed');
  });

  it('renders a narrow vertical agenda without a horizontal date grid', () => {
    const container = freshContainer();
    renderTimeline(container, {
      entries: [point('A'), entry({ kind: 'undated', key: 'task:B' }, 'B')],
      isNarrow: true,
    });

    const root = container.querySelector<HTMLElement>('.abyss-timeline')!;
    expect(root.classList.contains('is-agenda')).toBe(true);
    expect(container.querySelector('.abyss-timeline-axis')).toBeNull();
    expect(container.querySelector('.abyss-timeline-agenda-date')?.textContent).toContain(
      '2026-08-27',
    );
    expect(root.scrollWidth).toBeLessThanOrEqual(root.clientWidth);
  });

  it('restores deep logical focus and scroll from stable keys after a remount', () => {
    const entries = Array.from({ length: 160 }, (_, index) => point(String(index)));
    const session: LogicalViewportSession = {
      firstKey: 'task:118',
      firstIndex: 118,
      focusedKey: 'task:123',
      restoreFocus: true,
    };
    const first = freshContainer();
    activeDocument.body.append(first);
    const firstHandle = renderTimeline(first, { entries, session });
    const firstScroll = first.querySelector<HTMLElement>('.abyss-timeline-scroll')!;

    expect(first.querySelectorAll('.abyss-timeline-row').length).toBeLessThan(40);
    expect(firstScroll.scrollTop).toBeGreaterThan(0);
    expect(first.ownerDocument.activeElement?.getAttribute('data-timeline-key')).toBe('task:123');
    firstHandle.destroy();

    const second = freshContainer();
    activeDocument.body.append(second);
    renderTimeline(second, { entries, session });
    expect(second.querySelector<HTMLElement>('.abyss-timeline-scroll')!.scrollTop).toBe(
      firstScroll.scrollTop,
    );
    expect(second.ownerDocument.activeElement?.getAttribute('data-timeline-key')).toBe('task:123');
    first.remove();
    second.remove();
  });

  it('restores pure deep scroll after browser clamping without requiring a focused row', () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
    const positions = new WeakMap<HTMLElement, number>();
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get() {
        return positions.get(this as HTMLElement) ?? 0;
      },
      set(value: number) {
        const element = this as HTMLElement;
        const hasExtent = element.querySelector('[data-bounded-window-edge]') !== null;
        positions.set(element, hasExtent ? value : 0);
      },
    });
    try {
      const entries = Array.from({ length: 180 }, (_, index) => point(String(index)));
      const session: LogicalViewportSession = {
        firstKey: 'task:132',
        firstIndex: 132,
        focusedKey: null,
        restoreFocus: false,
      };
      const container = freshContainer();

      renderTimeline(container, { entries, session });

      const scroll = container.querySelector<HTMLElement>('.abyss-timeline-scroll')!;
      expect(scroll.scrollTop).toBeGreaterThan(0);
      expect(container.querySelector('[data-timeline-key="task:132"]')).not.toBeNull();
      expect(session.firstIndex).toBe(132);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollTop', original);
      else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTop;
    }
  });

  it('retains the logical row when a date control initiates a successful remount', async () => {
    const entries = Array.from({ length: 40 }, (_, index) => point(String(index)));
    const session: LogicalViewportSession = {
      firstKey: null,
      firstIndex: 0,
      focusedKey: null,
      restoreFocus: false,
    };
    const first = freshContainer();
    activeDocument.body.append(first);
    const firstHandle = renderTimeline(first, {
      entries,
      session,
      onSetDate: () => ({ type: 'ok' }),
    });
    const picker = first.querySelector<HTMLInputElement>(
      '[data-timeline-key="task:4"] [data-timeline-date-picker="due"]',
    )!;
    picker.focus();
    picker.value = '2026-08-30';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await flushMicrotasks();
    firstHandle.destroy();

    const second = freshContainer();
    activeDocument.body.append(second);
    renderTimeline(second, { entries, session });

    expect(session.focusedKey).toBe('task:4');
    expect(second.ownerDocument.activeElement?.getAttribute('data-timeline-key')).toBe('task:4');
    first.remove();
    second.remove();
  });

  it('uses one measured fixed row extent for wrapped mobile ranges and deep spacers', () => {
    const style = activeDocument.head.createEl('style');
    style.textContent = shippedStyles;
    const entries = Array.from({ length: 180 }, (_, index) => range(String(index)));
    const session: LogicalViewportSession = {
      firstKey: 'task:120',
      firstIndex: 120,
      focusedKey: null,
      restoreFocus: false,
    };
    const container = freshContainer();
    activeDocument.body.append(container);
    try {
      renderTimeline(container, { entries, session, isNarrow: true });
      const scroll = container.querySelector<HTMLElement>('.abyss-timeline-scroll')!;
      const row = container.querySelector<HTMLElement>('[data-timeline-key="task:120"]')!;
      const startSpacer = container.querySelector<HTMLElement>(
        '[data-bounded-window-edge="start"]',
      )!;

      expect(getComputedStyle(row).blockSize).toBe('72px');
      expect(scroll.scrollTop).toBe(120 * 72);
      expect(Number.parseInt(startSpacer.style.blockSize, 10) % 72).toBe(0);
      expect(container.querySelectorAll('.abyss-timeline-row').length).toBeLessThan(40);
    } finally {
      container.remove();
      style.remove();
    }
  });

  it('keeps large undated and invalid mobile backlogs reachable through bounded scrollers', () => {
    const entries = [
      ...Array.from({ length: 180 }, (_, index) =>
        entry({ kind: 'undated', key: `task:u${String(index)}` }, `Undated ${String(index)}`),
      ),
      ...Array.from({ length: 180 }, (_, index) =>
        entry(
          { kind: 'invalid', key: `task:i${String(index)}`, reason: 'invalid-due' },
          `Invalid ${String(index)}`,
        ),
      ),
    ];
    const container = freshContainer();
    renderTimeline(container, { entries, isNarrow: true });
    const scrollers = container.querySelectorAll<HTMLElement>('.abyss-timeline-diagnostic-scroll');

    expect(scrollers).toHaveLength(2);
    for (const scroll of scrollers) {
      Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 160 });
      scroll.scrollTop = 150 * 32;
      scroll.dispatchEvent(new Event('scroll'));
    }
    expect(container.textContent).toContain('Undated 150');
    expect(container.textContent).toContain('Invalid 150');
    expect(container.querySelectorAll('.abyss-timeline-diagnostic-row').length).toBeLessThan(50);
  });

  it('presents failed mutation results and returns focus to the initiating control', async () => {
    const container = freshContainer();
    activeDocument.body.append(container);
    renderTimeline(container, {
      entries: [point('A')],
      onSetDate: () => Promise.resolve({ type: 'conflict' }),
    });
    const handle = container.querySelector<HTMLElement>('[data-timeline-role="due"]')!;

    handle.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
    );
    await flushMicrotasks();

    expect(container.querySelector<HTMLElement>('[data-timeline-feedback]')?.dataset).toMatchObject(
      {
        resultType: 'conflict',
      },
    );
    expect(activeDocument.activeElement).toBe(handle);
    container.remove();
  });

  it('uses the retained milestone role to create the guarded Work Note end field', async () => {
    const container = freshContainer();
    const note: WorkNoteSnapshot = {
      path: 'Work Notes/Milestone.md',
      presetRevision: 1,
      presetFingerprint: 'fingerprint',
      kind: 'milestone',
      projectPath: 'Projects/A.md',
      statusId: null,
      rawStatus: null,
      writableStatusShape: true,
      updated: '2026-08-27',
      range: {},
      blockedByPaths: [],
      relatedPaths: [],
      diagnostics: [],
    };
    const observed = {
      path: note.path,
      presetRevision: 1,
      presetFingerprint: 'fingerprint',
      projectPath: note.projectPath,
      kind: note.kind,
      fields: { Updated: '2026-08-27T09:15:00+07:00' },
    };
    const setRange = vi.fn().mockResolvedValue({ type: 'ok', path: note.path });
    renderWorkNotesTimeline(container, {
      notes: [note],
      commands: {
        observeRange: () => ({
          observed,
          updated: {
            raw: '2026-08-27T09:15:00+07:00',
            precision: 'datetime',
            instantMs: Date.parse('2026-08-27T09:15:00+07:00'),
          },
        }),
        setRange,
      } as never,
    });

    container
      .querySelector<HTMLElement>('[data-timeline-role="milestone"]')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      );
    await flushMicrotasks();

    expect(setRange).toHaveBeenCalledWith(observed, {
      end: expect.objectContaining({
        raw: '2026-08-28T09:15:00+07:00',
        precision: 'datetime',
      }),
    });
  });

  it('uses one render-time Work Note observation for both exact raw movement and guarding', async () => {
    const container = freshContainer();
    const note: WorkNoteSnapshot = {
      path: 'Work Notes/Race.md',
      presetRevision: 1,
      presetFingerprint: 'fingerprint',
      kind: 'ordinary',
      projectPath: 'Projects/A.md',
      statusId: null,
      rawStatus: null,
      writableStatusShape: true,
      range: {
        start: {
          raw: '2026-08-27T14:30:15+07:00',
          precision: 'datetime',
          instantMs: Date.parse('2026-08-27T14:30:15+07:00'),
        },
      },
      blockedByPaths: [],
      relatedPaths: [],
      diagnostics: [],
    };
    const renderedGuard = { path: note.path, fields: { Start: note.range.start!.raw } };
    const freshGuard = { path: note.path, fields: { Start: '2026-08-28T09:00:00+02:00' } };
    const observe = vi.fn().mockReturnValue(freshGuard);
    const observeRange = vi.fn().mockReturnValue({
      observed: renderedGuard,
      start: note.range.start,
    });
    const setRange = vi.fn().mockResolvedValue({ type: 'conflict', field: 'start' });
    renderWorkNotesTimeline(container, {
      notes: [note],
      commands: { observe, observeRange, setRange } as never,
    });

    const picker = container.querySelector<HTMLInputElement>(
      '[data-timeline-date-picker="start"]',
    )!;
    picker.value = '2026-08-30';
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await flushMicrotasks();

    expect(observeRange).toHaveBeenCalledOnce();
    expect(observe).not.toHaveBeenCalled();
    expect(setRange).toHaveBeenCalledWith(renderedGuard, {
      start: expect.objectContaining({ raw: '2026-08-30T14:30:15+07:00' }),
    });
  });

  it('keeps Work Note Timeline date controls disabled without accepted update capability', async () => {
    const container = freshContainer();
    const note: WorkNoteSnapshot = {
      path: 'Work Notes/Guarded.md',
      presetRevision: 1,
      presetFingerprint: 'fingerprint',
      kind: 'ordinary',
      projectPath: 'Projects/A.md',
      statusId: null,
      rawStatus: null,
      writableStatusShape: true,
      range: {
        start: {
          raw: '2026-08-27',
          precision: 'date',
          instantMs: Date.UTC(2026, 7, 27),
        },
      },
      blockedByPaths: [],
      relatedPaths: [],
      diagnostics: [],
    };
    const setRange = vi.fn();
    renderWorkNotesTimeline(container, {
      notes: [note],
      commandsEnabled: false,
      commands: { observe: vi.fn(), setRange } as never,
    });
    const handle = container.querySelector<HTMLButtonElement>('[data-timeline-role="start"]')!;

    expect(handle.disabled).toBe(true);
    expect(
      container.querySelector<HTMLInputElement>('[data-timeline-date-picker="start"]')?.disabled,
    ).toBe(true);
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flushMicrotasks();
    expect(setRange).not.toHaveBeenCalled();
  });
});
