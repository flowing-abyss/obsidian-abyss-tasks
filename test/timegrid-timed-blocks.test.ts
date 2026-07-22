import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Component, type App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import {
  renderTimedBlocksForDay,
  renderTimedSpanContinuation,
  toTimedBlockInputs,
} from '../src/views/timegrid/renderTimedBlocks';
import {
  dispatchDnD,
  freshContainer,
  task,
  taskComment,
  taskFromCodecLine,
  useRealMoment,
} from './helpers';

useRealMoment();

const css = readFileSync(resolve(import.meta.dirname, '..', 'styles.css'), 'utf8');

function declarationsFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace(/\\,/gu, ',');
  const match = new RegExp(`${escaped}\\s*\\{(?<body>[^}]*)\\}`, 'u').exec(css);
  return match?.groups?.['body'] ?? '';
}

const registry = new StatusRegistry(buildDefaultTaskStatuses());
const fakeApp = {} as App;

function callbacks() {
  return {
    app: fakeApp,
    component: new Component(),
    onTaskClick: vi.fn(),
    onKeyboardIntent: vi.fn(),
    onTimeChange: vi.fn(),
    onDurationChange: vi.fn(),
    onExtendToSpan: vi.fn(),
    onStartChange: vi.fn(),
    onToggle: vi.fn(),
    onSetStatus: vi.fn(),
    onSetPriority: vi.fn(),
    statusRegistry: registry,
  };
}

