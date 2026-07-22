import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Component, type App } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { renderAllDayCell } from '../src/views/timegrid/renderAllDay';
import { dispatchDnD, freshContainer, task, taskComment, taskFromCodecLine } from './helpers';

const registry = new StatusRegistry(buildDefaultTaskStatuses());
const fakeApp = {} as App;

const css = readFileSync(resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\\,/gu, ',');
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, 'u').exec(css);
  return match?.groups?.['body'] ?? '';
}

const callbacks = () => ({
  app: fakeApp,
  component: new Component(),
  onTaskClick: vi.fn(),
  onDrop: vi.fn(),
  onStartChange: vi.fn(),
  onDueChange: vi.fn(),
  onExtendToSpan: vi.fn(),
  onToggle: vi.fn(),
  onSetStatus: vi.fn(),
  onSetPriority: vi.fn(),
  statusRegistry: registry,
});

describe('renderAllDayCell', () => {
  it('never sets data-priority on a plain chip or span, even for a prioritized task (calendar body no longer renders a priority border)', () => {
    const container = freshContainer();
    const prioritized = task({ priority: 'B', title: 'Plain', planning: { due: '2026-07-10' } });
    renderAllDayCell(container, '2026-07-10', [], [prioritized], [], callbacks());
    const chip = container.querySelector('.tc-tg-plain') as HTMLElement;
    expect(chip.hasAttribute('data-priority')).toBe(false);

    const container2 = freshContainer();
    const none = task({ priority: 'D', title: 'Plain', planning: { due: '2026-07-10' } });
    renderAllDayCell(container2, '2026-07-10', [], [none], [], callbacks());
    const chip2 = container2.querySelector('.tc-tg-plain') as HTMLElement;
    expect(chip2.hasAttribute('data-priority')).toBe(false);
  });

  it('sets --tc-tag-color on a plain chip when a tag matches a configured tag group', () => {
    const container = freshContainer();
    const t = task({
      title: 'Plain',
      tags: ['#work'],
      planning: { due: '2026-07-10' },
      source: { originalMarkdown: '- [ ] t #work', originalBlock: '- [ ] t #work' },
    });
    renderAllDayCell(container, '2026-07-10', [], [t], [], callbacks(), [
      { id: '1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#3498db' },
    ]);
    const chip = container.querySelector('.tc-tg-plain') as HTMLElement;
    expect(chip.style.getPropertyValue('--tc-tag-color')).toBe('#3498db');
  });

  it('sets data-priority on a deadline marker but never --tc-tag-color (structural pill, no fill)', () => {
    const container = freshContainer();
    const t = task({
      priority: 'A',
      title: 'Deadline',
      tags: ['#work'],
      planning: { due: '2026-07-10', scheduled: '2026-07-05' },
      source: {
        originalMarkdown: '- [ ] t #work 📅 2026-07-10',
        originalBlock: '- [ ] t #work 📅 2026-07-10',
      },
    });
    renderAllDayCell(container, '2026-07-10', [], [], [t], callbacks(), [
      { id: '1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#3498db' },
    ]);
    const marker = container.querySelector('.tc-tg-deadline-marker') as HTMLElement;
    expect(marker.getAttribute('data-priority')).toBe('A');
    expect(marker.style.getPropertyValue('--tc-tag-color')).toBe('');
  });

  it('renders a plain task as a draggable chip', () => {
    const container = freshContainer();
    const t = task({ title: 'Plain', planning: { due: '2026-07-10' } });
    renderAllDayCell(container, '2026-07-10', [], [t], [], callbacks());
    const chip = container.querySelector('.tc-tg-plain') as HTMLElement;
    expect(chip.getAttribute('draggable')).toBe('true');
    expect(chip.textContent).toContain('Plain');
  });

  it('renders a multi-day span as an interactive terminal only on its due date', () => {
    const container = freshContainer();
    const t = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-12' } });
    renderAllDayCell(container, '2026-07-12', [t], [], [], callbacks());
    const bar = container.querySelector('.tc-tg-span') as HTMLElement;
    expect(bar.getAttribute('draggable')).toBe('true');
  });

  it('renders non-terminal span dates as non-interactive continuations and the due date as one terminal with both edges', () => {
    const t = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-12' } });

    const startContainer = freshContainer();
    renderAllDayCell(startContainer, '2026-07-08', [t], [], [], callbacks());
    expect(startContainer.querySelectorAll('.tc-status-marker')).toHaveLength(0);
    const start = startContainer.querySelector('.tc-tg-span-continuation') as HTMLElement;
    expect(start).not.toBeNull();
    expect(start.hasAttribute('draggable')).toBe(false);
    expect(start.hasAttribute('tabindex')).toBe(false);
    expect(start.querySelectorAll('.tc-tg-span-edge')).toHaveLength(0);

    const midContainer = freshContainer();
    renderAllDayCell(midContainer, '2026-07-10', [t], [], [], callbacks());
    const middle = midContainer.querySelector('.tc-tg-span-continuation') as HTMLElement;
    expect(middle).not.toBeNull();
    expect(middle.querySelectorAll('.tc-tg-span-edge')).toHaveLength(0);

    const dueContainer = freshContainer();
    renderAllDayCell(dueContainer, '2026-07-12', [t], [], [], callbacks());
    expect(dueContainer.querySelectorAll('.tc-status-marker')).toHaveLength(1);
    expect(dueContainer.querySelectorAll('.tc-tg-span-edge')).toHaveLength(2);
    expect((dueContainer.querySelector('.tc-tg-span') as HTMLElement).draggable).toBe(true);
  });

  it('keeps a span continuation tag-filled, click-guarded, and contextmenu-openable without making it draggable', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const onCreateAtDate = vi.fn();
    const t = task({
      title: 'Trip',
      tags: ['#work'],
      planning: { start: '2026-07-08', due: '2026-07-12' },
      source: { originalMarkdown: '- [ ] Trip #work', originalBlock: '- [ ] Trip #work' },
    });
    renderAllDayCell(container, '2026-07-10', [t], [], [], { ...cbs, onCreateAtDate }, [
      { id: '1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#3498db' },
    ]);
    const ghost = container.querySelector('.tc-tg-span-continuation') as HTMLElement;
    expect(ghost.style.getPropertyValue('--tc-tag-color')).toBe('#3498db');
    expect(ghost.querySelector('.tc-tg-body-title')).not.toBeNull();
    expect(ghost.querySelector('.tc-status-marker')).toBeNull();
    ghost.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onCreateAtDate).not.toHaveBeenCalled();
    ghost.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(cbs.onTaskClick).toHaveBeenCalledWith(t);
  });

  it('renders a human-readable plain continuation title while the due terminal retains rich rendering', () => {
    const t = taskFromCodecLine(
      '- [ ] Trip to [[Note]] with **bold**, ~~old~~ and `code` [site](https://example.test) 🛫 2026-07-08 📅 2026-07-12',
    );
    expect(t.title).toBe('Trip to 🔗 Note with **bold**, ~~old~~ and `code` 🌐 site');
    const continuationCell = freshContainer();
    const terminalCell = freshContainer();

    renderAllDayCell(continuationCell, '2026-07-10', [t], [], [], callbacks());
    renderAllDayCell(terminalCell, '2026-07-12', [t], [], [], callbacks());

    const continuation = continuationCell.querySelector('.tc-tg-span-continuation');
    const terminal = terminalCell.querySelector('.tc-tg-span');
    expect(continuation?.querySelector('.tc-md')).toBeNull();
    expect(continuation?.querySelector('a')).toBeNull();
    expect(continuation?.querySelector('.tc-tg-body-title')?.textContent).toBe(
      'Trip to 🔗 Note with bold, old and code 🌐 site',
    );
    expect(continuation?.textContent).not.toContain('[[');
    expect(continuation?.textContent).not.toContain('**');
    expect(continuation?.textContent).not.toContain('~~');
    expect(continuation?.textContent).not.toContain('`');
    expect(terminal?.querySelector('.tc-md')).not.toBeNull();
  });

  it("uses the continuation's 18% tag fill when choosing a readable title-text variant", () => {
    const originalBackground = document.body.style.getPropertyValue('--background-primary');
    document.body.style.setProperty('--background-primary', '#444444');
    try {
      const t = task({
        title: 'Trip',
        tags: ['#work'],
        planning: { start: '2026-07-08', due: '2026-07-12' },
        source: { originalMarkdown: '- [ ] Trip #work', originalBlock: '- [ ] Trip #work' },
      });
      const tagGroups = [
        { id: '1', name: 'Work', mode: 'prefix' as const, prefix: 'work', color: '#fff' },
      ];
      const continuationCell = freshContainer();
      const terminalCell = freshContainer();

      renderAllDayCell(continuationCell, '2026-07-10', [t], [], [], callbacks(), tagGroups);
      renderAllDayCell(terminalCell, '2026-07-12', [t], [], [], callbacks(), tagGroups);

      expect(
        (
          continuationCell.querySelector('.tc-tg-span-continuation') as HTMLElement
        ).style.getPropertyValue('--tc-tag-text-color'),
      ).toBe('var(--tc-tag-text-light)');
      expect(
        (terminalCell.querySelector('.tc-tg-span') as HTMLElement).style.getPropertyValue(
          '--tc-tag-text-color',
        ),
      ).toBe('var(--tc-tag-text-dark)');
    } finally {
      document.body.style.setProperty('--background-primary', originalBackground);
    }
  });

  it('styles span continuations as translucent dashed tag-aware ghosts', () => {
    const declarations = declarationsFor('.tc-tg-span-continuation');
    expect(declarations).toMatch(/opacity\s*:\s*0\.55/u);
    expect(declarations).toMatch(
      /border\s*:\s*1px dashed var\(--tc-tag-color,\s*var\(--background-modifier-border\)\)/u,
    );
    expect(declarations).toMatch(
      /background\s*:\s*color-mix\(\s*in srgb,\s*var\(--tc-tag-color,\s*var\(--interactive-accent\)\) 18%,\s*transparent\s*\)/u,
    );
    expect(declarations).toMatch(/cursor\s*:\s*default/u);
  });

  it('renders a deadline marker as non-draggable, structurally distinct from a plain chip', () => {
    const container = freshContainer();
    const t = task({ title: 'Deadline', planning: { due: '2026-07-10', scheduled: '2026-07-05' } });
    renderAllDayCell(container, '2026-07-10', [], [], [t], callbacks());
    const marker = container.querySelector('.tc-tg-deadline-marker') as HTMLElement;
    expect(marker).not.toBeNull();
    expect(marker.hasAttribute('draggable')).toBe(false);
    expect(container.querySelector('.tc-tg-plain')).toBeNull();
    expect(container.querySelector('.tc-tg-span')).toBeNull();
  });

  it('a plain click on a plain chip does NOT fire onTaskClick (reserved for drag)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Plain', planning: { due: '2026-07-10' } });
    renderAllDayCell(container, '2026-07-10', [], [t], [], cbs);
    (container.querySelector('.tc-tg-plain') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('a right-click (contextmenu) on a plain chip fires onTaskClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Plain', planning: { due: '2026-07-10' } });
    renderAllDayCell(container, '2026-07-10', [], [t], [], cbs);
    (container.querySelector('.tc-tg-plain') as HTMLElement).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    expect(cbs.onTaskClick).toHaveBeenCalledWith(t);
  });

  it('a plain click on a span continuation does NOT fire onTaskClick (reserved for drag)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-12' } });
    renderAllDayCell(container, '2026-07-10', [t], [], [], cbs);
    (container.querySelector('.tc-tg-span-continuation') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('a right-click (contextmenu) on a span continuation fires onTaskClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-12' } });
    renderAllDayCell(container, '2026-07-10', [t], [], [], cbs);
    (container.querySelector('.tc-tg-span-continuation') as HTMLElement).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    expect(cbs.onTaskClick).toHaveBeenCalledWith(t);
  });

  it('a plain click on a deadline marker does NOT fire onTaskClick (reserved for drag)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Deadline', planning: { due: '2026-07-10', scheduled: '2026-07-05' } });
    renderAllDayCell(container, '2026-07-10', [], [], [t], cbs);
    (container.querySelector('.tc-tg-deadline-marker') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('a right-click (contextmenu) on a deadline marker fires onTaskClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Deadline', planning: { due: '2026-07-10', scheduled: '2026-07-05' } });
    renderAllDayCell(container, '2026-07-10', [], [], [t], cbs);
    (container.querySelector('.tc-tg-deadline-marker') as HTMLElement).dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }),
    );
    expect(cbs.onTaskClick).toHaveBeenCalledWith(t);
  });

  it('renders a status marker as the first child of a plain chip; clicking it fires onToggle, not onTaskClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Plain', planning: { due: '2026-07-10' } });
    renderAllDayCell(container, '2026-07-10', [], [t], [], cbs);
    const chip = container.querySelector('.tc-tg-plain') as HTMLElement;
    const marker = chip.querySelector('.tc-status-marker');
    expect(marker).not.toBeNull();
    expect(chip.firstElementChild).toBe(marker);
    (marker as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onToggle).toHaveBeenCalledWith(t);
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('renders a status marker as the first child of a span body; clicking it fires onToggle, not onTaskClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-12' } });
    renderAllDayCell(container, '2026-07-12', [t], [], [], cbs);
    const bar = container.querySelector('.tc-tg-span') as HTMLElement;
    const marker = bar.querySelector('.tc-status-marker');
    expect(marker).not.toBeNull();
    expect(bar.firstElementChild).toBe(marker);
    (marker as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onToggle).toHaveBeenCalledWith(t);
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('renders a status marker as the first child of a deadline marker; clicking it fires onToggle, not onTaskClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Deadline', planning: { due: '2026-07-10', scheduled: '2026-07-05' } });
    renderAllDayCell(container, '2026-07-10', [], [], [t], cbs);
    const marker_el = container.querySelector('.tc-tg-deadline-marker') as HTMLElement;
    const marker = marker_el.querySelector('.tc-status-marker');
    expect(marker).not.toBeNull();
    expect(marker_el.firstElementChild).toBe(marker);
    (marker as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onToggle).toHaveBeenCalledWith(t);
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('renders the status marker and title as flex-row siblings in one line on a plain chip (Task 21: was stacking on separate lines)', () => {
    const container = freshContainer();
    const t = task({ title: 'Plain', planning: { due: '2026-07-10' } });
    renderAllDayCell(container, '2026-07-10', [], [t], [], callbacks());
    const chip = container.querySelector('.tc-tg-plain') as HTMLElement;
    const marker = chip.querySelector('.tc-status-marker');
    const title = chip.querySelector('.tc-tg-body-title');
    expect(marker).not.toBeNull();
    expect(title).not.toBeNull();
    expect(marker?.nextElementSibling).toBe(title);
  });

  it('renders the status marker and title as flex-row siblings in one line on a span body (Task 21)', () => {
    const container = freshContainer();
    const t = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-12' } });
    renderAllDayCell(container, '2026-07-12', [t], [], [], callbacks());
    const bar = container.querySelector('.tc-tg-span') as HTMLElement;
    const marker = bar.querySelector('.tc-status-marker');
    const title = bar.querySelector('.tc-tg-body-title');
    expect(marker).not.toBeNull();
    expect(title).not.toBeNull();
    expect(marker?.nextElementSibling).toBe(title);
  });

  it('right-clicking the status marker on a plain chip opens the status/priority popover and does NOT fire onTaskClick (distinct from the chip contextmenu)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Plain', planning: { due: '2026-07-10' } });
    renderAllDayCell(container, '2026-07-10', [], [t], [], cbs);
    const marker = container.querySelector('.tc-tg-plain .tc-status-marker') as HTMLElement;
    marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(document.querySelector('.tc-status-popover')).not.toBeNull();
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('picking a status from the popover on a plain chip fires onSetStatus, and a priority flag fires onSetPriority', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Plain', planning: { due: '2026-07-10' } });
    renderAllDayCell(container, '2026-07-10', [], [t], [], cbs);
    const marker = container.querySelector('.tc-tg-plain .tc-status-marker') as HTMLElement;
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

  it('right-clicking the status marker on a deadline marker opens the popover, fires onSetStatus/onSetPriority, and does NOT fire onTaskClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Deadline', planning: { due: '2026-07-10', scheduled: '2026-07-05' } });
    renderAllDayCell(container, '2026-07-10', [], [], [t], cbs);
    const marker = container.querySelector(
      '.tc-tg-deadline-marker .tc-status-marker',
    ) as HTMLElement;
    marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(document.querySelector('.tc-status-popover')).not.toBeNull();
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
    const statusRow = document.querySelector('.tc-status-popover-row') as HTMLElement;
    statusRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onSetStatus).toHaveBeenCalledWith(t, expect.any(String));
  });

  it("dropping onto the cell fires onDrop with the payload and this cell's date", () => {
    const container = freshContainer();
    const cbs = callbacks();
    renderAllDayCell(container, '2026-07-10', [], [], [], cbs);
    dispatchDnD(container, 'drop', 'f.md:::0');
    expect(cbs.onDrop).toHaveBeenCalledWith('f.md:::0', '2026-07-10');
  });

  it("pointer-dragging a span's right edge fires onDueChange through its real pointerup path", () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-10' } });
    // Right (due) edge handle only renders on the due-date cell, per the rule that
    // edge handles appear only on the day matching start/due respectively.
    renderAllDayCell(container, '2026-07-10', [t], [], [], cbs);
    const bar = container.querySelector('.tc-tg-span') as HTMLElement;
    const rightHandle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;
    const originalElementFromPoint = activeDocument.elementFromPoint;
    activeDocument.elementFromPoint = () => container;
    try {
      rightHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    } finally {
      activeDocument.elementFromPoint = originalElementFromPoint;
    }
    expect(cbs.onDueChange).toHaveBeenCalledWith(t, '2026-07-10');
    expect(bar.getAttribute('draggable')).toBe('true');
    expect(bar.hasClass('is-edge-resizing')).toBe(false);
  });

  it('renders a plain chip title via renderTaskText (markdown-link-aware), not raw textContent, for a task with a [[wikilink]]', () => {
    const container = freshContainer();
    const t = task({
      title: 'see [[Note]]',
      markdownTitle: 'see [[Note]]',
      planning: { due: '2026-07-10' },
    });
    renderAllDayCell(container, '2026-07-10', [], [t], [], callbacks());
    const chip = container.querySelector('.tc-tg-plain') as HTMLElement;
    // MarkdownRenderer is a noop in this test harness (see test/center-panel-integration.test.ts
    // and friends); the `.tc-md` holder — only created when renderTaskText detects link syntax —
    // is the reliable signal that markdown rendering (not a raw textContent assignment showing
    // literal brackets) is in effect.
    expect(chip.querySelector('.tc-md')).not.toBeNull();
  });

  it('renders a deadline marker title via renderTaskText for a task with a [[wikilink]]', () => {
    const container = freshContainer();
    const t = task({
      title: 'see [[Note]]',
      markdownTitle: 'see [[Note]]',
      planning: { due: '2026-07-10', scheduled: '2026-07-05' },
    });
    renderAllDayCell(container, '2026-07-10', [], [], [t], callbacks());
    const marker = container.querySelector('.tc-tg-deadline-marker') as HTMLElement;
    expect(marker.querySelector('.tc-md')).not.toBeNull();
    expect(marker.textContent).toContain('📅');
  });

  it('renders plain title text (no [[links]]) via the renderTaskText fast path, unchanged from before', () => {
    const container = freshContainer();
    const t = task({ title: 'Plain', markdownTitle: 'Plain', planning: { due: '2026-07-10' } });
    renderAllDayCell(container, '2026-07-10', [], [t], [], callbacks());
    const chip = container.querySelector('.tc-tg-plain') as HTMLElement;
    expect(chip.querySelector('.tc-md')).toBeNull();
    expect(chip.textContent).toContain('Plain');
  });

  it("pointer-dragging a span's left edge fires onStartChange through its real pointerup path", () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-10' } });
    renderAllDayCell(container, '2026-07-10', [t], [], [], cbs);
    const bar = container.querySelector('.tc-tg-span') as HTMLElement;
    const leftHandle = container.querySelector('.tc-tg-span-edge--left') as HTMLElement;
    const originalElementFromPoint = activeDocument.elementFromPoint;
    activeDocument.elementFromPoint = () => container;
    try {
      leftHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
    } finally {
      activeDocument.elementFromPoint = originalElementFromPoint;
    }
    expect(cbs.onStartChange).toHaveBeenCalledWith(t, '2026-07-10');
    expect(cbs.onDueChange).not.toHaveBeenCalled();
    expect(bar.getAttribute('draggable')).toBe('true');
    expect(bar.hasClass('is-edge-resizing')).toBe(false);
  });

  it('cancels the previously armed terminal edge before a second pointer can resolve it', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-10' } });
    renderAllDayCell(container, '2026-07-10', [t], [], [], cbs);
    const bar = container.querySelector('.tc-tg-span') as HTMLElement;
    const leftHandle = container.querySelector('.tc-tg-span-edge--left') as HTMLElement;
    const rightHandle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;
    const originalElementFromPoint = activeDocument.elementFromPoint;
    activeDocument.elementFromPoint = () => container;
    try {
      leftHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      rightHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2 }));

      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
      expect(cbs.onStartChange).not.toHaveBeenCalled();
      expect(cbs.onDueChange).not.toHaveBeenCalled();
      expect(bar.getAttribute('draggable')).toBe('false');

      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }));
      expect(cbs.onStartChange).not.toHaveBeenCalled();
      expect(cbs.onDueChange).toHaveBeenCalledWith(t, '2026-07-10');
      expect(bar.getAttribute('draggable')).toBe('true');
      expect(bar.hasClass('is-edge-resizing')).toBe(false);
    } finally {
      activeDocument.elementFromPoint = originalElementFromPoint;
    }
  });

  it('the all-day resize seam resolves only the terminal edge armed by pointerdown and clears on pointercancel', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-10' } });
    renderAllDayCell(container, '2026-07-10', [t], [], [], cbs);
    const endDrag = (container as unknown as { __tgTestEndDrag: (date: string) => void })
      .__tgTestEndDrag;
    const leftHandle = container.querySelector('.tc-tg-span-edge--left') as HTMLElement;
    const rightHandle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;

    endDrag('2026-07-07');
    expect(cbs.onStartChange).not.toHaveBeenCalled();
    expect(cbs.onDueChange).not.toHaveBeenCalled();

    leftHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    endDrag('2026-07-07');
    expect(cbs.onStartChange).toHaveBeenCalledWith(t, '2026-07-07');
    expect(cbs.onDueChange).not.toHaveBeenCalled();
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
    endDrag('2026-07-06');
    expect(cbs.onStartChange).toHaveBeenCalledTimes(1);

    rightHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2 }));
    endDrag('2026-07-11');
    expect(cbs.onDueChange).toHaveBeenCalledWith(t, '2026-07-11');
    expect(cbs.onStartChange).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 2 }));
  });

  describe('Task 39: live day-target highlight while dragging an edge-resize handle', () => {
    // Mirrors renderTimedBlocks.ts's identical Task 39 suite: jsdom has no real
    // elementFromPoint, so these feed the mechanism a stand-in day element directly rather
    // than asserting on real screen coordinates (per the brief's own guidance for this class
    // of mechanism).
    it('pointermove over a day cell adds is-drag-over to that cell', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-10' } });
      renderAllDayCell(container, '2026-07-10', [t], [], [], cbs);
      const rightHandle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;
      const dayEl = document.createElement('div');
      dayEl.setAttribute('data-tg-date', '2026-07-11');
      const original = activeDocument.elementFromPoint;
      activeDocument.elementFromPoint = () => dayEl;
      rightHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1 }));
      expect(dayEl.classList.contains('is-drag-over')).toBe(true);
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
      activeDocument.elementFromPoint = original;
    });

    it('releasing (pointerup) clears the highlight', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-10' } });
      renderAllDayCell(container, '2026-07-10', [t], [], [], cbs);
      const rightHandle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;
      const dayEl = document.createElement('div');
      dayEl.setAttribute('data-tg-date', '2026-07-11');
      const original = activeDocument.elementFromPoint;
      activeDocument.elementFromPoint = () => dayEl;
      rightHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1 }));
      expect(dayEl.classList.contains('is-drag-over')).toBe(true);
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
      expect(dayEl.classList.contains('is-drag-over')).toBe(false);
      activeDocument.elementFromPoint = original;
    });

    it('a pointercancel mid-gesture also clears the highlight (does not get stuck on)', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-10' } });
      renderAllDayCell(container, '2026-07-10', [t], [], [], cbs);
      const rightHandle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;
      const dayEl = document.createElement('div');
      dayEl.setAttribute('data-tg-date', '2026-07-11');
      const original = activeDocument.elementFromPoint;
      activeDocument.elementFromPoint = () => dayEl;
      rightHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1 }));
      expect(dayEl.classList.contains('is-drag-over')).toBe(true);
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
      expect(dayEl.classList.contains('is-drag-over')).toBe(false);
      activeDocument.elementFromPoint = original;
    });
  });

  it('a plain task gets a right-edge handle that fires onExtendToSpan (not onDueChange) on pointerup', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Plain', planning: { due: '2026-07-10' } });
    renderAllDayCell(container, '2026-07-10', [], [t], [], cbs);
    const handle = container.querySelector('.tc-tg-plain .tc-tg-span-edge--right') as HTMLElement;
    expect(handle).not.toBeNull();
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
    (container as unknown as { __tgTestEndDrag: (date: string) => void }).__tgTestEndDrag(
      '2026-07-12',
    );
    expect(cbs.onExtendToSpan).toHaveBeenCalledWith(t, '2026-07-12');
    expect(cbs.onDueChange).not.toHaveBeenCalled();
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
  });

  it('sets draggable="false" on edge handles so a drag started on one never races the ancestor\'s native cross-day dragstart', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const span = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-10' } });
    renderAllDayCell(container, '2026-07-10', [span], [], [], cbs);
    const spanHandle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;
    expect(spanHandle.getAttribute('draggable')).toBe('false');

    const plainContainer = freshContainer();
    const plainTask = task({ title: 'Plain', planning: { due: '2026-07-10' } });
    renderAllDayCell(plainContainer, '2026-07-10', [], [plainTask], [], cbs);
    const plainHandle = plainContainer.querySelector(
      '.tc-tg-plain .tc-tg-span-edge--right',
    ) as HTMLElement;
    expect(plainHandle.getAttribute('draggable')).toBe('false');
  });

  it('a span keeps exactly one right-edge handle, never a second one from the plain-task extend feature', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-10' } });
    renderAllDayCell(container, '2026-07-10', [t], [], [], cbs);
    const handles = container.querySelectorAll('.tc-tg-span .tc-tg-span-edge--right');
    expect(handles.length).toBe(1);
  });

  it('clicking the status marker on a plain task with an edge handle still toggles it (handle does not steal the click)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Plain', planning: { due: '2026-07-10' } });
    renderAllDayCell(container, '2026-07-10', [], [t], [], cbs);
    const chip = container.querySelector('.tc-tg-plain') as HTMLElement;
    const marker =
      chip.querySelector('.tc-status-marker, [data-task-status]') ?? chip.firstElementChild;
    (marker as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onToggle).toHaveBeenCalledWith(t);
  });

  it('a stationary right-click (pointerdown button=2, pointerup at same position, no move) on an edge handle does NOT fire onStartChange/onDueChange', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-10' } });
    renderAllDayCell(container, '2026-07-10', [t], [], [], cbs);
    const leftHandle = container.querySelector('.tc-tg-span-edge--left') as HTMLElement;
    // Simulate a real browser resolving an element under a stationary cursor (jsdom's
    // elementFromPoint always returns null, unlike a real browser where a right-click on
    // the edge handle would resolve to the day cell beneath it).
    const originalElementFromPoint = activeDocument.elementFromPoint;
    activeDocument.elementFromPoint = () => container;
    try {
      leftHandle.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          pointerId: 1,
          button: 2,
          clientX: 5,
          clientY: 5,
        }),
      );
      // No pointermove — a real stationary right-click never moves the pointer.
      window.dispatchEvent(
        new PointerEvent('pointerup', { pointerId: 1, button: 2, clientX: 5, clientY: 5 }),
      );
    } finally {
      activeDocument.elementFromPoint = originalElementFromPoint;
    }
    expect(cbs.onStartChange).not.toHaveBeenCalled();
    expect(cbs.onDueChange).not.toHaveBeenCalled();
  });

  it('renders count badges (no tag chips) in a .tc-tg-body-meta span on a plain chip', () => {
    const container = freshContainer();
    const t = task({
      title: 'Plain',
      tags: ['#work'],
      planning: { due: '2026-07-10' },
      source: { originalMarkdown: '- [ ] Plain #work', originalBlock: '- [ ] Plain #work' },
      presentation: { linkCount: 1 },
    });
    renderAllDayCell(container, '2026-07-10', [], [t], [], callbacks(), [
      { id: '1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#3498db' },
    ]);
    const chip = container.querySelector('.tc-tg-plain') as HTMLElement;
    const meta = chip.querySelector('.tc-tg-body-meta') as HTMLElement;
    expect(meta).not.toBeNull();
    expect(meta.querySelector('.tc-task-count-badge')).not.toBeNull();
    expect(meta.querySelector('.tc-task-tag')).toBeNull();
  });

  describe("Task 44: no tag chips on all-day/plain/span items (mirrors Task 35's timed-block removal)", () => {
    it('never renders a .tc-task-tag on a plain chip, even for a tagged task', () => {
      const container = freshContainer();
      const t = task({
        title: 'Plain',
        tags: ['#work'],
        planning: { due: '2026-07-10' },
        source: { originalMarkdown: '- [ ] Plain #work', originalBlock: '- [ ] Plain #work' },
      });
      renderAllDayCell(container, '2026-07-10', [], [t], [], callbacks(), [
        { id: '1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#3498db' },
      ]);
      const chip = container.querySelector('.tc-tg-plain') as HTMLElement;
      expect(chip.querySelector('.tc-task-tag')).toBeNull();
    });

    it('never renders a .tc-task-tag on a span body, even for a tagged task', () => {
      const container = freshContainer();
      const t = task({
        title: 'Trip',
        tags: ['#work'],
        planning: { start: '2026-07-08', due: '2026-07-12' },
        source: { originalMarkdown: '- [ ] Trip #work', originalBlock: '- [ ] Trip #work' },
      });
      renderAllDayCell(container, '2026-07-12', [t], [], [], callbacks(), [
        { id: '1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#3498db' },
      ]);
      const bar = container.querySelector('.tc-tg-span') as HTMLElement;
      expect(bar.querySelector('.tc-task-tag')).toBeNull();
    });

    it('a tagged plain chip with no subtasks/comments/links now omits .tc-tg-body-meta entirely (no chip left to show)', () => {
      const container = freshContainer();
      const t = task({
        title: 'Plain',
        tags: ['#work'],
        planning: { due: '2026-07-10' },
        source: { originalMarkdown: '- [ ] Plain #work', originalBlock: '- [ ] Plain #work' },
      });
      renderAllDayCell(container, '2026-07-10', [], [t], [], callbacks(), [
        { id: '1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#3498db' },
      ]);
      const chip = container.querySelector('.tc-tg-plain') as HTMLElement;
      expect(chip.querySelector('.tc-tg-body-meta')).toBeNull();
    });

    it("the all-day title's (.tc-tg-body-title) truncation CSS matches the timed-block title's (.tc-tg-block-title) exactly", () => {
      const bodyDecls = declarationsFor('.tc-tg-body-title');
      const blockDecls = declarationsFor('.tc-tg-block-title');
      for (const prop of ['overflow', 'text-overflow', 'white-space']) {
        const bodyValue = new RegExp(`${prop}\\s*:\\s*([^;]+);`, 'u').exec(bodyDecls)?.[1]?.trim();
        const blockValue = new RegExp(`${prop}\\s*:\\s*([^;]+);`, 'u')
          .exec(blockDecls)?.[1]
          ?.trim();
        expect(bodyValue).toBeTruthy();
        expect(bodyValue).toBe(blockValue);
      }
      // Also verify font-weight parity — Task 44 follow-up: an all-day title previously read
      // visibly lighter/thinner than a timed block's title directly below it in the same day
      // column, since only the block title set font-weight: 600.
      const bodyWeight = /font-weight\s*:\s*([^;]+);/u.exec(bodyDecls)?.[1]?.trim();
      const blockWeight = /font-weight\s*:\s*([^;]+);/u.exec(blockDecls)?.[1]?.trim();
      expect(bodyWeight).toBe(blockWeight);
    });
  });

  it('renders count badges (no tag chips) on a deadline marker, per the no-tag-fill convention', () => {
    const container = freshContainer();
    const t = task({
      title: 'Deadline',
      tags: ['#work'],
      comments: [taskComment({ text: 'c' })],
      planning: { scheduled: '2026-07-09', due: '2026-07-10' },
      source: { originalMarkdown: '- [ ] Deadline #work', originalBlock: '- [ ] Deadline #work' },
    });
    renderAllDayCell(container, '2026-07-10', [], [], [t], callbacks(), [
      { id: '1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#3498db' },
    ]);
    const marker = container.querySelector('.tc-tg-deadline-marker') as HTMLElement;
    const meta = marker.querySelector('.tc-tg-body-meta') as HTMLElement;
    expect(meta).not.toBeNull();
    expect(meta.querySelector('.tc-task-count-badge')).not.toBeNull();
    expect(meta.querySelector('.tc-task-tag')).toBeNull();
  });

  it('omits .tc-tg-body-meta entirely for a plain chip with no tags/subtasks/comments/links', () => {
    const container = freshContainer();
    const t = task({ title: 'Plain', planning: { due: '2026-07-10' } });
    renderAllDayCell(container, '2026-07-10', [], [t], [], callbacks());
    const chip = container.querySelector('.tc-tg-plain') as HTMLElement;
    expect(chip.querySelector('.tc-tg-body-meta')).toBeNull();
  });

  it("clicking empty all-day-cell space fires onCreateAtDate with this cell's date", () => {
    const container = freshContainer();
    const onCreateAtDate = vi.fn();
    renderAllDayCell(container, '2026-07-10', [], [], [], { ...callbacks(), onCreateAtDate });
    container.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onCreateAtDate).toHaveBeenCalledWith('2026-07-10');
  });

  it('clicking an existing plain chip does not also fire onCreateAtDate', () => {
    const container = freshContainer();
    const onCreateAtDate = vi.fn();
    const t = task({ title: 'Plain', planning: { due: '2026-07-10' } });
    renderAllDayCell(container, '2026-07-10', [], [t], [], { ...callbacks(), onCreateAtDate });
    (container.querySelector('.tc-tg-plain') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(onCreateAtDate).not.toHaveBeenCalled();
  });

  it('clicking an existing span continuation does not also fire onCreateAtDate', () => {
    const container = freshContainer();
    const onCreateAtDate = vi.fn();
    const t = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-12' } });
    renderAllDayCell(container, '2026-07-10', [t], [], [], { ...callbacks(), onCreateAtDate });
    (container.querySelector('.tc-tg-span-continuation') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(onCreateAtDate).not.toHaveBeenCalled();
  });

  it('clicking an existing deadline marker does not also fire onCreateAtDate', () => {
    const container = freshContainer();
    const onCreateAtDate = vi.fn();
    const t = task({ title: 'Deadline', planning: { due: '2026-07-10', scheduled: '2026-07-05' } });
    renderAllDayCell(container, '2026-07-10', [], [], [t], { ...callbacks(), onCreateAtDate });
    (container.querySelector('.tc-tg-deadline-marker') as HTMLElement).dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(onCreateAtDate).not.toHaveBeenCalled();
  });

  it('does not wire a click listener when onCreateAtDate is not provided (no throw on click)', () => {
    const container = freshContainer();
    renderAllDayCell(container, '2026-07-10', [], [], [], callbacks());
    expect(() => container.dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow();
  });

  describe("Task 37: edge-resize no longer races/borrows the ancestor's native cross-day drag", () => {
    it("'.tc-tg-body.is-edge-resizing' stays fully opaque (no opacity override) and uses a dashed outline in the tag-color convention, distinct from '.is-dragging''s opacity:0.5", () => {
      const resizingDecls = declarationsFor('.tc-tg-body.is-edge-resizing');
      expect(resizingDecls).not.toBe('');
      // Opaque: unlike .is-dragging, this must never dim the item — the whole point is that it
      // reads as a deliberate, still-fully-legible "in progress" state, not the native drag's
      // washed-out accidental side effect this fixes.
      expect(resizingDecls).not.toMatch(/opacity\s*:/u);
      // Reuses the same --tc-tag-color (falling back to the neutral accent) the solid tag-fill
      // background already uses, so the "ghost" reads as belonging to this specific item.
      expect(resizingDecls).toMatch(
        /outline\s*:.*var\(--tc-tag-color,\s*var\(--interactive-accent\)\)/u,
      );
      expect(resizingDecls).toMatch(/dashed/u);

      const draggingDecls = declarationsFor('.tc-tg-body.is-dragging');
      expect(draggingDecls).toMatch(/opacity\s*:\s*0\.5/u);
    });

    it('pointerdown on a span edge handle flips the ancestor .tc-tg-body draggable to false and adds is-edge-resizing (blocking the native-drag-ancestor-fallback that used to arm mid-resize)', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-10' } });
      renderAllDayCell(container, '2026-07-10', [t], [], [], cbs);
      const bar = container.querySelector('.tc-tg-span') as HTMLElement;
      const rightHandle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;

      expect(bar.getAttribute('draggable')).toBe('true');
      rightHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      expect(bar.getAttribute('draggable')).toBe('false');
      expect(bar.hasClass('is-edge-resizing')).toBe(true);

      // jsdom has no elementFromPoint implementation at all; stub it (mirrors the existing
      // stationary-right-click test above) so the real pointerup path can run to completion.
      const originalElementFromPoint = activeDocument.elementFromPoint;
      activeDocument.elementFromPoint = () => null;
      try {
        window.dispatchEvent(
          new PointerEvent('pointerup', { pointerId: 1, clientX: 0, clientY: 0 }),
        );
      } finally {
        activeDocument.elementFromPoint = originalElementFromPoint;
      }
      expect(bar.getAttribute('draggable')).toBe('true');
      expect(bar.hasClass('is-edge-resizing')).toBe(false);
    });

    it('a pointercancel (native drag hijacking the session) restores draggable/removes is-edge-resizing and does not fire the resolve callback, without leaking listeners for the next gesture', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({ title: 'Plain', planning: { due: '2026-07-10' } });
      renderAllDayCell(container, '2026-07-10', [], [t], [], cbs);
      const chip = container.querySelector('.tc-tg-plain') as HTMLElement;
      const handle = container.querySelector('.tc-tg-plain .tc-tg-span-edge--right') as HTMLElement;

      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      expect(chip.getAttribute('draggable')).toBe('false');
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
      expect(chip.getAttribute('draggable')).toBe('true');
      expect(chip.hasClass('is-edge-resizing')).toBe(false);
      expect(cbs.onExtendToSpan).not.toHaveBeenCalled();

      // A fresh, unrelated gesture right after must behave normally — proving the cancelled
      // gesture's window listeners were torn down, not leaked (which would otherwise double-fire).
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2 }));
      (container as unknown as { __tgTestEndDrag: (date: string) => void }).__tgTestEndDrag(
        '2026-07-12',
      );
      expect(cbs.onExtendToSpan).toHaveBeenCalledTimes(1);
      expect(cbs.onExtendToSpan).toHaveBeenCalledWith(t, '2026-07-12');
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 2 }));
    });

    it("resizing one item does not mutate any sibling element's layout-affecting attributes/inline styles (purely a class/attribute toggle on the dragged item itself)", () => {
      const container = freshContainer();
      const cbs = callbacks();
      const span = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-10' } });
      const plain = task({ title: 'Plain', planning: { due: '2026-07-10' } });
      renderAllDayCell(container, '2026-07-10', [span], [plain], [], cbs);

      const bar = container.querySelector('.tc-tg-span') as HTMLElement;
      const chip = container.querySelector('.tc-tg-plain') as HTMLElement;
      const handle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;

      const snapshot = (el: HTMLElement) => ({
        style: el.getAttribute('style'),
        class: el.className,
        draggable: el.getAttribute('draggable'),
      });
      const before = { container: snapshot(container), chip: snapshot(chip) };

      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      // The dragged bar itself changed (expected); its sibling chip and the shared cell container
      // must not have — no layout recalculation should touch anything but the dragged element.
      expect(snapshot(chip)).toEqual(before.chip);
      expect(snapshot(container)).toEqual(before.container);
      expect(bar.getAttribute('draggable')).toBe('false');

      const originalElementFromPoint = activeDocument.elementFromPoint;
      activeDocument.elementFromPoint = () => null;
      try {
        window.dispatchEvent(
          new PointerEvent('pointerup', { pointerId: 1, clientX: 0, clientY: 0 }),
        );
      } finally {
        activeDocument.elementFromPoint = originalElementFromPoint;
      }
      expect(snapshot(chip)).toEqual(before.chip);
      expect(snapshot(container)).toEqual(before.container);
    });
  });

  describe('pointer capture: closes the same "abandoned gesture" gap renderTimedBlocks.ts fixes (draggable="false"/is-edge-resizing stuck forever if pointerup/pointercancel never fires)', () => {
    // Mirrors renderTimedBlocks.ts's own pointer-capture suite: jsdom can't reproduce the actual
    // guarantee (a real browser will always eventually deliver pointerup/pointercancel to a
    // captured pointer, even if it's released outside the window) — these assert the mechanism
    // that provides it, so a future refactor that drops the capture call regresses visibly.
    it("pointerdown on an edge-resize handle arms pointer capture on that handle with the gesture's pointerId", () => {
      const container = freshContainer();
      const t = task({ title: 'Trip', planning: { start: '2026-07-08', due: '2026-07-10' } });
      renderAllDayCell(container, '2026-07-10', [t], [], [], callbacks());
      const handle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;
      handle.setPointerCapture = vi.fn();
      handle.releasePointerCapture = vi.fn();
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 4 }));
      expect(handle.setPointerCapture).toHaveBeenCalledWith(4);
    });

    it('releasePointerCapture is called on pointercancel cleanup with the same pointerId that was captured', () => {
      const container = freshContainer();
      const t = task({ title: 'Plain', planning: { due: '2026-07-10' } });
      renderAllDayCell(container, '2026-07-10', [], [t], [], callbacks());
      const handle = container.querySelector('.tc-tg-plain .tc-tg-span-edge--right') as HTMLElement;
      handle.setPointerCapture = vi.fn();
      handle.releasePointerCapture = vi.fn();
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 8 }));
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 8 }));
      expect(handle.releasePointerCapture).toHaveBeenCalledWith(8);
    });

    it('a host lacking setPointerCapture/releasePointerCapture entirely (e.g. jsdom) is tolerated: no throw, and the pre-existing pointercancel cleanup still runs', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({ title: 'Plain', planning: { due: '2026-07-10' } });
      renderAllDayCell(container, '2026-07-10', [], [t], [], cbs);
      const chip = container.querySelector('.tc-tg-plain') as HTMLElement;
      const handle = container.querySelector('.tc-tg-plain .tc-tg-span-edge--right') as HTMLElement;
      // Deliberately NOT stubbing setPointerCapture/releasePointerCapture — jsdom's HTMLElement
      // has neither method at all, reproducing any real host lacking Pointer Events capture
      // support.
      expect(() =>
        handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 })),
      ).not.toThrow();
      expect(chip.getAttribute('draggable')).toBe('false');
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
      expect(chip.getAttribute('draggable')).toBe('true');
      expect(cbs.onExtendToSpan).not.toHaveBeenCalled();
    });
  });

  describe('Task 38 follow-up: is-done/is-cancelled strikethrough parity with timed blocks', () => {
    it('marks a done plain item title is-done', () => {
      const container = freshContainer();
      const t = task({ status: 'done', statusSymbol: 'x', planning: { due: '2026-07-10' } });
      renderAllDayCell(container, '2026-07-10', [], [t], [], callbacks());
      const title = container.querySelector('.tc-tg-body-title') as HTMLElement;
      expect(title.classList.contains('is-done')).toBe(true);
    });

    it('marks a cancelled span item title is-cancelled', () => {
      const container = freshContainer();
      const t = task({
        status: 'cancelled',
        statusSymbol: '-',
        planning: { start: '2026-07-08', due: '2026-07-12' },
      });
      renderAllDayCell(container, '2026-07-10', [t], [], [], callbacks());
      const title = container.querySelector('.tc-tg-body-title') as HTMLElement;
      expect(title.classList.contains('is-cancelled')).toBe(true);
    });

    it('an open plain/span item gets neither is-done nor is-cancelled on its title', () => {
      const container = freshContainer();
      const t = task({ planning: { due: '2026-07-10' } });
      renderAllDayCell(container, '2026-07-10', [], [t], [], callbacks());
      const title = container.querySelector('.tc-tg-body-title') as HTMLElement;
      expect(title.classList.contains('is-done')).toBe(false);
      expect(title.classList.contains('is-cancelled')).toBe(false);
    });

    it('marks a done deadline marker title is-done', () => {
      const container = freshContainer();
      const t = task({
        status: 'done',
        statusSymbol: 'x',
        planning: { due: '2026-07-10', scheduled: '2026-07-05' },
      });
      renderAllDayCell(container, '2026-07-10', [], [], [t], callbacks());
      const title = container.querySelector('.tc-tg-deadline-title') as HTMLElement;
      expect(title).not.toBeNull();
      expect(title.classList.contains('is-done')).toBe(true);
    });

    it('marks a cancelled deadline marker title is-cancelled', () => {
      const container = freshContainer();
      const t = task({
        status: 'cancelled',
        statusSymbol: '-',
        planning: { due: '2026-07-10', scheduled: '2026-07-05' },
      });
      renderAllDayCell(container, '2026-07-10', [], [], [t], callbacks());
      const title = container.querySelector('.tc-tg-deadline-title') as HTMLElement;
      expect(title.classList.contains('is-cancelled')).toBe(true);
    });

    it('.tc-tg-body-title.is-done and .tc-tg-deadline-title.is-done get the same strikethrough convention as .tc-tg-block-title.is-done', () => {
      const bodyRule = /\.tc-tg-body-title\.is-done[^{]*\{[^}]*\}/u.exec(css)?.[0] ?? '';
      const deadlineRule = /\.tc-tg-deadline-title\.is-done[^{]*\{[^}]*\}/u.exec(css)?.[0] ?? '';
      expect(bodyRule).toMatch(/text-decoration\s*:\s*line-through/u);
      expect(deadlineRule).toMatch(/text-decoration\s*:\s*line-through/u);
    });
  });

  describe('Task 40 follow-up: count badges inside a tag-filled context participate in contrast switching', () => {
    it('scopes .tc-task-count-badge color override to .tc-tg-block-badges, leaving the bare rule at var(--text-muted) for the main task list', () => {
      // Anchored to the start of the line (not just anywhere the selector text appears) so this
      // matches only the bare, unqualified `.tc-task-count-badge { ... }` rule (TaskCard.ts's
      // main-list badges) — not the `.tc-tg-block-badges .tc-task-count-badge { ... }` descendant
      // rule below, whose own selector text also contains this substring.
      const bareMatch = new RegExp(
        String.raw`^\.tc-task-count-badge\s*\{(?<body>[^}]*)\}`,
        'mu',
      ).exec(css);
      const bareRule = bareMatch?.groups?.['body'] ?? '';
      expect(bareRule).toMatch(/color:\s*var\(--text-muted\)/u);
      expect(bareRule).not.toMatch(/--tc-tag-text-color/u);

      const scopedRule = declarationsFor('.tc-tg-block-badges .tc-task-count-badge');
      expect(scopedRule).toMatch(/--tc-tag-text-color/u);
      expect(scopedRule).toMatch(/var\(--text-muted\)/u);
    });
  });
});