describe('renderTimedBlocksForDay', () => {
  it('does not set data-priority on the block (calendar blocks no longer render a priority border)', () => {
    const container = freshContainer();
    const t = task({ priority: 'A', planning: { time: '09:00' } });
    renderTimedBlocksForDay(container, [t], {
      app: fakeApp,
      component: new Component(),
      onTaskClick: vi.fn(),
      onKeyboardIntent: vi.fn(),
      onTimeChange: vi.fn(),
      onDurationChange: vi.fn(),
      onExtendToSpan: vi.fn(),
      onStartChange: vi.fn(),
      onToggle: vi.fn(),
      onSetStatus: vi.fn(),
      onSetPriority: vi.fn(),
      statusRegistry: registry,
    });
    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    expect(block.hasAttribute('data-priority')).toBe(false);
  });

  it('wraps the status marker and title together in a .tc-tg-block-head row, marker first', () => {
    const container = freshContainer();
    const t = task({ planning: { time: '09:00' } });
    renderTimedBlocksForDay(container, [t], callbacks());
    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    const head = block.querySelector('.tc-tg-block-head') as HTMLElement;
    expect(head).not.toBeNull();
    const marker = head.querySelector('.tc-status-marker');
    const title = head.querySelector('.tc-tg-block-title');
    expect(marker).not.toBeNull();
    expect(title).not.toBeNull();
    expect(head.firstElementChild).toBe(marker);
    expect(marker?.nextElementSibling).toBe(title);
  });

  it('Task 38: a done task still renders as a full timed block, checkbox showing checked, not removed', () => {
    const container = freshContainer();
    const t = task({ status: 'done', statusSymbol: 'x', planning: { time: '09:00' } });
    renderTimedBlocksForDay(container, [t], callbacks());
    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    expect(block).not.toBeNull();
    const marker = block.querySelector('.tc-status-marker') as HTMLElement;
    expect(marker.getAttribute('data-status-type')).toBe('done');
    const title = block.querySelector('.tc-tg-block-title') as HTMLElement;
    expect(title.classList.contains('is-done')).toBe(true);
  });

  it('Task 38: a cancelled task still renders as a full timed block, not removed, title marked is-cancelled', () => {
    const container = freshContainer();
    const t = task({ status: 'cancelled', statusSymbol: '-', planning: { time: '09:00' } });
    renderTimedBlocksForDay(container, [t], callbacks());
    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    expect(block).not.toBeNull();
    const title = block.querySelector('.tc-tg-block-title') as HTMLElement;
    expect(title.classList.contains('is-cancelled')).toBe(true);
  });

  it('Task 38: an open task gets neither is-done nor is-cancelled on its title', () => {
    const container = freshContainer();
    const t = task({ planning: { time: '09:00' } });
    renderTimedBlocksForDay(container, [t], callbacks());
    const title = container.querySelector('.tc-tg-block-title') as HTMLElement;
    expect(title.classList.contains('is-done')).toBe(false);
    expect(title.classList.contains('is-cancelled')).toBe(false);
  });

  it('Task 38: .tc-tg-block-title.is-done gets the same strikethrough convention as .tc-list-task-title.is-done', () => {
    const rule = /\.tc-tg-block-title\.is-done[^{]*\{[^}]*\}/u.exec(css)?.[0] ?? '';
    expect(rule).toMatch(/text-decoration\s*:\s*line-through/u);
  });

  it('clicking the status marker fires onToggle with the task, not onTaskClick', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ planning: { time: '09:00' } });
    renderTimedBlocksForDay(container, [t], cbs);
    const marker = container.querySelector('.tc-status-marker') as HTMLElement;
    marker.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onToggle).toHaveBeenCalledWith(t);
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('right-clicking the status marker opens the status/priority popover and does NOT fire onTaskClick (checkbox contextmenu is distinct from the block contextmenu)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ planning: { time: '09:00' } });
    renderTimedBlocksForDay(container, [t], cbs);
    const marker = container.querySelector('.tc-status-marker') as HTMLElement;
    marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(document.querySelector('.tc-status-popover')).not.toBeNull();
    expect(cbs.onTaskClick).not.toHaveBeenCalled();
  });

  it('picking a status from the popover fires onSetStatus with the task and chosen symbol', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ planning: { time: '09:00' } });
    renderTimedBlocksForDay(container, [t], cbs);
    const marker = container.querySelector('.tc-status-marker') as HTMLElement;
    marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const statusRow = document.querySelector('.tc-status-popover-row') as HTMLElement;
    expect(statusRow).not.toBeNull();
    statusRow.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onSetStatus).toHaveBeenCalledWith(t, expect.any(String));
  });

  it('picking a priority flag from the popover fires onSetPriority with the task and chosen priority', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ planning: { time: '09:00' } });
    renderTimedBlocksForDay(container, [t], cbs);
    const marker = container.querySelector('.tc-status-marker') as HTMLElement;
    marker.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const flagBtn = document.querySelector(
      '.tc-status-popover-flag[data-tc-priority="A"]',
    ) as HTMLElement;
    expect(flagBtn).not.toBeNull();
    flagBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onSetPriority).toHaveBeenCalledWith(t, 'A');
  });

  it('a real pointerdown→pointerup→click sequence on the status marker (no movement) fires only onToggle, never onTimeChange/onDurationChange', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({ planning: { time: '09:00', duration: 60 } });
    renderTimedBlocksForDay(container, [t], cbs);
    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    block.setPointerCapture = () => {};
    block.releasePointerCapture = () => {};
    const marker = container.querySelector('.tc-status-marker') as HTMLElement;
    // Real browser event order for a click on a child element: pointerdown bubbles first,
    // then pointerup, then click — reproduced here exactly, targeting the marker.
    marker.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
    );
    window.dispatchEvent(new PointerEvent('pointerup', { clientY: 100, pointerId: 1 }));
    marker.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onToggle).toHaveBeenCalledWith(t);
    expect(cbs.onTimeChange).not.toHaveBeenCalled();
    expect(cbs.onDurationChange).not.toHaveBeenCalled();
  });

  it('omits data-priority entirely when the task has no priority (D)', () => {
    const container = freshContainer();
    const t = task({ priority: 'D', planning: { time: '09:00' } });
    renderTimedBlocksForDay(container, [t], {
      app: fakeApp,
      component: new Component(),
      onTaskClick: vi.fn(),
      onKeyboardIntent: vi.fn(),
      onTimeChange: vi.fn(),
      onDurationChange: vi.fn(),
      onExtendToSpan: vi.fn(),
      onStartChange: vi.fn(),
      onToggle: vi.fn(),
      onSetStatus: vi.fn(),
      onSetPriority: vi.fn(),
      statusRegistry: registry,
    });
    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    expect(block.hasAttribute('data-priority')).toBe(false);
  });

  it('sets --tc-tag-color when the task has a tag matching a configured tag group', () => {
    const container = freshContainer();
    const t = task({
      tags: ['#work'],
      planning: { time: '09:00' },
      source: { originalMarkdown: '- [ ] t #work', originalBlock: '- [ ] t #work' },
    });
    renderTimedBlocksForDay(
      container,
      [t],
      {
        app: fakeApp,
        component: new Component(),
        onTaskClick: vi.fn(),
        onKeyboardIntent: vi.fn(),
        onTimeChange: vi.fn(),
        onDurationChange: vi.fn(),
        onExtendToSpan: vi.fn(),
        onStartChange: vi.fn(),
        onToggle: vi.fn(),
        onSetStatus: vi.fn(),
        onSetPriority: vi.fn(),
        statusRegistry: registry,
      },
      [{ id: '1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#3498db' }],
    );
    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    expect(block.style.getPropertyValue('--tc-tag-color')).toBe('#3498db');
  });

  it('shows the start–end time range with duration in parentheses in the block subtitle', () => {
    const container = freshContainer();
    const t = task({ planning: { time: '15:00', duration: 90 } });
    renderTimedBlocksForDay(container, [t], callbacks());
    const subtitle = container.querySelector('.tc-tg-block-subtitle') as HTMLElement;
    expect(subtitle).not.toBeNull();
    expect(subtitle.textContent).toBe('15:00–16:30 (1h30m)');
  });

  it('defaults duration to 60min when unset, shown as "(1h)" in the subtitle', () => {
    const container = freshContainer();
    const t = task({ planning: { time: '09:00' } });
    renderTimedBlocksForDay(container, [t], callbacks());
    const subtitle = container.querySelector('.tc-tg-block-subtitle') as HTMLElement;
    expect(subtitle.textContent).toBe('09:00–10:00 (1h)');
  });

  it('renders the subtitle (inside its top row) before the head row (time+duration at the top of the block)', () => {
    const container = freshContainer();
    const t = task({ planning: { time: '09:00' } });
    renderTimedBlocksForDay(container, [t], callbacks());
    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    const subtitle = block.querySelector('.tc-tg-block-subtitle') as HTMLElement;
    const head = block.querySelector('.tc-tg-block-head') as HTMLElement;
    expect(subtitle).not.toBeNull();
    expect(head).not.toBeNull();
    // Task 35: the subtitle now lives inside `.tc-tg-block-toprow` (paired with the count
    // badges) rather than as a bare direct child of `.tc-tg-block`, so DOM order is asserted
    // via compareDocumentPosition instead of indexOf-ing `block.children` directly.
    expect(subtitle.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('renders one block per timed task, positioned by time and sized by duration', () => {
    const container = freshContainer();
    const t = task({ title: 'Gym', planning: { time: '15:00', duration: 120 } });
    renderTimedBlocksForDay(container, [t], {
      app: fakeApp,
      component: new Component(),
      onTaskClick: vi.fn(),
      onKeyboardIntent: vi.fn(),
      onTimeChange: vi.fn(),
      onDurationChange: vi.fn(),
      onExtendToSpan: vi.fn(),
      onStartChange: vi.fn(),
      onToggle: vi.fn(),
      onSetStatus: vi.fn(),
      onSetPriority: vi.fn(),
      statusRegistry: registry,
    });
    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    expect(block).not.toBeNull();
    expect(block.style.top).toBe(`${((15 * 60) / 60) * 48}px`);
    expect(block.style.height).toBe(`${(120 / 60) * 48}px`);
    expect(block.textContent).toContain('Gym');
  });

  it('defaults duration to 60 minutes when unset', () => {
    const container = freshContainer();
    const t = task({ planning: { time: '09:00' } });
    renderTimedBlocksForDay(container, [t], {
      app: fakeApp,
      component: new Component(),
      onTaskClick: vi.fn(),
      onKeyboardIntent: vi.fn(),
      onTimeChange: vi.fn(),
      onDurationChange: vi.fn(),
      onExtendToSpan: vi.fn(),
      onStartChange: vi.fn(),
      onToggle: vi.fn(),
      onSetStatus: vi.fn(),
      onSetPriority: vi.fn(),
      statusRegistry: registry,
    });
    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    expect(block.style.height).toBe('48px');
  });

  it('a plain click does NOT fire onTaskClick (reserved for drag)', () => {
    const container = freshContainer();
    const onTaskClick = vi.fn();
    const t = task({ planning: { time: '09:00' } });
    renderTimedBlocksForDay(container, [t], {
      app: fakeApp,
      component: new Component(),
      onTaskClick,
      onKeyboardIntent: vi.fn(),
      onTimeChange: vi.fn(),
      onDurationChange: vi.fn(),
      onExtendToSpan: vi.fn(),
      onStartChange: vi.fn(),
      onToggle: vi.fn(),
      onSetStatus: vi.fn(),
      onSetPriority: vi.fn(),
      statusRegistry: registry,
    });
    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    block.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onTaskClick).not.toHaveBeenCalled();
  });

  it('a right-click (contextmenu) fires onTaskClick', () => {
    const container = freshContainer();
    const onTaskClick = vi.fn();
    const t = task({ planning: { time: '09:00' } });
    renderTimedBlocksForDay(container, [t], {
      app: fakeApp,
      component: new Component(),
      onTaskClick,
      onKeyboardIntent: vi.fn(),
      onTimeChange: vi.fn(),
      onDurationChange: vi.fn(),
      onExtendToSpan: vi.fn(),
      onStartChange: vi.fn(),
      onToggle: vi.fn(),
      onSetStatus: vi.fn(),
      onSetPriority: vi.fn(),
      statusRegistry: registry,
    });
    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    block.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(onTaskClick).toHaveBeenCalledWith(t);
  });

  it('right-clicking the resize handle does NOT fire onTaskClick', () => {
    const container = freshContainer();
    const onTaskClick = vi.fn();
    const t = task({ planning: { time: '09:00' } });
    renderTimedBlocksForDay(container, [t], {
      app: fakeApp,
      component: new Component(),
      onTaskClick,
      onKeyboardIntent: vi.fn(),
      onTimeChange: vi.fn(),
      onDurationChange: vi.fn(),
      onExtendToSpan: vi.fn(),
      onStartChange: vi.fn(),
      onToggle: vi.fn(),
      onSetStatus: vi.fn(),
      onSetPriority: vi.fn(),
      statusRegistry: registry,
    });
    const handle = container.querySelector('.tc-tg-resize-handle') as HTMLElement;
    handle.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(onTaskClick).not.toHaveBeenCalled();
  });

  it('two overlapping blocks are given proportional widths/left offsets (no visual overlap)', () => {
    const container = freshContainer();
    const a = task({ planning: { time: '09:00', duration: 60 }, source: { line: 0 } });
    const b = task({ planning: { time: '09:30', duration: 60 }, source: { line: 1 } });
    renderTimedBlocksForDay(container, [a, b], {
      app: fakeApp,
      component: new Component(),
      onTaskClick: vi.fn(),
      onKeyboardIntent: vi.fn(),
      onTimeChange: vi.fn(),
      onDurationChange: vi.fn(),
      onExtendToSpan: vi.fn(),
      onStartChange: vi.fn(),
      onToggle: vi.fn(),
      onSetStatus: vi.fn(),
      onSetPriority: vi.fn(),
      statusRegistry: registry,
    });
    const blocks = Array.from(container.querySelectorAll<HTMLElement>('.tc-tg-block'));
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.style.width).toBe('50%');
    expect(blocks[1]!.style.width).toBe('50%');
    expect(blocks[0]!.style.left).not.toBe(blocks[1]!.style.left);
  });

  it('dragging the block body by one hour snaps to 15-minute steps and fires onTimeChange on pointerup', () => {
    const container = freshContainer();
    const onTimeChange = vi.fn();
    const t = task({ planning: { time: '09:00', duration: 60 } });
    renderTimedBlocksForDay(container, [t], {
      app: fakeApp,
      component: new Component(),
      onTaskClick: vi.fn(),
      onKeyboardIntent: vi.fn(),
      onTimeChange,
      onDurationChange: vi.fn(),
      onExtendToSpan: vi.fn(),
      onStartChange: vi.fn(),
      onToggle: vi.fn(),
      onSetStatus: vi.fn(),
      onSetPriority: vi.fn(),
      statusRegistry: registry,
    });
    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    block.setPointerCapture = () => {}; // jsdom stub
    block.releasePointerCapture = () => {};
    block.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
    );
    window.dispatchEvent(new PointerEvent('pointermove', { clientY: 148, pointerId: 1 })); // +48px = +60min
    window.dispatchEvent(new PointerEvent('pointerup', { clientY: 148, pointerId: 1 }));
    expect(onTimeChange).toHaveBeenCalledWith(t, 9 * 60 + 60);
  });

  it('dragging the resize handle fires onDurationChange, not onTimeChange', () => {
    const container = freshContainer();
    const onDurationChange = vi.fn();
    const onTimeChange = vi.fn();
    const t = task({ planning: { time: '09:00', duration: 60 } });
    renderTimedBlocksForDay(container, [t], {
      app: fakeApp,
      component: new Component(),
      onTaskClick: vi.fn(),
      onKeyboardIntent: vi.fn(),
      onTimeChange,
      onDurationChange,
      onExtendToSpan: vi.fn(),
      onStartChange: vi.fn(),
      onToggle: vi.fn(),
      onSetStatus: vi.fn(),
      onSetPriority: vi.fn(),
      statusRegistry: registry,
    });
    const handle = container.querySelector('.tc-tg-resize-handle') as HTMLElement;
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};
    handle.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
    );
    window.dispatchEvent(new PointerEvent('pointermove', { clientY: 148, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientY: 148, pointerId: 1 }));
    expect(onDurationChange).toHaveBeenCalledWith(t, 120);
    expect(onTimeChange).not.toHaveBeenCalled();
  });

  it('a stationary right-click (pointerdown button=2, pointerup at same position, no move) does NOT fire onTimeChange', () => {
    const container = freshContainer();
    const onTimeChange = vi.fn();
    const t = task({ planning: { time: '09:00', duration: 60 } });
    renderTimedBlocksForDay(container, [t], {
      app: fakeApp,
      component: new Component(),
      onTaskClick: vi.fn(),
      onKeyboardIntent: vi.fn(),
      onTimeChange,
      onDurationChange: vi.fn(),
      onExtendToSpan: vi.fn(),
      onStartChange: vi.fn(),
      onToggle: vi.fn(),
      onSetStatus: vi.fn(),
      onSetPriority: vi.fn(),
      statusRegistry: registry,
    });
    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    block.setPointerCapture = () => {};
    block.releasePointerCapture = () => {};
    block.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1, button: 2 }),
    );
    // No pointermove — a real stationary right-click never moves the pointer.
    window.dispatchEvent(new PointerEvent('pointerup', { clientY: 100, pointerId: 1, button: 2 }));
    expect(onTimeChange).not.toHaveBeenCalled();
  });

  it('renders the title via renderTaskText (markdown-link-aware), not raw textContent, for a task with a [[wikilink]]', () => {
    const container = freshContainer();
    const t = task({
      title: 'see [[Note]]',
      markdownTitle: 'see [[Note]]',
      planning: { time: '09:00' },
    });
    renderTimedBlocksForDay(container, [t], callbacks());
    const title = container.querySelector('.tc-tg-block-title') as HTMLElement;
    // renderTaskText only wraps in a `.tc-md` holder (and defers to MarkdownRenderer) when it
    // detects link syntax — a plain `.textContent =` assignment would show the raw brackets
    // instead of taking this path. MarkdownRenderer itself is a noop in this test harness (see
    // test/center-panel-integration.test.ts and friends), so real <a> production is not
    // observable here; the `.tc-md` holder is the reliable signal that markdown rendering (not
    // raw text) is in effect, matching this codebase's existing MarkdownRenderer-mock convention.
    expect(title.querySelector('.tc-md')).not.toBeNull();
  });

  it('renders plain title text (no [[links]]) via the renderTaskText fast path, unchanged from before', () => {
    const container = freshContainer();
    const t = task({ title: 'Gym', markdownTitle: 'Gym', planning: { time: '09:00' } });
    renderTimedBlocksForDay(container, [t], callbacks());
    const title = container.querySelector('.tc-tg-block-title') as HTMLElement;
    expect(title.querySelector('.tc-md')).toBeNull();
    expect(title.textContent).toBe('Gym');
  });

  it('a real pointerdown→pointerup→click sequence on a rendered link inside the title fires only the link click, never onTimeChange (regression: link click must not arm drag, mirroring the status-marker fix)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({
      title: 'see [[Note]]',
      markdownTitle: 'see [[Note]]',
      planning: { time: '09:00', duration: 60 },
    });
    renderTimedBlocksForDay(container, [t], cbs);
    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    block.setPointerCapture = () => {};
    block.releasePointerCapture = () => {};
    // renderTaskText's MarkdownRenderer.render is a noop in this test harness, so simulate the
    // real post-render DOM it would eventually produce: an <a> inside the title holder.
    const holder = block.querySelector('.tc-md') as HTMLElement;
    const link = holder.createEl('a', { cls: 'internal-link', text: 'Note' });
    // Real browser event order for a click on a nested link: pointerdown bubbles first, then
    // pointerup, then click — reproduced here exactly, targeting the link.
    link.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
    );
    window.dispatchEvent(new PointerEvent('pointerup', { clientY: 100, pointerId: 1 }));
    link.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(cbs.onTimeChange).not.toHaveBeenCalled();
    expect(cbs.onDurationChange).not.toHaveBeenCalled();
  });

  it('dragging that starts on the title text itself (not a link) still arms move and fires onTimeChange (guard is link-specific, not title-wide)', () => {
    const container = freshContainer();
    const cbs = callbacks();
    const t = task({
      title: 'Gym',
      markdownTitle: 'Gym',
      planning: { time: '09:00', duration: 60 },
    });
    renderTimedBlocksForDay(container, [t], cbs);
    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    block.setPointerCapture = () => {};
    block.releasePointerCapture = () => {};
    const title = container.querySelector('.tc-tg-block-title') as HTMLElement;
    title.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
    );
    window.dispatchEvent(new PointerEvent('pointermove', { clientY: 148, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent('pointerup', { clientY: 148, pointerId: 1 }));
    expect(cbs.onTimeChange).toHaveBeenCalledWith(t, 9 * 60 + 60);
  });

  describe('Task 33: clamping drag-computed move/resize values to a single real calendar day', () => {
    // Root cause of the disappearing-task bug: onTimeChange/onDurationChange never touch the
    // task's date, only its time-of-day/duration — so an unbounded upward drag could previously
    // compute a start time whose hour needs 3+ digits (e.g. "2093:15"), which the ⏰ token's own
    // \d{1,2} grammar can't round-trip on the next parse. `time` then comes back `undefined` and
    // the task silently drops out of every time-based view. These regression tests drive the
    // exact scenario that reproduced it live (a huge downward pointer delta) and confirm the
    // callback is now clamped to a value that always stays inside 00:00–23:59.

    it('an extreme downward drag on the block body clamps onTimeChange to the last valid slot of the day (23:45), not an out-of-range value', () => {
      const container = freshContainer();
      const onTimeChange = vi.fn();
      const t = task({ planning: { time: '10:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], { ...callbacks(), onTimeChange });
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      block.setPointerCapture = () => {};
      block.releasePointerCapture = () => {};
      block.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      // +100000px is the exact live-reproduced magnitude that used to compute "2093:15".
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientY: 100 + 100000, pointerId: 1 }),
      );
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 100 + 100000, pointerId: 1 }));
      expect(onTimeChange).toHaveBeenCalledTimes(1);
      const [, minutes] = onTimeChange.mock.calls[0] as [unknown, number];
      expect(minutes).toBe(24 * 60 - 15); // 23:45
      expect(minutes).toBeLessThan(24 * 60);
    });

    it('an extreme downward drag on the resize handle clamps onDurationChange to a one-day cap, not an unbounded value', () => {
      const container = freshContainer();
      const onDurationChange = vi.fn();
      const t = task({ planning: { time: '10:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], { ...callbacks(), onDurationChange });
      const handle = container.querySelector('.tc-tg-resize-handle') as HTMLElement;
      handle.setPointerCapture = () => {};
      handle.releasePointerCapture = () => {};
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientY: 100 + 100000, pointerId: 1 }),
      );
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 100 + 100000, pointerId: 1 }));
      expect(onDurationChange).toHaveBeenCalledTimes(1);
      const [, minutes] = onDurationChange.mock.calls[0] as [unknown, number];
      expect(minutes).toBe(24 * 60);
    });

    it('an ordinary in-range drag is unaffected by the new clamp', () => {
      const container = freshContainer();
      const onTimeChange = vi.fn();
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], { ...callbacks(), onTimeChange });
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      block.setPointerCapture = () => {};
      block.releasePointerCapture = () => {};
      block.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 148, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 148, pointerId: 1 }));
      expect(onTimeChange).toHaveBeenCalledWith(t, 9 * 60 + 60);
    });
  });

  it('a stationary right-click on the resize handle does NOT fire onDurationChange', () => {
    const container = freshContainer();
    const onDurationChange = vi.fn();
    const t = task({ planning: { time: '09:00', duration: 60 } });
    renderTimedBlocksForDay(container, [t], {
      app: fakeApp,
      component: new Component(),
      onTaskClick: vi.fn(),
      onKeyboardIntent: vi.fn(),
      onTimeChange: vi.fn(),
      onDurationChange,
      onExtendToSpan: vi.fn(),
      onStartChange: vi.fn(),
      onToggle: vi.fn(),
      onSetStatus: vi.fn(),
      onSetPriority: vi.fn(),
      statusRegistry: registry,
    });
    const handle = container.querySelector('.tc-tg-resize-handle') as HTMLElement;
    handle.setPointerCapture = () => {};
    handle.releasePointerCapture = () => {};
    handle.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1, button: 2 }),
    );
    window.dispatchEvent(new PointerEvent('pointerup', { clientY: 100, pointerId: 1, button: 2 }));
    expect(onDurationChange).not.toHaveBeenCalled();
  });

  it('renders count badges in a top-right .tc-tg-block-badges container when the task has them, and never a tag chip even when the task has tags (Task 35)', () => {
    const container = freshContainer();
    const t = task({
      tags: ['#work'],
      comments: [taskComment({ text: 'note' })],
      planning: { time: '09:00' },
      source: { originalMarkdown: '- [ ] t #work', originalBlock: '- [ ] t #work' },
      presentation: { linkCount: 2 },
    });
    renderTimedBlocksForDay(container, [t], callbacks(), [
      { id: '1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#3498db' },
    ]);
    const block = container.querySelector('.tc-tg-block') as HTMLElement;
    const badges = block.querySelector('.tc-tg-block-badges') as HTMLElement;
    expect(badges).not.toBeNull();
    expect(badges.querySelectorAll('.tc-task-count-badge')).toHaveLength(2); // comment + link
    expect(block.querySelector('.tc-task-tag')).toBeNull();
    expect(block.querySelector('.tc-tg-block-meta')).toBeNull();
  });

  it('omits .tc-tg-block-badges entirely for a task with no subtasks/comments/links (including a tag-only task, since tags no longer render anything here)', () => {
    const container = freshContainer();
    const plain = task({ planning: { time: '09:00' } });
    const tagOnly = task({
      tags: ['#work'],
      planning: { time: '10:00' },
      source: { originalMarkdown: '- [ ] t #work', originalBlock: '- [ ] t #work', line: 1 },
    });
    renderTimedBlocksForDay(container, [plain, tagOnly], callbacks());
    expect(container.querySelector('.tc-tg-block-badges')).toBeNull();
    expect(container.querySelector('.tc-task-tag')).toBeNull();
  });

  describe('native HTML5 drag-out (Task 26: drop onto the all-day row)', () => {
    it('the block is draggable="true", matching the all-day cross-day drag convention', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      expect(block.getAttribute('draggable')).toBe('true');
    });

    it('the resize handle stays draggable="false" (Round 2 Task 9 pattern: a non-draggable island inside a draggable ancestor)', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const handle = container.querySelector('.tc-tg-resize-handle') as HTMLElement;
      expect(handle.getAttribute('draggable')).toBe('false');
    });

    it('dragstart on the block carries the filePath:::line payload, the same convention as renderAllDay.ts', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00' }, source: { filePath: 'a.md', line: 3 } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const dt = dispatchDnD(block, 'dragstart');
      expect(dt.getData('text/plain')).toBe('a.md:::3');
    });

    it('dragstart adds is-dragging, dragend removes it (mirrors renderAllDay.ts body)', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      dispatchDnD(block, 'dragstart');
      expect(block.hasClass('is-dragging')).toBe(true);
      dispatchDnD(block, 'dragend');
      expect(block.hasClass('is-dragging')).toBe(false);
    });

    it('regression: vertical Pointer-Events move still fires onTimeChange after draggable="true" was added', () => {
      const container = freshContainer();
      const onTimeChange = vi.fn();
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], { ...callbacks(), onTimeChange });
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      block.setPointerCapture = () => {};
      block.releasePointerCapture = () => {};
      block.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 148, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 148, pointerId: 1 }));
      expect(onTimeChange).toHaveBeenCalledWith(t, 9 * 60 + 60);
    });

    it('a pointercancel mid-gesture (simulating the browser hijacking the pointer session into a native drag) cleans up without firing onTimeChange/onDurationChange', () => {
      const container = freshContainer();
      const onTimeChange = vi.fn();
      const onDurationChange = vi.fn();
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], { ...callbacks(), onTimeChange, onDurationChange });
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      block.setPointerCapture = () => {};
      block.releasePointerCapture = () => {};
      block.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 148, pointerId: 1 }));
      // The native drag has taken over the pointer session: the browser fires pointercancel
      // instead of a normal pointerup for this gesture.
      block.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
      expect(onTimeChange).not.toHaveBeenCalled();
      expect(onDurationChange).not.toHaveBeenCalled();
      // A subsequent, unrelated pointerdown/move/up gesture must behave normally — proving the
      // window pointermove/pointerup listeners from the cancelled gesture were torn down, not
      // leaked (which would otherwise double-fire onTimeChange on the next real gesture).
      block.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 200, pointerId: 2 }),
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 248, pointerId: 2 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 248, pointerId: 2 }));
      expect(onTimeChange).toHaveBeenCalledTimes(1);
    });

    it('a pointercancel mid-MOVE reverts the live-preview top back to the pre-gesture position, since no mutation committed (regression: previously left the block visually parked at the abandoned preview position with no underlying data change)', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      block.setPointerCapture = () => {};
      block.releasePointerCapture = () => {};
      const originalTop = block.style.top;
      block.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 148, pointerId: 1 }));
      // Live preview moved the block — confirm the preview actually changed something before
      // asserting it gets reverted.
      expect(block.style.top).not.toBe(originalTop);
      // Dispatched directly on `window` (not via bubbling from `block`): freshContainer()'s
      // element is never attached to `document`, so a bubbling event dispatched on a detached
      // descendant never actually reaches `window` in jsdom — same caveat this file's other
      // pointercancel tests document (e.g. the is-picked-up suite above).
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
      expect(block.style.top).toBe(originalTop);
    });

    it('a pointercancel mid-RESIZE reverts the live-preview height back to the pre-gesture duration', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const handle = container.querySelector('.tc-tg-resize-handle') as HTMLElement;
      handle.setPointerCapture = () => {};
      handle.releasePointerCapture = () => {};
      const originalHeight = block.style.height;
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 148, pointerId: 1 }));
      expect(block.style.height).not.toBe(originalHeight);
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
      expect(block.style.height).toBe(originalHeight);
    });

    describe('ancestor-draggable-toggle fix: draggable="false" on the handle alone does not stop the ancestor fallback (mirrors renderAllDay.ts attachEdgeResize)', () => {
      it("pointerdown on the vertical resize handle flips the block's own draggable to false (resize mode), restored on pointerup", () => {
        const container = freshContainer();
        const t = task({ planning: { time: '09:00', duration: 60 } });
        renderTimedBlocksForDay(container, [t], callbacks());
        const block = container.querySelector('.tc-tg-block') as HTMLElement;
        const handle = container.querySelector('.tc-tg-resize-handle') as HTMLElement;
        handle.setPointerCapture = () => {};
        handle.releasePointerCapture = () => {};

        expect(block.getAttribute('draggable')).toBe('true');
        handle.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
        );
        expect(block.getAttribute('draggable')).toBe('false');
        window.dispatchEvent(new PointerEvent('pointerup', { clientY: 148, pointerId: 1 }));
        expect(block.getAttribute('draggable')).toBe('true');
      });

      it("a pointercancel mid-resize (native drag hijacking the session) also restores the block's draggable to true", () => {
        const container = freshContainer();
        const t = task({ planning: { time: '09:00', duration: 60 } });
        renderTimedBlocksForDay(container, [t], callbacks());
        const block = container.querySelector('.tc-tg-block') as HTMLElement;
        const handle = container.querySelector('.tc-tg-resize-handle') as HTMLElement;
        handle.setPointerCapture = () => {};
        handle.releasePointerCapture = () => {};

        handle.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
        );
        expect(block.getAttribute('draggable')).toBe('false');
        window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
        expect(block.getAttribute('draggable')).toBe('true');
      });

      it('grabbing the block BODY (move mode, the legitimate drag-out-to-all-day gesture) does NOT flip draggable to false — only the resize handle does', () => {
        const container = freshContainer();
        const t = task({ planning: { time: '09:00', duration: 60 } });
        renderTimedBlocksForDay(container, [t], callbacks());
        const block = container.querySelector('.tc-tg-block') as HTMLElement;
        block.setPointerCapture = () => {};
        block.releasePointerCapture = () => {};

        block.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
        );
        expect(block.getAttribute('draggable')).toBe('true');
        window.dispatchEvent(new PointerEvent('pointerup', { clientY: 100, pointerId: 1 }));
        expect(block.getAttribute('draggable')).toBe('true');
      });
    });
  });

  describe('Task 39: pick-up visual feedback on a move-mode drag', () => {
    it('pointerdown on the block body (move mode) immediately adds is-picked-up', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      block.setPointerCapture = () => {};
      block.releasePointerCapture = () => {};
      expect(block.hasClass('is-picked-up')).toBe(false);
      block.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      expect(block.hasClass('is-picked-up')).toBe(true);
    });

    it('releasing (pointerup) removes is-picked-up', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      block.setPointerCapture = () => {};
      block.releasePointerCapture = () => {};
      block.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 148, pointerId: 1 }));
      expect(block.hasClass('is-picked-up')).toBe(false);
    });

    it('a pointercancel mid-gesture also removes is-picked-up (does not get stuck on)', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      block.setPointerCapture = () => {};
      block.releasePointerCapture = () => {};
      block.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      // Dispatched directly on `window` (not via bubbling from `block`): freshContainer()'s
      // element is never attached to `document`, so a bubbling event dispatched on a
      // detached descendant never actually reaches `window` in jsdom — same caveat this
      // file's horizontal-edge-resize suite documents for the identical reason.
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
      expect(block.hasClass('is-picked-up')).toBe(false);
    });

    it('pointerdown on the vertical resize handle (resize mode, not move) does NOT add is-picked-up', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const handle = container.querySelector('.tc-tg-resize-handle') as HTMLElement;
      handle.setPointerCapture = () => {};
      handle.releasePointerCapture = () => {};
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      expect(block.hasClass('is-picked-up')).toBe(false);
    });

    it('.tc-tg-block.is-picked-up gets a distinct visual treatment from .is-dragging (not opacity-based)', () => {
      const rule = declarationsFor('.tc-tg-block.is-picked-up');
      expect(rule).not.toBe('');
      expect(rule).not.toMatch(/opacity\s*:/u);
    });
  });

  describe('Task 39: live preview during vertical move/resize matches the committed value exactly', () => {
    // attachDrag already repositions the actual block element (top/height) live on every
    // pointermove, snapped via the same `snapMinutes(rawDelta, SNAP_MINUTES)` call the
    // pointerup commit handler uses — this suite locks in that the two can never drift apart
    // (e.g. a future edit that snaps one but not the other), which is exactly what "release
    // and it lands where you saw it" depends on.
    it('move: the live top (mid-drag) equals minutesToPixels of the value committed via onTimeChange', () => {
      const container = freshContainer();
      const onTimeChange = vi.fn();
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], { ...callbacks(), onTimeChange });
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      block.setPointerCapture = () => {};
      block.releasePointerCapture = () => {};
      block.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      // +37px is not an exact 15-minute increment in pixels (48px/hour => 12px/15min), so this
      // also exercises that the live preview snaps rather than tracking the raw pixel delta.
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 137, pointerId: 1 }));
      const liveTopPx = parseFloat(block.style.top);
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 137, pointerId: 1 }));
      expect(onTimeChange).toHaveBeenCalledTimes(1);
      const [, committedMinutes] = onTimeChange.mock.calls[0] as [unknown, number];
      expect(liveTopPx).toBe((committedMinutes / 60) * 48);
    });

    it('resize: the live height (mid-drag) equals minutesToPixels of the value committed via onDurationChange', () => {
      const container = freshContainer();
      const onDurationChange = vi.fn();
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], { ...callbacks(), onDurationChange });
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const handle = container.querySelector('.tc-tg-resize-handle') as HTMLElement;
      handle.setPointerCapture = () => {};
      handle.releasePointerCapture = () => {};
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 137, pointerId: 1 }));
      const liveHeightPx = parseFloat(block.style.height);
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 137, pointerId: 1 }));
      expect(onDurationChange).toHaveBeenCalledTimes(1);
      const [, committedMinutes] = onDurationChange.mock.calls[0] as [unknown, number];
      expect(liveHeightPx).toBe((committedMinutes / 60) * 48);
    });
  });

  describe('relative keyboard intents', () => {
    it('stores stable task identity and visual start data on every block root', () => {
      const container = freshContainer();
      const t = task({
        source: { filePath: 'Folder/task.md', line: 17 },
        planning: { time: '09:30', duration: 60 },
      });

      renderTimedBlocksForDay(container, [t], callbacks());

      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      expect(block.dataset['tcTaskFile']).toBe('Folder/task.md');
      expect(block.dataset['tcTaskLine']).toBe('17');
      expect(block.dataset['tcStartMinutes']).toBe('570');
    });

    it('the block is a keyboard-focusable target (tabindex="0")', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      expect(block.getAttribute('tabindex')).toBe('0');
    });

    it.each([
      ['ArrowUp', false, { type: 'move-time', deltaMinutes: -15 }],
      ['ArrowDown', false, { type: 'move-time', deltaMinutes: 15 }],
      ['ArrowUp', true, { type: 'resize-duration', deltaMinutes: -5 }],
      ['ArrowDown', true, { type: 'resize-duration', deltaMinutes: 5 }],
      ['ArrowLeft', false, { type: 'shift-schedule', days: -1 }],
      ['ArrowRight', false, { type: 'shift-schedule', days: 1 }],
      ['ArrowLeft', true, { type: 'extend-start', days: -1 }],
      ['ArrowRight', true, { type: 'extend-due', days: 1 }],
    ] as const)(
      '%s with shift=%s emits the exact relative intent and prevents default',
      (key, shiftKey, intent) => {
        const container = freshContainer();
        const cbs = callbacks();
        const t = task({ planning: { time: '09:00', duration: 60 } });
        renderTimedBlocksForDay(container, [t], cbs);
        const block = container.querySelector('.tc-tg-block') as HTMLElement;
        const event = new KeyboardEvent('keydown', {
          key,
          shiftKey,
          bubbles: true,
          cancelable: true,
        });

        block.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(cbs.onKeyboardIntent).toHaveBeenCalledWith(t, intent);
        expect(cbs.onTimeChange).not.toHaveBeenCalled();
        expect(cbs.onDurationChange).not.toHaveBeenCalled();
        expect(cbs.onStartChange).not.toHaveBeenCalled();
        expect(cbs.onExtendToSpan).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['ctrlKey', { ctrlKey: true }],
      ['metaKey', { metaKey: true }],
      ['altKey', { altKey: true }],
    ] as const)(
      '%s bypasses every arrow-key intent without preventing default',
      (_name, modifier) => {
        const container = freshContainer();
        const cbs = callbacks();
        const t = task({ planning: { time: '09:00', duration: 60 } });
        renderTimedBlocksForDay(container, [t], cbs);
        const block = container.querySelector('.tc-tg-block') as HTMLElement;

        for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
          const event = new KeyboardEvent('keydown', {
            key,
            shiftKey: true,
            ...modifier,
            bubbles: true,
            cancelable: true,
          });
          block.dispatchEvent(event);
          expect(event.defaultPrevented).toBe(false);
        }

        expect(cbs.onKeyboardIntent).not.toHaveBeenCalled();
        expect(cbs.onTimeChange).not.toHaveBeenCalled();
        expect(cbs.onDurationChange).not.toHaveBeenCalled();
        expect(cbs.onStartChange).not.toHaveBeenCalled();
        expect(cbs.onExtendToSpan).not.toHaveBeenCalled();
      },
    );

    it('handles an arrow key bubbled from an embedded link, but ignores non-arrow keys', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], cbs);
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const link = block.querySelector('.tc-tg-block-title')!.createEl('a');

      link.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      block.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

      expect(cbs.onKeyboardIntent).toHaveBeenCalledTimes(1);
      expect(cbs.onKeyboardIntent).toHaveBeenCalledWith(t, {
        type: 'move-time',
        deltaMinutes: 15,
      });
    });

    it('.tc-tg-block:focus-visible gets a distinct outline so a keyboard user can see which block arrow keys will nudge', () => {
      const rule = declarationsFor('.tc-tg-block:focus-visible');
      expect(rule).toMatch(/outline\s*:/u);
    });
  });

  describe('cyclic same-day Tab navigation', () => {
    it('follows visual start order, uses DOM order for tied starts, wraps, and stays in the current day', () => {
      const container = freshContainer();
      document.body.appendChild(container);
      const firstDay = container.createDiv({ cls: 'tc-tg-day-column' });
      const firstHourColumn = firstDay.createDiv({ cls: 'tc-tg-hour-column' });
      const secondDay = container.createDiv({ cls: 'tc-tg-day-column' });
      const secondHourColumn = secondDay.createDiv({ cls: 'tc-tg-hour-column' });
      const late = task({
        source: { filePath: 'late.md', line: 1 },
        planning: { time: '10:00', duration: 60 },
      });
      const tiedFirst = task({
        source: { filePath: 'tied-first.md', line: 2 },
        planning: { time: '09:00', duration: 60 },
      });
      const tiedSecond = task({
        source: { filePath: 'tied-second.md', line: 3 },
        planning: { time: '09:00', duration: 60 },
      });
      const otherDay = task({
        source: { filePath: 'other-day.md', line: 4 },
        planning: { time: '09:15', duration: 60 },
      });
      renderTimedBlocksForDay(firstHourColumn, [late, tiedFirst, tiedSecond], callbacks());
      renderTimedBlocksForDay(secondHourColumn, [otherDay], callbacks());
      const byFile = (filePath: string): HTMLElement =>
        container.querySelector(`[data-tc-task-file="${filePath}"]`) as HTMLElement;
      const tiedFirstBlock = byFile('tied-first.md');
      const tiedSecondBlock = byFile('tied-second.md');
      const lateBlock = byFile('late.md');
      const otherDayBlock = byFile('other-day.md');

      tiedFirstBlock.focus();
      const firstTab = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      });
      tiedFirstBlock.dispatchEvent(firstTab);
      expect(firstTab.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(tiedSecondBlock);

      tiedSecondBlock.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      );
      expect(document.activeElement).toBe(lateBlock);

      lateBlock.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      );
      expect(document.activeElement).toBe(tiedFirstBlock);
      expect(document.activeElement).not.toBe(otherDayBlock);

      tiedFirstBlock.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(document.activeElement).toBe(lateBlock);
      container.remove();
    });

    it('moves from an embedded link to the next block root', () => {
      const container = freshContainer();
      document.body.appendChild(container);
      const day = container.createDiv({ cls: 'tc-tg-day-column' });
      const hourColumn = day.createDiv({ cls: 'tc-tg-hour-column' });
      const first = task({
        source: { filePath: 'first.md', line: 1 },
        planning: { time: '09:00' },
      });
      const second = task({
        source: { filePath: 'second.md', line: 2 },
        planning: { time: '10:00' },
      });
      renderTimedBlocksForDay(hourColumn, [first, second], callbacks());
      const blocks = Array.from(container.querySelectorAll<HTMLElement>('.tc-tg-block'));
      const link = blocks[0]!.querySelector('.tc-tg-block-title')!.createEl('a');
      link.href = '#';
      link.focus();

      link.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      );

      expect(document.activeElement).toBe(blocks[1]);
      container.remove();
    });

    it('wraps a single isolated hour-column item onto its own root', () => {
      const hourColumn = freshContainer();
      hourColumn.addClass('tc-tg-hour-column');
      document.body.appendChild(hourColumn);
      renderTimedBlocksForDay(hourColumn, [task({ planning: { time: '09:00' } })], callbacks());
      const block = hourColumn.querySelector('.tc-tg-block') as HTMLElement;
      block.focus();

      block.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }),
      );
      expect(document.activeElement).toBe(block);
      block.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(document.activeElement).toBe(block);
      hourColumn.remove();
    });

    it.each([
      ['ctrlKey', { ctrlKey: true }],
      ['metaKey', { metaKey: true }],
      ['altKey', { altKey: true }],
    ] as const)('%s bypasses Tab and Shift+Tab without preventing default', (_name, modifier) => {
      const container = freshContainer();
      document.body.appendChild(container);
      const day = container.createDiv({ cls: 'tc-tg-day-column' });
      const hourColumn = day.createDiv({ cls: 'tc-tg-hour-column' });
      renderTimedBlocksForDay(
        hourColumn,
        [task({ planning: { time: '09:00' } }), task({ planning: { time: '10:00' } })],
        callbacks(),
      );
      const blocks = Array.from(container.querySelectorAll<HTMLElement>('.tc-tg-block'));
      blocks[0]!.focus();

      for (const shiftKey of [false, true]) {
        const event = new KeyboardEvent('keydown', {
          key: 'Tab',
          shiftKey,
          ...modifier,
          bubbles: true,
          cancelable: true,
        });
        blocks[0]!.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
        expect(document.activeElement).toBe(blocks[0]);
      }
      container.remove();
    });
  });

  describe('Task 49: .is-selected reflects native DOM focus (click-to-select or Tab)', () => {
    it('focusing the block adds is-selected', () => {
      const container = freshContainer();
      document.body.appendChild(container);
      const t = task({ planning: { time: '09:00' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      expect(block.hasClass('is-selected')).toBe(false);
      block.focus();
      expect(block.hasClass('is-selected')).toBe(true);
      container.remove();
    });

    it('blurring the block removes is-selected', () => {
      const container = freshContainer();
      document.body.appendChild(container);
      const t = task({ planning: { time: '09:00' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      block.focus();
      expect(block.hasClass('is-selected')).toBe(true);
      block.blur();
      expect(block.hasClass('is-selected')).toBe(false);
      container.remove();
    });

    it('.tc-tg-block.is-selected is a distinct, styled rule from .is-picked-up/.is-dragging/.is-edge-resizing (no shared selector) and can coexist with is-picked-up without dropping either class', () => {
      const rule = declarationsFor('.tc-tg-block.is-selected');
      expect(rule).not.toBe('');
      // Distinct rule bodies: is-selected must not just be an alias reusing is-picked-up's
      // scale/shadow transform (that's the transient drag-feedback language, not "selected").
      const pickedUpRule = declarationsFor('.tc-tg-block.is-picked-up');
      expect(rule).not.toBe(pickedUpRule);

      const container = freshContainer();
      document.body.appendChild(container);
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      block.setPointerCapture = () => {};
      block.releasePointerCapture = () => {};
      block.focus();
      expect(block.hasClass('is-selected')).toBe(true);
      block.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      // Both classes coexist mid-drag of an already-selected block — neither toggle clobbers
      // the other's class.
      expect(block.hasClass('is-selected')).toBe(true);
      expect(block.hasClass('is-picked-up')).toBe(true);
      container.remove();
    });

    it('Bug fix (focus/blur robustness): tabbing from the block onto its own embedded link (a real, independently-focusable descendant renderTaskText.ts can produce) does not drop is-selected', () => {
      const container = freshContainer();
      document.body.appendChild(container);
      const t = task({ planning: { time: '09:00' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const title = block.querySelector('.tc-tg-block-title') as HTMLElement;
      const link = document.createElement('a');
      link.href = '#';
      link.tabIndex = 0;
      title.appendChild(link);

      block.focus();
      expect(block.hasClass('is-selected')).toBe(true);
      // Focus moves from the block onto its own embedded link — still inside the block subtree.
      link.focus();
      expect(block.hasClass('is-selected')).toBe(true);
      // Focus moves back onto the block itself.
      block.focus();
      expect(block.hasClass('is-selected')).toBe(true);
      // Only focus actually leaving the block entirely removes is-selected.
      const outsider = document.createElement('button');
      document.body.appendChild(outsider);
      outsider.focus();
      expect(block.hasClass('is-selected')).toBe(false);
      container.remove();
      outsider.remove();
    });

    it('Bug fix (focus/blur robustness): keyboard intent handling keeps working while focus sits on an embedded link inside the block', () => {
      const container = freshContainer();
      document.body.appendChild(container);
      const onKeyboardIntent = vi.fn();
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], { ...callbacks(), onKeyboardIntent });
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const title = block.querySelector('.tc-tg-block-title') as HTMLElement;
      const link = document.createElement('a');
      link.href = '#';
      link.tabIndex = 0;
      title.appendChild(link);

      link.focus();
      link.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      expect(onKeyboardIntent).toHaveBeenCalledWith(t, {
        type: 'move-time',
        deltaMinutes: 15,
      });
      container.remove();
    });
  });

  describe('horizontal edge-resize to a multi-day timed span (Task 29, right edge only)', () => {
    // jsdom has no elementFromPoint implementation at all (unlike a real browser, where it
    // always resolves to something). Any test in this block that dispatches a real window
    // pointerup for the horizontal handle's pointerId — including a *stale* one left behind by
    // an earlier test that armed the gesture via pointerdown but resolved it through the
    // __tgTestEndDrag seam instead of a real pointerup — would otherwise throw. Stubbing it to
    // return null for the whole block keeps every test's real-pointerup path a harmless no-op,
    // matching timegrid-allday.test.ts's per-test stub but applied uniformly here since this
    // block mixes real-pointerup and test-hook-driven tests.
    let originalElementFromPoint: typeof activeDocument.elementFromPoint;
    beforeEach(() => {
      originalElementFromPoint = activeDocument.elementFromPoint;
      activeDocument.elementFromPoint = () => null;
    });
    afterEach(() => {
      activeDocument.elementFromPoint = originalElementFromPoint;
    });

    it('renders a right-edge horizontal resize handle on every timed block', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const handle = block.querySelector('.tc-tg-span-edge--right') as HTMLElement;
      expect(handle).not.toBeNull();
    });

    it('the horizontal handle stays draggable="false" (same defensive island-in-a-draggable-ancestor pattern as the vertical resize handle)', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const handle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;
      expect(handle.getAttribute('draggable')).toBe('false');
    });

    it('pointer-dragging the horizontal handle fires onExtendToSpan with the resolved date, not onTimeChange/onDurationChange', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], cbs);
      const handle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      // jsdom's elementFromPoint always returns null, so real coordinate-based day resolution
      // can't be exercised here — this drives the same deterministic __tgTestEndDrag seam
      // renderAllDay.ts established (Round 2 Task 9), registered here on the hourColumnEl
      // (the `container` this suite renders into) rather than an all-day cell.
      (container as unknown as { __tgTestEndDrag: (date: string) => void }).__tgTestEndDrag(
        '2026-07-12',
      );
      expect(cbs.onExtendToSpan).toHaveBeenCalledWith(t, '2026-07-12');
      expect(cbs.onTimeChange).not.toHaveBeenCalled();
      expect(cbs.onDurationChange).not.toHaveBeenCalled();
    });

    it('a pointerdown on the horizontal handle does not arm the vertical move/resize gesture (a subsequent window pointermove/pointerup does not fire onTimeChange/onDurationChange)', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({ planning: { time: '09:00', duration: 60, due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], cbs);
      const handle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 148, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 148, pointerId: 1 }));
      expect(cbs.onTimeChange).not.toHaveBeenCalled();
      expect(cbs.onDurationChange).not.toHaveBeenCalled();
    });

    describe('Task 39: live day-target highlight while dragging the horizontal handle', () => {
      // The commit-time resolution already depends on elementFromPoint (unimplemented in
      // jsdom), so — per the brief's own guidance for this class of mechanism — these assert
      // the live-highlight MECHANISM computes the right thing when fed a stand-in day element,
      // rather than forcing a real-layout/real-elementFromPoint assertion jsdom cannot support.
      it('pointermove over a day column adds is-drag-over to that column', () => {
        const container = freshContainer();
        const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
        renderTimedBlocksForDay(container, [t], callbacks());
        const handle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;
        const dayEl = document.createElement('div');
        dayEl.setAttribute('data-tg-date', '2026-07-12');
        activeDocument.elementFromPoint = () => dayEl;
        handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1 }));
        expect(dayEl.classList.contains('is-drag-over')).toBe(true);
      });

      it('moving from one day column to another moves the highlight, never leaving two columns highlighted at once', () => {
        const container = freshContainer();
        const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
        renderTimedBlocksForDay(container, [t], callbacks());
        const handle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;
        const dayA = document.createElement('div');
        dayA.setAttribute('data-tg-date', '2026-07-11');
        const dayB = document.createElement('div');
        dayB.setAttribute('data-tg-date', '2026-07-12');
        activeDocument.elementFromPoint = () => dayA;
        handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1 }));
        expect(dayA.classList.contains('is-drag-over')).toBe(true);
        activeDocument.elementFromPoint = () => dayB;
        window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1 }));
        expect(dayA.classList.contains('is-drag-over')).toBe(false);
        expect(dayB.classList.contains('is-drag-over')).toBe(true);
      });

      it('releasing (pointerup) clears the highlight', () => {
        const container = freshContainer();
        const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
        renderTimedBlocksForDay(container, [t], callbacks());
        const handle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;
        const dayEl = document.createElement('div');
        dayEl.setAttribute('data-tg-date', '2026-07-12');
        activeDocument.elementFromPoint = () => dayEl;
        handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1 }));
        expect(dayEl.classList.contains('is-drag-over')).toBe(true);
        window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
        expect(dayEl.classList.contains('is-drag-over')).toBe(false);
      });

      it('a pointercancel mid-gesture also clears the highlight (does not get stuck on)', () => {
        const container = freshContainer();
        const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
        renderTimedBlocksForDay(container, [t], callbacks());
        const handle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;
        const dayEl = document.createElement('div');
        dayEl.setAttribute('data-tg-date', '2026-07-12');
        activeDocument.elementFromPoint = () => dayEl;
        handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1 }));
        expect(dayEl.classList.contains('is-drag-over')).toBe(true);
        window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
        expect(dayEl.classList.contains('is-drag-over')).toBe(false);
      });
    });

    it("a pointercancel mid-gesture on the horizontal handle (simulating the browser hijacking the pointer session into a native drag, mirroring Task 26's vertical-drag fix) tears down its window listeners: a subsequent real pointerup that WOULD resolve to a day does not fire onExtendToSpan", () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], cbs);
      const handle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;
      // Override the describe-block-wide null stub just for this test: a day-column stand-in
      // that DOES resolve to a date, so that a still-live pointerup listener would provably
      // fire onExtendToSpan — proving its absence here is due to pointercancel's cleanup, not
      // just the stub returning null anyway.
      const fakeDayEl = document.createElement('div');
      fakeDayEl.setAttribute('data-tg-date', '2026-07-12');
      activeDocument.elementFromPoint = () => fakeDayEl;
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      // Dispatched directly on `window` (not `handle.dispatchEvent(..., {bubbles: true})`):
      // freshContainer()'s element is never attached to `document`, so a bubbling event
      // dispatched on a detached descendant never actually reaches `window` in jsdom — the
      // same reason this suite's pointermove/pointerup gestures always dispatch straight on
      // `window` rather than relying on bubbling from the block/handle.
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
      expect(cbs.onExtendToSpan).not.toHaveBeenCalled();
    });

    it('regression: vertical Pointer-Events move on the block body still fires onTimeChange after the horizontal handle was added', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], cbs);
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      block.setPointerCapture = () => {};
      block.releasePointerCapture = () => {};
      block.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 148, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 148, pointerId: 1 }));
      expect(cbs.onTimeChange).toHaveBeenCalledWith(t, 9 * 60 + 60);
    });

    it('regression: dragging the vertical resize handle still fires onDurationChange after the horizontal handle was added', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], cbs);
      const handle = container.querySelector('.tc-tg-resize-handle') as HTMLElement;
      handle.setPointerCapture = () => {};
      handle.releasePointerCapture = () => {};
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 148, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 148, pointerId: 1 }));
      expect(cbs.onDurationChange).toHaveBeenCalledWith(t, 120);
      expect(cbs.onExtendToSpan).not.toHaveBeenCalled();
    });

    it("pointerdown on the right-edge handle flips the block's own draggable to false (blocking the native-drag-ancestor-fallback), restored on pointerup", () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const handle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;

      expect(block.getAttribute('draggable')).toBe('true');
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      expect(block.getAttribute('draggable')).toBe('false');
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
      expect(block.getAttribute('draggable')).toBe('true');
    });

    it('a pointercancel mid-drag on the right-edge handle also restores draggable to true', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const handle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;

      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      expect(block.getAttribute('draggable')).toBe('false');
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
      expect(block.getAttribute('draggable')).toBe('true');
    });
  });

  describe('horizontal edge-resize to a multi-day timed span (Task 34: left edge, adding/moving `start`)', () => {
    // Same jsdom elementFromPoint caveat/stub as the Task 29 right-edge suite above.
    let originalElementFromPoint: typeof activeDocument.elementFromPoint;
    beforeEach(() => {
      originalElementFromPoint = activeDocument.elementFromPoint;
      activeDocument.elementFromPoint = () => null;
    });
    afterEach(() => {
      activeDocument.elementFromPoint = originalElementFromPoint;
    });

    it('renders a left-edge horizontal resize handle on every timed block, alongside the existing right edge', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      expect(block.querySelector('.tc-tg-span-edge--left')).not.toBeNull();
      expect(block.querySelector('.tc-tg-span-edge--right')).not.toBeNull();
    });

    it('the left-edge handle stays draggable="false" (same defensive island-in-a-draggable-ancestor pattern as the right edge and the vertical resize handle)', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const handle = container.querySelector('.tc-tg-span-edge--left') as HTMLElement;
      expect(handle.getAttribute('draggable')).toBe('false');
    });

    it('pointer-dragging the left-edge handle fires onStartChange with the resolved date, not onExtendToSpan/onTimeChange/onDurationChange', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], cbs);
      const handle = container.querySelector('.tc-tg-span-edge--left') as HTMLElement;
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      // Same deterministic __tgTestEndDrag seam the right-edge suite uses, driven here via the
      // left handle's own pointerdown so only ITS resolve is armed (see renderTimedBlocks.ts's
      // Task 34 comment on why `__tgPendingEdgeResizes` now tracks the armed handle only, not
      // every handle ever rendered into this hourColumnEl).
      (container as unknown as { __tgTestEndDrag: (date: string) => void }).__tgTestEndDrag(
        '2026-07-08',
      );
      expect(cbs.onStartChange).toHaveBeenCalledWith(t, '2026-07-08');
      expect(cbs.onExtendToSpan).not.toHaveBeenCalled();
      expect(cbs.onTimeChange).not.toHaveBeenCalled();
      expect(cbs.onDurationChange).not.toHaveBeenCalled();
    });

    it('pointer-dragging the RIGHT edge on a block that also has a left edge still fires only onExtendToSpan, not onStartChange (the two handles do not cross-fire on the shared hourColumnEl test seam)', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], cbs);
      const rightHandle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;
      rightHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      (container as unknown as { __tgTestEndDrag: (date: string) => void }).__tgTestEndDrag(
        '2026-07-12',
      );
      expect(cbs.onExtendToSpan).toHaveBeenCalledWith(t, '2026-07-12');
      expect(cbs.onStartChange).not.toHaveBeenCalled();
    });

    it('a pointerdown on the left-edge handle does not arm the vertical move/resize gesture (a subsequent window pointermove/pointerup does not fire onTimeChange/onDurationChange)', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({ planning: { time: '09:00', duration: 60, due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], cbs);
      const handle = container.querySelector('.tc-tg-span-edge--left') as HTMLElement;
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 148, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 148, pointerId: 1 }));
      expect(cbs.onTimeChange).not.toHaveBeenCalled();
      expect(cbs.onDurationChange).not.toHaveBeenCalled();
    });

    it("a pointercancel mid-gesture on the left-edge handle (mirroring the right edge's Task 29 fix) tears down its window listeners: a subsequent real pointerup that WOULD resolve to a day does not fire onStartChange", () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], cbs);
      const handle = container.querySelector('.tc-tg-span-edge--left') as HTMLElement;
      const fakeDayEl = document.createElement('div');
      fakeDayEl.setAttribute('data-tg-date', '2026-07-08');
      activeDocument.elementFromPoint = () => fakeDayEl;
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
      expect(cbs.onStartChange).not.toHaveBeenCalled();
    });

    it("Task 51: dragging the left edge past the block's own due date clamps to due (start=due), never firing onStartChange with a date after due", () => {
      const container = freshContainer();
      const cbs = callbacks();
      // The exact repro: a 3-day span, left edge dragged right past its own due day.
      const t = task({
        planning: { time: '13:00', duration: 60, start: '2026-07-13', due: '2026-07-15' },
      });
      renderTimedBlocksForDay(container, [t], cbs);
      const handle = container.querySelector('.tc-tg-span-edge--left') as HTMLElement;
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      (container as unknown as { __tgTestEndDrag: (date: string) => void }).__tgTestEndDrag(
        '2026-07-16',
      );
      expect(cbs.onStartChange).toHaveBeenCalledWith(t, '2026-07-15');
      expect(cbs.onStartChange).not.toHaveBeenCalledWith(t, '2026-07-16');
    });

    it('Task 51: dragging the left edge to a date still before/at due is unaffected by the clamp', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({
        planning: { time: '13:00', duration: 60, start: '2026-07-13', due: '2026-07-15' },
      });
      renderTimedBlocksForDay(container, [t], cbs);
      const handle = container.querySelector('.tc-tg-span-edge--left') as HTMLElement;
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      (container as unknown as { __tgTestEndDrag: (date: string) => void }).__tgTestEndDrag(
        '2026-07-14',
      );
      expect(cbs.onStartChange).toHaveBeenCalledWith(t, '2026-07-14');
    });

    it('Task 51 (mirror): dragging the right edge before the anchor that would freeze as start clamps to that anchor, never firing onExtendToSpan with a due before it', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({ planning: { time: '13:00', duration: 60, due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], cbs);
      const handle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      (container as unknown as { __tgTestEndDrag: (date: string) => void }).__tgTestEndDrag(
        '2026-07-08',
      );
      expect(cbs.onExtendToSpan).toHaveBeenCalledWith(t, '2026-07-10');
      expect(cbs.onExtendToSpan).not.toHaveBeenCalledWith(t, '2026-07-08');
    });

    it('coexistence: all five interaction modes now living on one .tc-tg-block (left edge, right edge, vertical move, vertical resize, native whole-block drag) each fire only their own callback', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({ planning: { time: '09:00', duration: 60, due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], cbs);
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const leftHandle = block.querySelector('.tc-tg-span-edge--left') as HTMLElement;
      const rightHandle = block.querySelector('.tc-tg-span-edge--right') as HTMLElement;
      const resizeHandle = block.querySelector('.tc-tg-resize-handle') as HTMLElement;

      // Mode 5: native whole-block HTML5 drag-out — still present and independently wired.
      expect(block.getAttribute('draggable')).toBe('true');

      // Modes 1 and 2 resolve via real pointerup + a stubbed elementFromPoint (rather than the
      // __tgTestEndDrag direct-invoke seam used by the earlier tests in this describe block):
      // __tgTestEndDrag fires every CURRENTLY ARMED handle's resolver, and a real pointerup is
      // what actually disarms (cleans up + unregisters) a handle after resolving it. Since both
      // edges are exercised in this one test, going through the real pointerup path is what
      // keeps each mode's resolver from lingering armed into the next mode's __tgTestEndDrag-free
      // gesture — an artificial coupling that's a test-sequencing artifact of this single test,
      // not a real interaction happening twice.
      const leftDayEl = document.createElement('div');
      leftDayEl.setAttribute('data-tg-date', '2026-07-08');
      const rightDayEl = document.createElement('div');
      rightDayEl.setAttribute('data-tg-date', '2026-07-12');

      // Mode 1: left edge -> onStartChange only.
      activeDocument.elementFromPoint = () => leftDayEl;
      leftHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
      expect(cbs.onStartChange).toHaveBeenCalledWith(t, '2026-07-08');

      // Mode 2: right edge -> onExtendToSpan only.
      activeDocument.elementFromPoint = () => rightDayEl;
      rightHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2 }));
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 2 }));
      expect(cbs.onExtendToSpan).toHaveBeenCalledWith(t, '2026-07-12');

      // Mode 3: vertical move (block body) -> onTimeChange only.
      block.setPointerCapture = () => {};
      block.releasePointerCapture = () => {};
      block.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 3 }),
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 148, pointerId: 3 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 148, pointerId: 3 }));
      expect(cbs.onTimeChange).toHaveBeenCalledWith(t, 9 * 60 + 60);

      // Mode 4: vertical resize (bottom handle) -> onDurationChange only.
      resizeHandle.setPointerCapture = () => {};
      resizeHandle.releasePointerCapture = () => {};
      resizeHandle.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 4 }),
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 148, pointerId: 4 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 148, pointerId: 4 }));
      expect(cbs.onDurationChange).toHaveBeenCalledWith(t, 120);

      // No cross-firing across any of the four pointer-driven modes.
      expect(cbs.onStartChange).toHaveBeenCalledTimes(1);
      expect(cbs.onExtendToSpan).toHaveBeenCalledTimes(1);
      expect(cbs.onTimeChange).toHaveBeenCalledTimes(1);
      expect(cbs.onDurationChange).toHaveBeenCalledTimes(1);
    });

    it("pointerdown on the left-edge handle flips the block's own draggable to false (blocking the native-drag-ancestor-fallback), restored on pointerup", () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const handle = container.querySelector('.tc-tg-span-edge--left') as HTMLElement;

      expect(block.getAttribute('draggable')).toBe('true');
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      expect(block.getAttribute('draggable')).toBe('false');
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
      expect(block.getAttribute('draggable')).toBe('true');
    });

    it('a pointercancel mid-drag on the left-edge handle also restores draggable to true', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const handle = container.querySelector('.tc-tg-span-edge--left') as HTMLElement;

      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      expect(block.getAttribute('draggable')).toBe('false');
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
      expect(block.getAttribute('draggable')).toBe('true');
    });
  });

  describe('pointer capture: closes the "abandoned gesture" gap (draggable="false" stuck forever if pointerup/pointercancel never fires)', () => {
    // The horizontal-edge-resize handles' own pointerup resolves the day under the pointer via
    // `activeDocument.elementFromPoint`, unimplemented in jsdom — same stub this file's other
    // horizontal-edge-resize suites use.
    let originalElementFromPoint: typeof activeDocument.elementFromPoint;
    beforeEach(() => {
      originalElementFromPoint = activeDocument.elementFromPoint;
      activeDocument.elementFromPoint = () => null;
    });
    afterEach(() => {
      activeDocument.elementFromPoint = originalElementFromPoint;
    });

    // Code review gap: cleanup() — which restores block's draggable="true" — only runs from
    // onPointerUp/onPointerCancel. If NEITHER is ever delivered after a resize pointerdown (e.g.
    // the pointer is released outside the browser window entirely, or some other browser/OS
    // quirk swallows the up-event), draggable stays "false" forever, silently disabling the
    // legitimate whole-block native-drag-to-all-day feature until the block's next from-scratch
    // re-render. The spec-correct fix is Pointer Capture: `setPointerCapture` on pointerdown
    // guarantees the capturing element keeps receiving pointermove/pointerup for that pointerId
    // even once the pointer leaves the element/window — so the browser itself can no longer
    // produce the "neither pointerup nor pointercancel ever arrives" scenario for a captured
    // pointer. That guarantee is a browser/OS contract jsdom can't reproduce (there is no way to
    // dispatch a pointerdown and then truthfully withhold the up/cancel event a real capturing
    // browser would still deliver) — so these tests assert the mechanism that provides the
    // guarantee (capture is armed with the correct pointerId on pointerdown, and released once
    // the gesture ends), which is exactly what a future regression (e.g. someone removing the
    // capture call while refactoring) would break.
    it("pointerdown on the vertical resize handle arms pointer capture on the handle with the gesture's pointerId", () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const handle = container.querySelector('.tc-tg-resize-handle') as HTMLElement;
      handle.setPointerCapture = vi.fn();
      handle.releasePointerCapture = vi.fn();
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 7 }),
      );
      expect(handle.setPointerCapture).toHaveBeenCalledWith(7);
    });

    it('pointerdown on the block body (move mode) arms pointer capture on the block too (same abandoned-gesture risk exists for the plain move gesture)', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      block.setPointerCapture = vi.fn();
      block.releasePointerCapture = vi.fn();
      block.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 3 }),
      );
      expect(block.setPointerCapture).toHaveBeenCalledWith(3);
    });

    it('pointerdown on the left-edge horizontal handle arms pointer capture on that handle', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const handle = container.querySelector('.tc-tg-span-edge--left') as HTMLElement;
      handle.setPointerCapture = vi.fn();
      handle.releasePointerCapture = vi.fn();
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 5 }));
      expect(handle.setPointerCapture).toHaveBeenCalledWith(5);
    });

    it('pointerdown on the right-edge horizontal handle arms pointer capture on that handle', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const handle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;
      handle.setPointerCapture = vi.fn();
      handle.releasePointerCapture = vi.fn();
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 6 }));
      expect(handle.setPointerCapture).toHaveBeenCalledWith(6);
    });

    it('a source lacking setPointerCapture (e.g. jsdom, or any host without Pointer Events capture support) is tolerated: no throw, and the pre-existing pointerup cleanup still runs', () => {
      const container = freshContainer();
      const onDurationChange = vi.fn();
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], { ...callbacks(), onDurationChange });
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const handle = container.querySelector('.tc-tg-resize-handle') as HTMLElement;
      // Deliberately NOT stubbing setPointerCapture/releasePointerCapture here — jsdom's
      // HTMLElement has neither method at all (both are `undefined`), reproducing any real host
      // that lacks Pointer Events capture support.
      expect(() =>
        handle.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
        ),
      ).not.toThrow();
      expect(block.getAttribute('draggable')).toBe('false');
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 148, pointerId: 1 }));
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 148, pointerId: 1 }));
      expect(onDurationChange).toHaveBeenCalledWith(t, 120);
      expect(block.getAttribute('draggable')).toBe('true');
    });

    it('releasePointerCapture is called on pointerup cleanup (vertical resize) with the same pointerId that was captured', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const handle = container.querySelector('.tc-tg-resize-handle') as HTMLElement;
      handle.setPointerCapture = vi.fn();
      handle.releasePointerCapture = vi.fn();
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 9 }),
      );
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 148, pointerId: 9 }));
      expect(handle.releasePointerCapture).toHaveBeenCalledWith(9);
    });

    it('releasePointerCapture is called on pointercancel cleanup (left-edge horizontal resize) with the same pointerId that was captured', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const handle = container.querySelector('.tc-tg-span-edge--left') as HTMLElement;
      handle.setPointerCapture = vi.fn();
      handle.releasePointerCapture = vi.fn();
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 11 }));
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 11 }));
      expect(handle.releasePointerCapture).toHaveBeenCalledWith(11);
    });
  });

  describe('renderTimedSpanContinuation (Task 29: non-anchor days of a multi-day timed span)', () => {
    it('renders a continuation segment positioned at the same time-of-day row as a full block would be', () => {
      const container = freshContainer();
      const t = task({
        planning: { time: '15:00', duration: 90, start: '2026-07-01', due: '2026-07-03' },
      });
      renderTimedSpanContinuation(container, [t]);
      const seg = container.querySelector('.tc-tg-block-continuation') as HTMLElement;
      expect(seg).not.toBeNull();
      expect(seg.style.top).toBe(`${((15 * 60) / 60) * 48}px`);
      expect(seg.style.height).toBe(`${(90 / 60) * 48}px`);
    });

    it('is not draggable and carries no resize handles (non-interactive continuation, not a duplicate full block)', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', start: '2026-07-01', due: '2026-07-03' } });
      renderTimedSpanContinuation(container, [t]);
      const seg = container.querySelector('.tc-tg-block-continuation') as HTMLElement;
      expect(seg.getAttribute('draggable')).not.toBe('true');
      expect(seg.querySelector('.tc-tg-resize-handle')).toBeNull();
      expect(seg.querySelector('.tc-tg-span-edge')).toBeNull();
    });

    it('shows the task title so the continuation reads as clearly linked to the anchor block, not an unrelated duplicate task', () => {
      const container = freshContainer();
      const t = task({
        title: 'Conference',
        planning: { time: '09:00', start: '2026-07-01', due: '2026-07-03' },
      });
      renderTimedSpanContinuation(container, [t]);
      const seg = container.querySelector('.tc-tg-block-continuation') as HTMLElement;
      expect(seg.textContent).toContain('Conference');
    });

    it('renders the same inert human-readable ghost title as the all-day and month continuations', () => {
      const container = freshContainer();
      const t = taskFromCodecLine(
        '- [ ] Conference at [[Note]] with **bold**, ~~old~~ and `code` [site](https://example.test) 🛫 2026-07-01 📅 2026-07-03 ⏰ 09:00',
      );
      expect(t.title).toBe('Conference at 🔗 Note with **bold**, ~~old~~ and `code` 🌐 site');

      renderTimedSpanContinuation(container, [t]);

      const title = container.querySelector('.tc-tg-block-continuation-title');
      expect(title?.textContent).toBe('Conference at 🔗 Note with bold, old and code 🌐 site');
      expect(title?.querySelector('.tc-md')).toBeNull();
      expect(title?.querySelector('a')).toBeNull();
      expect(title?.textContent).not.toMatch(/\*\*|~~|`|\[\[/u);
    });

    it('preserves escaped emphasis markers as literal title characters', () => {
      const container = freshContainer();
      const t = taskFromCodecLine(
        String.raw`- [ ] Keep \*literal\* and \_literal\_ with **bold** 🛫 2026-07-01 📅 2026-07-03 ⏰ 09:00`,
      );

      renderTimedSpanContinuation(container, [t]);

      expect(container.querySelector('.tc-tg-block-continuation-title')?.textContent).toBe(
        'Keep *literal* and _literal_ with bold',
      );
    });

    it('a right-click fires onTaskClick, same as a full block', () => {
      const container = freshContainer();
      const onTaskClick = vi.fn();
      const t = task({ planning: { time: '09:00', start: '2026-07-01', due: '2026-07-03' } });
      renderTimedSpanContinuation(container, [t], onTaskClick);
      const seg = container.querySelector('.tc-tg-block-continuation') as HTMLElement;
      seg.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      expect(onTaskClick).toHaveBeenCalledWith(t);
    });

    it('renders one continuation segment per task, in tag color when a tag matches', () => {
      const container = freshContainer();
      const t = task({
        tags: ['#work'],
        planning: { time: '09:00', start: '2026-07-01', due: '2026-07-03' },
        source: { originalMarkdown: '- [ ] t #work', originalBlock: '- [ ] t #work' },
      });
      renderTimedSpanContinuation(container, [t], undefined, [
        { id: '1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#3498db' },
      ]);
      const seg = container.querySelector('.tc-tg-block-continuation') as HTMLElement;
      expect(seg.style.getPropertyValue('--tc-tag-color')).toBe('#3498db');
    });

    // Task 35 (expanded scope): continuation segments gain the same time/duration subtitle and
    // count badges the anchor block shows, but must stay just as non-interactive as before.
    it("shows the time range + duration subtitle, matching the anchor block's format", () => {
      const container = freshContainer();
      const t = task({
        planning: { time: '15:00', duration: 90, start: '2026-07-01', due: '2026-07-03' },
      });
      renderTimedSpanContinuation(container, [t]);
      const seg = container.querySelector('.tc-tg-block-continuation') as HTMLElement;
      const subtitle = seg.querySelector('.tc-tg-block-subtitle') as HTMLElement;
      expect(subtitle).not.toBeNull();
      expect(subtitle.textContent).toBe('15:00–16:30 (1h30m)');
    });

    it('renders count badges in a .tc-tg-block-badges container when the task has subtasks/comments/links, and never a tag chip', () => {
      const container = freshContainer();
      const t = task({
        tags: ['#work'],
        planning: { time: '09:00', start: '2026-07-01', due: '2026-07-03' },
        source: { originalMarkdown: '- [ ] t #work', originalBlock: '- [ ] t #work' },
        presentation: { linkCount: 1 },
      });
      renderTimedSpanContinuation(container, [t], undefined, [
        { id: '1', name: 'Work', mode: 'prefix', prefix: 'work', color: '#3498db' },
      ]);
      const seg = container.querySelector('.tc-tg-block-continuation') as HTMLElement;
      const badges = seg.querySelector('.tc-tg-block-badges') as HTMLElement;
      expect(badges).not.toBeNull();
      expect(badges.querySelectorAll('.tc-task-count-badge')).toHaveLength(1);
      expect(seg.querySelector('.tc-task-tag')).toBeNull();
    });

    it('omits .tc-tg-block-badges entirely for a continuation task with no subtasks/comments/links', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', start: '2026-07-01', due: '2026-07-03' } });
      renderTimedSpanContinuation(container, [t]);
      const seg = container.querySelector('.tc-tg-block-continuation') as HTMLElement;
      expect(seg.querySelector('.tc-tg-block-badges')).toBeNull();
    });

    it('still has no checkbox/status marker and no draggable/resize/pointer-driven interactivity now that the subtitle and badges were added (regression: must stay non-interactive)', () => {
      const container = freshContainer();
      const t = task({
        comments: [taskComment({ text: 'note' })],
        planning: { time: '09:00', duration: 60, start: '2026-07-01', due: '2026-07-03' },
      });
      renderTimedSpanContinuation(container, [t]);
      const seg = container.querySelector('.tc-tg-block-continuation') as HTMLElement;
      expect(seg.querySelector('.tc-status-marker')).toBeNull();
      expect(seg.getAttribute('draggable')).not.toBe('true');
      expect(seg.querySelector('.tc-tg-resize-handle')).toBeNull();
      expect(seg.querySelector('.tc-tg-span-edge')).toBeNull();
      // A pointer gesture across the segment must not throw or move anything — there is no
      // move/resize wiring at all on a continuation segment (unlike the anchor block).
      expect(() => {
        seg.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
        );
        window.dispatchEvent(new PointerEvent('pointermove', { clientY: 148, pointerId: 1 }));
        window.dispatchEvent(new PointerEvent('pointerup', { clientY: 148, pointerId: 1 }));
      }).not.toThrow();
    });
  });

  describe('Task 36: minimum block size so very-short-duration text never becomes invisible', () => {
    it('.tc-tg-block declares a min-height', () => {
      expect(declarationsFor('.tc-tg-block')).toMatch(/min-height\s*:/u);
    });

    it('.tc-tg-block-continuation declares a min-height', () => {
      expect(declarationsFor('.tc-tg-block-continuation')).toMatch(/min-height\s*:/u);
    });

    it("the subtitle/badges row (.tc-tg-block-toprow) is the one that shrinks/collapses under pressure — the checkbox+title row (.tc-tg-block-head) doesn't", () => {
      expect(declarationsFor('.tc-tg-block-toprow')).toMatch(/flex-shrink\s*:\s*1/u);
      expect(declarationsFor('.tc-tg-block-head')).toMatch(/flex-shrink\s*:\s*0/u);
    });

    it('a 10-minute task does not get an explicit inline min-height override when nothing follows it in its column (the CSS rule alone is enough)', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', duration: 10 } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      expect(block.style.height).toBe(`${(10 / 60) * 48}px`);
      expect(block.style.minHeight).toBe('');
    });

    it('two 10-minute tasks scheduled back-to-back (09:00-09:10, 09:10-09:20): the earlier block gets an inline min-height clamped to the real gap, so growing to legibly show its title cannot visually cross into the next block', () => {
      const container = freshContainer();
      const a = task({
        title: 'A',
        planning: { time: '09:00', duration: 10 },
        source: { line: 0 },
      });
      const b = task({
        title: 'B',
        planning: { time: '09:10', duration: 10 },
        source: { line: 1 },
      });
      renderTimedBlocksForDay(container, [a, b], callbacks());
      const blocks = Array.from(container.querySelectorAll<HTMLElement>('.tc-tg-block'));
      expect(blocks).toHaveLength(2);
      const [blockA, blockB] = blocks;
      const topA = parseFloat(blockA!.style.top);
      const topB = parseFloat(blockB!.style.top);
      // Without the fix, .tc-tg-block's CSS min-height (~24.5px) would grow block A well past
      // block B's top (8px further down) — an inline min-height clamp is required here.
      expect(blockA!.style.minHeight).not.toBe('');
      const clampedHeight = parseFloat(blockA!.style.minHeight);
      // The clamped height must never place block A's bottom edge below block B's top edge.
      expect(topA + clampedHeight).toBeLessThanOrEqual(topB);
    });

    it('two tasks with a generous gap (09:00-09:10, then 11:00) get no inline min-height override — the CSS rule has plenty of room', () => {
      const container = freshContainer();
      const a = task({ planning: { time: '09:00', duration: 10 }, source: { line: 0 } });
      const b = task({ planning: { time: '11:00', duration: 60 }, source: { line: 1 } });
      renderTimedBlocksForDay(container, [a, b], callbacks());
      const blocks = Array.from(container.querySelectorAll<HTMLElement>('.tc-tg-block'));
      expect(blocks[0]!.style.minHeight).toBe('');
    });
  });

  // Task 37: renderTimedSpanContinuation renders `.tc-tg-block-continuation` segments, which got
  // the same CSS min-height rule `.tc-tg-block` has (Task 36) but — unlike anchor blocks — never
  // went through any collision-avoidance pass, since continuation segments don't participate in
  // `packOverlaps`'s column packing at all (they're always rendered full-width). These tests mirror
  // the anchor-block "two back-to-back short blocks"/"generous gap"/"lone block" suite above,
  // proving continuation segments now get the same guarantee.
  describe('Task 37: continuation segments get the same min-height collision clamp as anchor blocks', () => {
    it('a 10-minute continuation does not get an explicit inline min-height override when nothing follows it (the CSS rule alone is enough)', () => {
      const container = freshContainer();
      const t = task({
        planning: { time: '09:00', duration: 10, start: '2026-07-01', due: '2026-07-03' },
      });
      renderTimedSpanContinuation(container, [t]);
      const seg = container.querySelector('.tc-tg-block-continuation') as HTMLElement;
      expect(seg.style.height).toBe(`${(10 / 60) * 48}px`);
      expect(seg.style.minHeight).toBe('');
    });

    it('two 10-minute continuation segments scheduled back-to-back (09:00-09:10, 09:10-09:20): the earlier one gets an inline min-height clamped to the real gap, so it cannot visually cross into the next one', () => {
      const container = freshContainer();
      const a = task({
        title: 'A',
        planning: { time: '09:00', duration: 10, start: '2026-07-01', due: '2026-07-03' },
        source: { line: 0 },
      });
      const b = task({
        title: 'B',
        planning: { time: '09:10', duration: 10, start: '2026-07-01', due: '2026-07-04' },
        source: { line: 1 },
      });
      renderTimedSpanContinuation(container, [a, b]);
      const segs = Array.from(container.querySelectorAll<HTMLElement>('.tc-tg-block-continuation'));
      expect(segs).toHaveLength(2);
      const [segA, segB] = segs;
      const topA = parseFloat(segA!.style.top);
      const topB = parseFloat(segB!.style.top);
      expect(segA!.style.minHeight).not.toBe('');
      const clampedHeight = parseFloat(segA!.style.minHeight);
      // The geometric invariant capMinHeightsPx already guarantees for anchor blocks: the
      // clamped segment's bottom edge must never cross the next segment's top edge.
      expect(topA + clampedHeight).toBeLessThanOrEqual(topB);
    });

    it('two continuation segments with a generous gap (09:00-09:10, then 11:00) get no inline min-height override', () => {
      const container = freshContainer();
      const a = task({
        planning: { time: '09:00', duration: 10, start: '2026-07-01', due: '2026-07-03' },
        source: { line: 0 },
      });
      const b = task({
        planning: { time: '11:00', duration: 60, start: '2026-07-01', due: '2026-07-04' },
        source: { line: 1 },
      });
      renderTimedSpanContinuation(container, [a, b]);
      const segs = Array.from(container.querySelectorAll<HTMLElement>('.tc-tg-block-continuation'));
      expect(segs[0]!.style.minHeight).toBe('');
    });

    it('a short continuation segment immediately followed by an anchor block in the same day column is capped against the anchor block, not left to grow past its top', () => {
      const container = freshContainer();
      const continuationTask = task({
        title: 'Continuation',
        planning: { time: '09:00', duration: 10, start: '2026-07-01', due: '2026-07-03' },
        source: { line: 0 },
      });
      const anchorTask = task({
        title: 'Anchor',
        planning: { time: '09:10', duration: 60 },
        source: { line: 1 },
      });
      const anchorInputs = toTimedBlockInputs([anchorTask]);
      renderTimedSpanContinuation(container, [continuationTask], undefined, [], anchorInputs);
      const seg = container.querySelector('.tc-tg-block-continuation') as HTMLElement;
      const topSeg = parseFloat(seg.style.top);
      expect(seg.style.minHeight).not.toBe('');
      const clampedHeight = parseFloat(seg.style.minHeight);
      // The anchor block itself is not rendered by renderTimedSpanContinuation, but its start
      // time (09:10, i.e. minutesToPixels(9*60+10)) is the boundary the continuation must not
      // cross into.
      const anchorTopPx = ((9 * 60 + 10) / 60) * 48;
      expect(topSeg + clampedHeight).toBeLessThanOrEqual(anchorTopPx);
    });
  });
});
