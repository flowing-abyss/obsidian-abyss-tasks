import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Component, type App } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { StatusRegistry } from '../src/status/StatusRegistry';
import { MIN_BLOCK_HEIGHT_PX } from '../src/views/timegrid/layout';
import {
  renderTimedBlocksForDay,
  renderTimedSpanContinuation,
  toTimedBlockInputs,
} from '../src/views/timegrid/renderTimedBlocks';
import {
  attachTimedInteractions,
  createTimedInteractionOwner,
} from '../src/views/timegrid/timedInteractions';
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

function declarationsForRuleContaining(...selectors: string[]): string {
  for (const match of css.matchAll(/([^{}]+)\{([^}]*)\}/gu)) {
    if (selectors.every((selector) => (match[1] ?? '').includes(selector))) return match[2] ?? '';
  }
  return '';
}

function expectInertPreview(preview: HTMLElement, title: string): void {
  expect(preview.getAttribute('aria-hidden')).toBe('true');
  expect(preview.textContent).toContain(title);
  expect(preview.classList.contains('tc-calendar-preview')).toBe(true);
  expect(preview.querySelector(':scope > .tc-calendar-preview-target-outline')?.textContent).toBe(
    '',
  );
  expect(
    preview.querySelector(':scope > .tc-calendar-preview-shell .tc-calendar-preview-title')
      ?.textContent,
  ).toBe(title);
  expect(preview.querySelector('.tc-status-marker')).toBeNull();
  expect(preview.querySelector('a')).toBeNull();
  expect(preview.getAttribute('tabindex')).toBeNull();
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

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function timedGestureGrid() {
  const root = freshContainer().createDiv({ cls: 'tc-tg-root' });
  const allDayRow = root.createDiv({ cls: 'tc-tg-allday-row' });
  const gridRow = root.createDiv({ cls: 'tc-tg-grid-row' });
  const owner = createTimedInteractionOwner();
  const dates = ['2026-07-06', '2026-07-07', '2026-07-08'] as const;
  type GestureColumn = {
    date: string;
    allDay: HTMLElement;
    day: HTMLElement;
    hour: HTMLElement;
  };
  const columns = dates.map((date, index) => {
    const allDay = allDayRow.createDiv({ cls: 'tc-tg-allday-cell' });
    allDay.dataset['tgDate'] = date;
    allDay.getBoundingClientRect = () => rect(index * 100, 10, 100, 30);
    const day = gridRow.createDiv({ cls: 'tc-tg-day-column' });
    day.dataset['tgDate'] = date;
    day.getBoundingClientRect = () => rect(index * 100, 100, 100, 24 * 48);
    const hour = day.createDiv({ cls: 'tc-tg-hour-column' });
    hour.getBoundingClientRect = () => rect(index * 100, 100, 100, 24 * 48);
    return { date, allDay, day, hour };
  }) as unknown as [GestureColumn, GestureColumn, GestureColumn];
  return { root, owner, columns };
}

describe('Task 2 unified timed interaction contract', () => {
  it('uses committed event-fill contrast for terminal and ghost timed blocks', () => {
    const originalBackground = document.body.style.getPropertyValue('--background-primary');
    document.body.style.setProperty('--background-primary', '#666666');
    const tagGroups = [
      { id: 'work', name: 'Work', mode: 'prefix' as const, prefix: 'work', color: '#fff' },
    ];
    const spanTask = task({
      tags: ['#work'],
      planning: { start: '2026-07-06', due: '2026-07-08', time: '09:00', duration: 60 },
    });

    try {
      const terminalContainer = freshContainer();
      renderTimedBlocksForDay(terminalContainer, [spanTask], callbacks(), tagGroups, {
        date: '2026-07-08',
        terminal: true,
      });
      const ghostContainer = freshContainer();
      renderTimedBlocksForDay(ghostContainer, [spanTask], callbacks(), tagGroups, {
        date: '2026-07-07',
        terminal: false,
      });
      const legacyGhostContainer = freshContainer();
      renderTimedSpanContinuation(legacyGhostContainer, [spanTask], undefined, tagGroups);

      expect(
        (terminalContainer.querySelector('.tc-tg-block') as HTMLElement).style.getPropertyValue(
          '--tc-tag-text-color',
        ),
      ).toBe('var(--tc-tag-text-dark)');
      expect(
        (ghostContainer.querySelector('.tc-tg-block') as HTMLElement).style.getPropertyValue(
          '--tc-tag-text-color',
        ),
      ).toBe('var(--tc-tag-text-dark)');
      expect(
        (
          legacyGhostContainer.querySelector('.tc-tg-block-continuation') as HTMLElement
        ).style.getPropertyValue('--tc-tag-text-color'),
      ).toBe('var(--tc-tag-text-dark)');
    } finally {
      document.body.style.setProperty('--background-primary', originalBackground);
    }
  });

  it.each([
    { name: 'terminal', terminal: true },
    { name: 'ghost', terminal: false },
  ])(
    'keeps a stationary visible-body click on a 5-minute $name segment inert and preserves its moved visual offset',
    ({ terminal }) => {
      const { root, owner, columns } = timedGestureGrid();
      const onTimedMove = vi.fn();
      const t = task({
        planning: terminal
          ? { due: '2026-07-06', time: '09:00', duration: 5 }
          : { start: '2026-07-06', due: '2026-07-08', time: '09:00', duration: 5 },
      });
      renderTimedBlocksForDay(
        columns[0].hour,
        [t],
        { ...callbacks(), onTimedMove, interactionOwner: owner },
        [],
        { date: '2026-07-06', terminal },
      );
      const block = columns[0].hour.querySelector('.tc-tg-block') as HTMLElement;
      const visualTop = 9 * 48 + 100;
      const bodyOffsetPx = 14;
      expect(bodyOffsetPx).toBeLessThan(MIN_BLOCK_HEIGHT_PX - 6);
      block.getBoundingClientRect = () => rect(0, visualTop, 100, MIN_BLOCK_HEIGHT_PX);

      block.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: 25,
          clientY: visualTop + bodyOffsetPx,
          pointerId: 31,
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointerup', {
          clientX: 25,
          clientY: visualTop + bodyOffsetPx,
          pointerId: 31,
        }),
      );
      expect(root.querySelector('.tc-tg-drag-preview')).toBeNull();
      expect(onTimedMove).not.toHaveBeenCalled();

      block.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: 25,
          clientY: visualTop + bodyOffsetPx,
          pointerId: 32,
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 25,
          clientY: visualTop + bodyOffsetPx + 48,
          pointerId: 32,
        }),
      );
      const preview = columns[0].hour.querySelector('.tc-tg-drag-preview') as HTMLElement;
      const target = JSON.parse(preview.dataset['target'] ?? '{}') as { startMinutes?: number };
      expect(target.startMinutes).toBe(600);
      expect(preview.style.top).toBe('480px');
      expect(visualTop + bodyOffsetPx + 48 - (100 + Number.parseFloat(preview.style.top))).toBe(
        bodyOffsetPx,
      );
      window.dispatchEvent(
        new PointerEvent('pointerup', {
          clientX: 25,
          clientY: visualTop + bodyOffsetPx + 48,
          pointerId: 32,
        }),
      );
      expect(onTimedMove).toHaveBeenCalledOnce();
      expect(onTimedMove).toHaveBeenCalledWith(
        t,
        expect.objectContaining({ startMinutes: 600, dayDelta: 0 }),
      );
    },
  );

  it('commits duration from a ghost bottom handle through the owned DOM path', () => {
    const { owner, columns } = timedGestureGrid();
    const onTimedDuration = vi.fn();
    const t = task({
      planning: { start: '2026-07-06', due: '2026-07-08', time: '09:00', duration: 5 },
    });
    renderTimedBlocksForDay(
      columns[1].hour,
      [t],
      { ...callbacks(), onTimedDuration, interactionOwner: owner },
      [],
      { date: '2026-07-07', terminal: false },
    );
    const ghost = columns[1].hour.querySelector('.tc-tg-block') as HTMLElement;
    const handle = ghost.querySelector('.tc-tg-resize-handle') as HTMLElement;
    ghost.getBoundingClientRect = () => rect(100, 9 * 48 + 100, 100, MIN_BLOCK_HEIGHT_PX);

    handle.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 150, clientY: 556, pointerId: 33 }),
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 150, clientY: 568, pointerId: 33 }),
    );
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 150, clientY: 568, pointerId: 33 }),
    );

    expect(onTimedDuration).toHaveBeenCalledOnce();
    expect(onTimedDuration).toHaveBeenCalledWith(t, {
      edge: 'end',
      startMinutes: 540,
      durationMinutes: 20,
      endMinutes: 560,
    });
  });

  it.each([
    {
      name: 'ghost start',
      planning: { start: '2026-07-06', due: '2026-07-08', time: '09:00', duration: 5 },
      terminal: false,
      selector: '[data-boundary="start"]',
      expected: { boundary: 'start', date: '2026-07-07', dayDelta: 1 },
    },
    {
      name: 'terminal create-span',
      planning: { due: '2026-07-06', time: '09:00', duration: 5 },
      terminal: true,
      selector: '[data-boundary="create-span"]',
      expected: { boundary: 'create-span', date: '2026-07-07', dayDelta: 1 },
    },
  ])(
    'commits the $name boundary through the owned DOM path',
    ({ planning, terminal, selector, expected }) => {
      const { owner, columns } = timedGestureGrid();
      const onTimedBoundary = vi.fn();
      const t = task({ planning });
      renderTimedBlocksForDay(
        columns[0].hour,
        [t],
        { ...callbacks(), onTimedBoundary, interactionOwner: owner },
        [],
        { date: '2026-07-06', terminal },
      );
      const block = columns[0].hour.querySelector('.tc-tg-block') as HTMLElement;
      const handle = block.querySelector(selector) as HTMLElement;
      block.getBoundingClientRect = () => rect(0, 9 * 48 + 100, 100, MIN_BLOCK_HEIGHT_PX);

      handle.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: 50,
          clientY: 544,
          pointerId: 34,
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 150, clientY: 544, pointerId: 34 }),
      );
      window.dispatchEvent(
        new PointerEvent('pointerup', { clientX: 150, clientY: 544, pointerId: 34 }),
      );

      expect(onTimedBoundary).toHaveBeenCalledOnce();
      expect(onTimedBoundary).toHaveBeenCalledWith(t, expected);
    },
  );

  it.each([
    { duration: 5, terminal: true },
    { duration: 15, terminal: false },
  ])(
    'keeps the full visible $duration-minute $terminal segment draggable and previews its rendered height',
    ({ duration, terminal }) => {
      const { owner, columns } = timedGestureGrid();
      const onTimedMove = vi.fn();
      const t = task({
        planning: terminal
          ? { due: '2026-07-06', time: '09:00', duration }
          : {
              start: '2026-07-06',
              due: '2026-07-08',
              time: '09:00',
              duration,
            },
      });
      renderTimedBlocksForDay(
        columns[0].hour,
        [t],
        { ...callbacks(), onTimedMove, interactionOwner: owner },
        [],
        { date: '2026-07-06', terminal },
      );
      const block = columns[0].hour.querySelector('.tc-tg-block') as HTMLElement;
      const visualTop = 9 * 48 + 100;
      block.getBoundingClientRect = () => rect(0, visualTop, 100, MIN_BLOCK_HEIGHT_PX);

      block.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: 25,
          clientY: visualTop + MIN_BLOCK_HEIGHT_PX - 1,
          pointerId: 21,
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 125, clientY: 592, pointerId: 21 }),
      );

      const preview = columns[1].hour.querySelector('.tc-tg-drag-preview') as HTMLElement;
      expect(preview).not.toBeNull();
      expect(preview.style.height).toBe(`${MIN_BLOCK_HEIGHT_PX}px`);
      window.dispatchEvent(
        new PointerEvent('pointerup', { clientX: 125, clientY: 592, pointerId: 21 }),
      );
      expect(onTimedMove).toHaveBeenCalledOnce();

      const durationHandle = block.querySelector('.tc-tg-resize-handle') as HTMLElement;
      durationHandle.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: 50,
          clientY: visualTop + MIN_BLOCK_HEIGHT_PX,
          pointerId: 24,
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 50,
          clientY: visualTop + MIN_BLOCK_HEIGHT_PX + 12,
          pointerId: 24,
        }),
      );
      const durationPreview = columns[0].hour.querySelector('.tc-tg-drag-preview') as HTMLElement;
      expect(durationPreview.style.height).toBe(`${MIN_BLOCK_HEIGHT_PX}px`);
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 24 }));

      const boundaryHandle = block.querySelector(
        terminal ? '[data-boundary="create-span"]' : '[data-boundary="start"]',
      ) as HTMLElement;
      boundaryHandle.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          clientX: 50,
          clientY: visualTop + MIN_BLOCK_HEIGHT_PX / 2,
          pointerId: 25,
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 125, clientY: visualTop, pointerId: 25 }),
      );
      const boundaryPreview = columns[1].hour.querySelector(
        '.tc-tg-boundary-preview',
      ) as HTMLElement;
      expect(boundaryPreview.style.height).toBe(`${MIN_BLOCK_HEIGHT_PX}px`);
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 25 }));
    },
  );

  it('renders an overlapping second-lane all-day preview across the full destination cell', () => {
    const { owner, columns } = timedGestureGrid();
    const first = task({
      source: { filePath: 'first.md', line: 0 },
      planning: { due: '2026-07-06', time: '09:00', duration: 60 },
    });
    const second = task({
      source: { filePath: 'second.md', line: 0 },
      planning: { due: '2026-07-06', time: '09:15', duration: 60 },
    });
    renderTimedBlocksForDay(
      columns[0].hour,
      [first, second],
      { ...callbacks(), interactionOwner: owner },
      [],
      { date: '2026-07-06' },
    );
    const secondLane = columns[0].hour.querySelector<HTMLElement>(
      '.tc-tg-block[data-tc-task-file="second.md"]',
    );
    if (!secondLane) throw new Error('missing overlapping second lane');
    expect(secondLane.style.left).toBe('50%');
    expect(secondLane.style.width).toBe('50%');
    secondLane.getBoundingClientRect = () => rect(50, 9.25 * 48 + 100, 50, 48);

    secondLane.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 75, clientY: 556, pointerId: 22 }),
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 125, clientY: 25, pointerId: 22 }),
    );

    const preview = columns[1].allDay.querySelector('.tc-tg-drag-preview') as HTMLElement;
    expect(preview.style.left).toBe('');
    expect(preview.style.width).toBe('');
    expect(declarationsFor('.tc-tg-drag-preview.is-all-day')).toMatch(/width\s*:\s*100%/u);
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 22 }));
  });

  it('focuses and selects a block when its body starts a pointer gesture', () => {
    const { root, owner, columns } = timedGestureGrid();
    activeDocument.body.append(root);
    const cbs = callbacks();
    const t = task({ planning: { due: '2026-07-06', time: '09:00', duration: 60 } });
    renderTimedBlocksForDay(columns[0].hour, [t], { ...cbs, interactionOwner: owner }, [], {
      date: '2026-07-06',
    });
    const block = columns[0].hour.querySelector('.tc-tg-block') as HTMLElement;
    block.getBoundingClientRect = () => rect(0, 9 * 48 + 100, 100, 48);

    block.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 25, clientY: 544, pointerId: 23 }),
    );
    expect(block.ownerDocument.activeElement).toBe(block);
    expect(block.classList.contains('is-selected')).toBe(true);
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 25, clientY: 544, pointerId: 23 }),
    );
    block.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(cbs.onKeyboardIntent).toHaveBeenCalledWith(t, {
      type: 'move-time',
      deltaMinutes: 15,
    });
    root.remove();
  });

  it('binds session listeners to source.ownerDocument.defaultView, not the global window', () => {
    const iframe = activeDocument.createElement('iframe');
    activeDocument.body.append(iframe);
    const foreignDocument = iframe.contentDocument;
    const foreignWindow = iframe.contentWindow;
    if (!foreignDocument || !foreignWindow) throw new Error('missing iframe realm');
    const root = foreignDocument.createElement('div');
    root.className = 'tc-tg-root';
    const allDay = foreignDocument.createElement('div');
    allDay.className = 'tc-tg-allday-cell';
    allDay.dataset['tgDate'] = '2026-07-06';
    allDay.getBoundingClientRect = () => rect(0, 10, 100, 30);
    const day = foreignDocument.createElement('div');
    day.className = 'tc-tg-day-column';
    day.dataset['tgDate'] = '2026-07-06';
    day.getBoundingClientRect = () => rect(0, 100, 100, 24 * 48);
    const hour = foreignDocument.createElement('div');
    hour.className = 'tc-tg-hour-column';
    hour.getBoundingClientRect = () => rect(0, 100, 100, 24 * 48);
    const source = foreignDocument.createElement('div');
    source.className = 'tc-tg-block';
    source.style.top = '432px';
    source.style.height = '48px';
    source.style.left = '0%';
    source.style.width = '100%';
    source.getBoundingClientRect = () => rect(0, 532, 100, 48);
    const durationHandle = foreignDocument.createElement('div');
    const startHandle = foreignDocument.createElement('div');
    source.append(durationHandle, startHandle);
    hour.append(source);
    day.append(hour);
    root.append(allDay, day);
    foreignDocument.body.append(root);
    const onMove = vi.fn();
    attachTimedInteractions({
      source,
      startHandle,
      durationHandle,
      boundaryHandles: [],
      task: task({ planning: { due: '2026-07-06', time: '09:00', duration: 60 } }),
      segmentDate: '2026-07-06',
      startMinutes: 540,
      durationMinutes: 60,
      owner: createTimedInteractionOwner(),
      onMove,
      onDuration: vi.fn(),
      onBoundary: vi.fn(),
    });

    source.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 25, clientY: 544, pointerId: 9 }),
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 25, clientY: 592, pointerId: 9 }),
    );
    expect(foreignDocument.querySelector('.tc-tg-drag-preview')).toBeNull();
    foreignWindow.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 25, clientY: 592, pointerId: 9 }),
    );
    expect(foreignDocument.querySelector('.tc-tg-drag-preview')).not.toBeNull();
    foreignWindow.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 25, clientY: 592, pointerId: 9 }),
    );
    expect(onMove).toHaveBeenCalledOnce();
    iframe.remove();
  });

  it('styles exact previews as a shared event shell plus a separate dashed target outline', () => {
    for (const selector of ['.tc-tg-drag-preview', '.tc-tg-boundary-preview']) {
      const declarations = declarationsFor(selector);
      expect(declarations).toMatch(/position\s*:\s*absolute/u);
      expect(declarations).toMatch(/pointer-events\s*:\s*none/u);
      expect(declarations).not.toMatch(/(?:border|background)\s*:/u);
    }
    const shell = declarationsFor(
      ".tc-calendar-preview[data-density='regular'] > .tc-calendar-preview-shell",
    );
    expect(shell).toMatch(/border-radius\s*:\s*var\(--tc-calendar-item-radius\)/u);
    expect(shell).toMatch(/font-size\s*:\s*var\(--tc-calendar-item-font-size\)/u);
    expect(shell).toMatch(/padding\s*:\s*2px var\(--tc-calendar-item-pad-inline\)/u);
    expect(shell).toMatch(/--tc-event-fill-strength/u);
    expect(declarationsFor('.tc-calendar-preview-title')).toMatch(/font-size\s*:\s*inherit/u);
    expect(css).toMatch(
      /(?:^|\})\s*\.tc-calendar-preview-subtitle,\s*\.tc-calendar-preview-time\s*\{[^}]*font-size\s*:\s*0\.9em/u,
    );
    expect(
      declarationsFor(".tc-calendar-preview[data-phase='terminal'] > .tc-calendar-preview-shell"),
    ).toMatch(
      /border-inline-start\s*:\s*var\(--tc-calendar-item-rail\) solid\s+var\(--tc-tag-color,\s*var\(--interactive-accent\)\)/u,
    );
    expect(
      declarationsFor(".tc-calendar-preview[data-phase='ghost'] > .tc-calendar-preview-shell"),
    ).toMatch(
      /border-inline-start\s*:\s*var\(--tc-calendar-ghost-rail\) dashed\s+var\(--tc-tag-color,\s*var\(--interactive-accent\)\)/u,
    );
    expect(declarationsFor('.tc-calendar-preview-target-outline')).toMatch(
      /outline\s*:\s*2px dashed[\s\S]*--tc-preview-border-tag-strength/u,
    );
    expect(declarationsFor('.tc-tg-day-column.is-drag-over')).toBe('');
    expect(declarationsFor('.tc-tg-block-continuation')).not.toMatch(/opacity\s*:/u);
  });

  it('keeps a cross-day source stationary and commits the same frozen target rendered by preview', () => {
    const { owner, columns } = timedGestureGrid();
    const onTimedMove = vi.fn();
    const t = task({
      planning: { start: '2026-07-06', due: '2026-07-08', time: '09:00', duration: 60 },
    });
    renderTimedBlocksForDay(
      columns[0].hour,
      [t],
      { ...callbacks(), onTimedMove, interactionOwner: owner },
      [],
      { date: '2026-07-06', terminal: false },
    );
    const block = columns[0].hour.querySelector('.tc-tg-block') as HTMLElement;
    block.getBoundingClientRect = () => rect(0, 9 * 48 + 100, 100, 48);
    block.style.setProperty('--tc-tag-color', '#123456');
    block.style.setProperty('--tc-tag-text-color', '#fefefe');
    const originalTop = block.style.top;
    const originalHeight = block.style.height;

    block.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 25, clientY: 544, pointerId: 1 }),
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 125, clientY: 592, pointerId: 1 }),
    );

    const preview = columns[1].hour.querySelector('.tc-tg-drag-preview') as HTMLElement;
    expect(preview).not.toBeNull();
    expectInertPreview(preview, t.title);
    expect(preview.style.getPropertyValue('--tc-tag-color')).toBe('#123456');
    expect(preview.style.getPropertyValue('--tc-tag-text-color')).toBe('#fefefe');
    expect(preview.style.top).toBe('480px');
    expect(preview.style.height).toBe('48px');
    expect(block.style.top).toBe(originalTop);
    expect(block.style.height).toBe(originalHeight);

    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 125, clientY: 592, pointerId: 1 }),
    );
    expect(onTimedMove).toHaveBeenCalledOnce();
    const [, target] = onTimedMove.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(target).toEqual({
      date: '2026-07-07',
      startMinutes: 600,
      dayDelta: 1,
      destination: 'time-grid',
    });
    expect(Object.isFrozen(target)).toBe(true);
    expect(preview.dataset['target']).toBe(JSON.stringify(target));
    expect(preview.isConnected).toBe(false);
  });

  it('moves to all-day by the delta from the grabbed visible ghost date', () => {
    const { owner, columns } = timedGestureGrid();
    const onTimedMove = vi.fn();
    const t = task({
      planning: { start: '2026-07-06', due: '2026-07-08', time: '09:00', duration: 60 },
    });
    renderTimedBlocksForDay(
      columns[1].hour,
      [t],
      { ...callbacks(), onTimedMove, interactionOwner: owner },
      [],
      { date: '2026-07-07', terminal: false },
    );
    const ghost = columns[1].hour.querySelector('.tc-tg-block') as HTMLElement;
    ghost.getBoundingClientRect = () => rect(100, 9 * 48 + 100, 100, 48);
    ghost.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 125, clientY: 544, pointerId: 2 }),
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 225, clientY: 25, pointerId: 2 }),
    );
    expect(columns[2].allDay.querySelector('.tc-tg-drag-preview')).not.toBeNull();
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 225, clientY: 25, pointerId: 2 }),
    );
    expect(onTimedMove).toHaveBeenCalledWith(
      t,
      expect.objectContaining({ destination: 'all-day', date: '2026-07-08', dayDelta: 1 }),
    );
  });

  it('uses a separate exact preview for bottom duration resize without changing source height', () => {
    const { owner, columns } = timedGestureGrid();
    const onTimedDuration = vi.fn();
    const t = task({ planning: { due: '2026-07-06', time: '09:00', duration: 60 } });
    renderTimedBlocksForDay(
      columns[0].hour,
      [t],
      { ...callbacks(), onTimedDuration, interactionOwner: owner },
      [],
      { date: '2026-07-06', terminal: true },
    );
    const block = columns[0].hour.querySelector('.tc-tg-block') as HTMLElement;
    const handle = block.querySelector('[data-resize-edge="duration"]') as HTMLElement;
    block.getBoundingClientRect = () => rect(0, 9 * 48 + 100, 100, 48);
    const originalHeight = block.style.height;
    handle.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 50, clientY: 580, pointerId: 3 }),
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 50, clientY: 604, pointerId: 3 }),
    );
    const preview = columns[0].hour.querySelector('.tc-tg-drag-preview') as HTMLElement;
    expect(preview.style.height).toBe('72px');
    expectInertPreview(preview, t.title);
    expect(preview.textContent).toContain('09:00–10:30 (1h30m)');
    expect(block.style.height).toBe(originalHeight);
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 50, clientY: 604, pointerId: 3 }),
    );
    const [, target] = onTimedDuration.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(target).toEqual({
      edge: 'end',
      startMinutes: 540,
      durationMinutes: 90,
      endMinutes: 630,
    });
    expect(preview.dataset['target']).toBe(JSON.stringify(target));
  });

  it('uses the top handle to preserve the end, preview the target range, and beat body move', () => {
    const { owner, columns } = timedGestureGrid();
    const onTimedMove = vi.fn();
    const onTimedDuration = vi.fn();
    const t = task({
      title: 'Resize start',
      planning: { due: '2026-07-06', time: '09:00', duration: 60 },
    });
    renderTimedBlocksForDay(
      columns[0].hour,
      [t],
      { ...callbacks(), onTimedMove, onTimedDuration, interactionOwner: owner },
      [],
      { date: '2026-07-06', terminal: true },
    );
    const block = columns[0].hour.querySelector('.tc-tg-block') as HTMLElement;
    const handle = block.querySelector('[data-resize-edge="start-time"]') as HTMLElement;
    block.getBoundingClientRect = () => rect(0, 9 * 48 + 100, 100, 48);

    handle.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 50, clientY: 532, pointerId: 4 }),
    );
    expect(block.dataset['activeResize']).toBe('start-time');
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 50, clientY: 508, pointerId: 4 }),
    );

    const preview = columns[0].hour.querySelector('.tc-tg-drag-preview') as HTMLElement;
    expectInertPreview(preview, t.title);
    expect(preview.textContent).toContain('08:30–10:00 (1h30m)');
    expect(preview.style.top).toBe('408px');
    expect(preview.style.height).toBe('72px');
    expect(onTimedMove).not.toHaveBeenCalled();

    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 50, clientY: 508, pointerId: 4 }),
    );
    expect(onTimedDuration).toHaveBeenCalledWith(t, {
      edge: 'start',
      startMinutes: 510,
      durationMinutes: 90,
      endMinutes: 600,
    });
    expect(onTimedMove).not.toHaveBeenCalled();
    expect(block.dataset['activeResize']).toBeUndefined();
  });

  it('renders a block-sized boundary preview and commits that same frozen boundary target', () => {
    const { owner, columns } = timedGestureGrid();
    const onTimedBoundary = vi.fn();
    const t = task({
      planning: { start: '2026-07-06', due: '2026-07-08', time: '09:00', duration: 60 },
    });
    renderTimedBlocksForDay(
      columns[2].hour,
      [t],
      { ...callbacks(), onTimedBoundary, interactionOwner: owner },
      [],
      { date: '2026-07-08', terminal: true },
    );
    const block = columns[2].hour.querySelector('.tc-tg-block') as HTMLElement;
    const handle = block.querySelector('[data-boundary="due"]') as HTMLElement;
    block.getBoundingClientRect = () => rect(200, 9 * 48 + 100, 100, 48);
    handle.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 250, clientY: 544, pointerId: 8 }),
    );
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 150, clientY: 544, pointerId: 8 }),
    );
    const preview = columns[1].hour.querySelector('.tc-tg-boundary-preview') as HTMLElement;
    expectInertPreview(preview, t.title);
    expect(preview.style.top).toBe('432px');
    expect(preview.style.height).toBe('48px');
    expect(columns.every((column) => !column.day.classList.contains('is-drag-over'))).toBe(true);
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 150, clientY: 544, pointerId: 8 }),
    );
    const [, target] = onTimedBoundary.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(target).toEqual({ boundary: 'due', date: '2026-07-07', dayDelta: -1 });
    expect(Object.isFrozen(target)).toBe(true);
    expect(preview.dataset['target']).toBe(JSON.stringify(target));
  });

  it.each(['pointercancel', 'lostpointercapture', 'blur'] as const)(
    '%s disposes preview and transient state without committing',
    (eventType) => {
      const { owner, columns } = timedGestureGrid();
      const onTimedMove = vi.fn();
      const t = task({ planning: { due: '2026-07-06', time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(
        columns[0].hour,
        [t],
        { ...callbacks(), onTimedMove, interactionOwner: owner },
        [],
        { date: '2026-07-06', terminal: true },
      );
      const block = columns[0].hour.querySelector('.tc-tg-block') as HTMLElement;
      block.getBoundingClientRect = () => rect(0, 9 * 48 + 100, 100, 48);
      block.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientX: 25, clientY: 544, pointerId: 4 }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 125, clientY: 592, pointerId: 4 }),
      );
      expect(
        columns[0].day.closest('.tc-tg-root')?.querySelector('.tc-tg-drag-preview'),
      ).not.toBeNull();
      if (eventType === 'blur') window.dispatchEvent(new Event('blur'));
      else if (eventType === 'pointercancel') {
        window.dispatchEvent(new PointerEvent(eventType, { pointerId: 4 }));
      } else block.dispatchEvent(new PointerEvent(eventType, { bubbles: true, pointerId: 4 }));
      expect(
        columns[0].day.closest('.tc-tg-root')?.querySelector('.tc-tg-drag-preview'),
      ).toBeNull();
      expect(block.classList.contains('is-picked-up')).toBe(false);
      window.dispatchEvent(
        new PointerEvent('pointerup', { clientX: 125, clientY: 592, pointerId: 4 }),
      );
      expect(onTimedMove).not.toHaveBeenCalled();
    },
  );

  it('owner disposal is the patch/destroy cleanup boundary', () => {
    const { owner, columns } = timedGestureGrid();
    const onTimedDuration = vi.fn();
    const t = task({ planning: { due: '2026-07-06', time: '09:00', duration: 60 } });
    renderTimedBlocksForDay(
      columns[0].hour,
      [t],
      { ...callbacks(), onTimedDuration, interactionOwner: owner },
      [],
      { date: '2026-07-06', terminal: true },
    );
    const block = columns[0].hour.querySelector('.tc-tg-block') as HTMLElement;
    const handle = block.querySelector<HTMLElement>('[data-resize-edge="duration"]')!;
    block.getBoundingClientRect = () => rect(0, 9 * 48 + 100, 100, 48);
    handle.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, clientX: 25, clientY: 544, pointerId: 5 }),
    );
    expect(block.dataset['activeResize']).toBe('duration');
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 25, clientY: 592, pointerId: 5 }),
    );
    owner.disposeActive();
    expect(columns[0].day.closest('.tc-tg-root')?.querySelector('.tc-tg-drag-preview')).toBeNull();
    expect(block.dataset['activeResize']).toBeUndefined();
    window.dispatchEvent(
      new PointerEvent('pointerup', { clientX: 25, clientY: 592, pointerId: 5 }),
    );
    expect(onTimedDuration).not.toHaveBeenCalled();
  });

  it.each(['pointercancel', 'lostpointercapture', 'blur'] as const)(
    '%s clears edge-specific timed resize state without committing',
    (eventType) => {
      const { owner, columns } = timedGestureGrid();
      const onTimedDuration = vi.fn();
      const t = task({ planning: { due: '2026-07-06', time: '09:00', duration: 60 } });
      renderTimedBlocksForDay(
        columns[0].hour,
        [t],
        { ...callbacks(), onTimedDuration, interactionOwner: owner },
        [],
        { date: '2026-07-06', terminal: true },
      );
      const block = columns[0].hour.querySelector('.tc-tg-block') as HTMLElement;
      const handle = block.querySelector<HTMLElement>('[data-resize-edge="duration"]')!;
      block.getBoundingClientRect = () => rect(0, 9 * 48 + 100, 100, 48);
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientY: 580, pointerId: 6 }),
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientY: 628, pointerId: 6 }));
      expect(block.dataset['activeResize']).toBe('duration');
      expect(columns[0].hour.querySelector('.tc-tg-drag-preview')).not.toBeNull();

      if (eventType === 'blur') window.dispatchEvent(new Event('blur'));
      else if (eventType === 'pointercancel') {
        window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 6 }));
      } else {
        handle.dispatchEvent(new Event('lostpointercapture'));
      }

      expect(block.dataset['activeResize']).toBeUndefined();
      expect(columns[0].hour.querySelector('.tc-tg-drag-preview')).toBeNull();
      window.dispatchEvent(new PointerEvent('pointerup', { clientY: 628, pointerId: 6 }));
      expect(onTimedDuration).not.toHaveBeenCalled();
    },
  );
});

describe('renderTimedBlocksForDay', () => {
  it('renders all four explicit resize edges with 10px targets and 2px local grips', () => {
    const container = freshContainer();
    renderTimedBlocksForDay(
      container,
      [
        task({
          planning: {
            start: '2026-07-10',
            due: '2026-07-10',
            time: '09:00',
            duration: 60,
          },
        }),
      ],
      callbacks(),
      [],
      { date: '2026-07-10' },
    );

    expect(
      Array.from(container.querySelectorAll<HTMLElement>('[data-resize-edge]'))
        .map((handle) => handle.dataset['resizeEdge'])
        .sort(),
    ).toEqual(['due-date', 'duration', 'start-date', 'start-time']);
    expect(declarationsFor('.tc-tg-resize-handle')).toMatch(/height\s*:\s*10px/u);
    expect(declarationsFor('.tc-tg-resize-handle::after')).toMatch(/height\s*:\s*2px/u);
    expect(declarationsFor('.tc-tg-span-edge')).toMatch(/width\s*:\s*10px/u);
    expect(declarationsFor('.tc-tg-span-edge::after')).toMatch(/width\s*:\s*2px/u);
  });

  it('reveals edge-local grips on handle hover, active press, and only the matching active edge', () => {
    const revealed = declarationsForRuleContaining(
      '.tc-tg-resize-handle:hover::after',
      '.tc-tg-span-edge:hover::after',
      '.tc-tg-resize-handle:active::after',
      '.tc-tg-span-edge:active::after',
      '.tc-tg-block:focus-within > .tc-tg-span-edge::after',
      '.tc-span-piece:focus-within > .tc-tg-span-edge::after',
      "[data-active-resize='start-time'] > [data-resize-edge='start-time']::after",
      "[data-active-resize='duration'] > [data-resize-edge='duration']::after",
      "[data-active-resize='start-date'] > [data-resize-edge='start-date']::after",
      "[data-active-resize='due-date'] > [data-resize-edge='due-date']::after",
    );

    expect(revealed).toMatch(/opacity\s*:\s*1/u);
    expect(css).not.toContain('.tc-tg-block:focus-within > .tc-tg-resize-handle::after');
    expect(css).not.toMatch(/\[data-active-resize\](?!\s*=)/u);
    expect(
      declarationsForRuleContaining(
        '.tc-tg-body[data-active-resize]',
        '.tc-tg-block[data-active-resize]',
      ),
    ).not.toMatch(/outline\s*:/u);
  });

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

  describe('native drag remains absent in the legacy no-date seam', () => {
    it('the block is not native draggable', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      expect(block.getAttribute('draggable')).toBeNull();
    });

    it('the resize handle stays explicitly draggable=false', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const handle = container.querySelector('.tc-tg-resize-handle') as HTMLElement;
      expect(handle.getAttribute('draggable')).toBe('false');
    });

    it('dragstart does not publish a native filePath:::line payload', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00' }, source: { filePath: 'a.md', line: 3 } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const dt = dispatchDnD(block, 'dragstart');
      expect(dt.getData('text/plain')).toBe('');
    });

    it('native dragstart never adds is-dragging', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      dispatchDnD(block, 'dragstart');
      expect(block.hasClass('is-dragging')).toBe(false);
      dispatchDnD(block, 'dragend');
      expect(block.hasClass('is-dragging')).toBe(false);
    });

    it('legacy no-date vertical Pointer-Events move still fires onTimeChange', () => {
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

    it('a pointercancel in the legacy no-date path cleans up without firing callbacks', () => {
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
      // Cancellation replaces the normal pointerup for this gesture.
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

    describe('legacy no-date resize returns the root to its attribute-free draggable state', () => {
      it('temporarily marks the root draggable=false and removes the attribute on pointerup', () => {
        const container = freshContainer();
        const t = task({ planning: { time: '09:00', duration: 60 } });
        renderTimedBlocksForDay(container, [t], callbacks());
        const block = container.querySelector('.tc-tg-block') as HTMLElement;
        const handle = container.querySelector('.tc-tg-resize-handle') as HTMLElement;
        handle.setPointerCapture = () => {};
        handle.releasePointerCapture = () => {};

        expect(block.getAttribute('draggable')).toBeNull();
        handle.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
        );
        expect(block.getAttribute('draggable')).toBe('false');
        window.dispatchEvent(new PointerEvent('pointerup', { clientY: 148, pointerId: 1 }));
        expect(block.getAttribute('draggable')).toBeNull();
      });

      it('a pointercancel mid-resize also removes the temporary draggable attribute', () => {
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
        expect(block.getAttribute('draggable')).toBeNull();
      });

      it('a legacy body move leaves the root attribute-free', () => {
        const container = freshContainer();
        const t = task({ planning: { time: '09:00', duration: 60 } });
        renderTimedBlocksForDay(container, [t], callbacks());
        const block = container.querySelector('.tc-tg-block') as HTMLElement;
        block.setPointerCapture = () => {};
        block.releasePointerCapture = () => {};

        block.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, clientY: 100, pointerId: 1 }),
        );
        expect(block.getAttribute('draggable')).toBeNull();
        window.dispatchEvent(new PointerEvent('pointerup', { clientY: 100, pointerId: 1 }));
        expect(block.getAttribute('draggable')).toBeNull();
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

    it('.tc-tg-block:focus-visible gets a distinct tag-aware inset outline so a keyboard user can see which block arrow keys will nudge', () => {
      const rule = declarationsFor('.tc-tg-block:focus-visible');
      expect(rule).toMatch(/box-shadow\s*:\s*inset 0 0 0 2px/u);
      expect(rule).toMatch(/--tc-event-focus-tag-strength/u);
      expect(rule).toMatch(/--text-normal/u);
    });

    it('keeps terminal and continuation titles at the all-day/Month 1.4 line-height', () => {
      expect(declarationsFor('.tc-tg-block-title')).toMatch(/line-height\s*:\s*1\.4/u);
      expect(declarationsFor('.tc-tg-block-continuation-title')).toMatch(/line-height\s*:\s*1\.4/u);
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

    it('.tc-tg-block.is-selected is a distinct rule from transient drag and edge-specific resize state and can coexist with is-picked-up', () => {
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

  describe('legacy no-date horizontal right-edge resize compatibility', () => {
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

    it('renders a right-edge handle on every legacy timed block', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const handle = block.querySelector('.tc-tg-span-edge--right') as HTMLElement;
      expect(handle).not.toBeNull();
    });

    it('the horizontal handle stays explicitly draggable=false', () => {
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

    it('a pointercancel on the legacy right edge tears down listeners before a subsequent pointerup', () => {
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

    it('the legacy right edge temporarily marks the root non-draggable, then removes the attribute', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const handle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;

      expect(block.getAttribute('draggable')).toBeNull();
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      expect(block.getAttribute('draggable')).toBe('false');
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
      expect(block.getAttribute('draggable')).toBeNull();
    });

    it('a pointercancel on the legacy right edge removes the temporary draggable attribute', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const handle = container.querySelector('.tc-tg-span-edge--right') as HTMLElement;

      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      expect(block.getAttribute('draggable')).toBe('false');
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
      expect(block.getAttribute('draggable')).toBeNull();
    });
  });

  describe('legacy no-date horizontal left-edge resize compatibility', () => {
    // Same jsdom elementFromPoint caveat/stub as the Task 29 right-edge suite above.
    let originalElementFromPoint: typeof activeDocument.elementFromPoint;
    beforeEach(() => {
      originalElementFromPoint = activeDocument.elementFromPoint;
      activeDocument.elementFromPoint = () => null;
    });
    afterEach(() => {
      activeDocument.elementFromPoint = originalElementFromPoint;
    });

    it('renders both legacy horizontal edge handles', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      expect(block.querySelector('.tc-tg-span-edge--left')).not.toBeNull();
      expect(block.querySelector('.tc-tg-span-edge--right')).not.toBeNull();
    });

    it('the left-edge handle stays explicitly draggable=false', () => {
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

    it('keeps the four legacy pointer modes isolated and native drag absent', () => {
      const container = freshContainer();
      const cbs = callbacks();
      const t = task({ planning: { time: '09:00', duration: 60, due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], cbs);
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const leftHandle = block.querySelector('.tc-tg-span-edge--left') as HTMLElement;
      const rightHandle = block.querySelector('.tc-tg-span-edge--right') as HTMLElement;
      const resizeHandle = block.querySelector('.tc-tg-resize-handle') as HTMLElement;

      // Native whole-block drag remains absent.
      expect(block.getAttribute('draggable')).toBeNull();

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

    it('the legacy left edge temporarily marks the root non-draggable, then removes the attribute', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const handle = container.querySelector('.tc-tg-span-edge--left') as HTMLElement;

      expect(block.getAttribute('draggable')).toBeNull();
      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      expect(block.getAttribute('draggable')).toBe('false');
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }));
      expect(block.getAttribute('draggable')).toBeNull();
    });

    it('a pointercancel on the legacy left edge removes the temporary draggable attribute', () => {
      const container = freshContainer();
      const t = task({ planning: { time: '09:00', due: '2026-07-10' } });
      renderTimedBlocksForDay(container, [t], callbacks());
      const block = container.querySelector('.tc-tg-block') as HTMLElement;
      const handle = container.querySelector('.tc-tg-span-edge--left') as HTMLElement;

      handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      expect(block.getAttribute('draggable')).toBe('false');
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
      expect(block.getAttribute('draggable')).toBeNull();
    });
  });

  describe('legacy no-date pointer capture closes the abandoned-gesture cleanup gap', () => {
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

    // Compatibility cleanup only runs from pointerup/pointercancel. Pointer Capture on pointerdown
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
      expect(block.getAttribute('draggable')).toBeNull();
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

  describe('legacy renderTimedSpanContinuation compatibility API', () => {
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

    it('keeps the legacy shape inert and without resize handles', () => {
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

    // This compatibility shape retains its historical subtitle/badges while remaining inert.
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

    it('keeps the legacy subtitle/badges shape marker-free and inert', () => {
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
      // This deprecated compatibility renderer intentionally has no move/resize wiring.
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

  // The retained compatibility renderer has its own min-height collision cap; production ghosts
  // use the common packOverlaps/capMinHeightsPx path instead.
  describe('legacy continuation min-height collision compatibility', () => {
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

describe('calendar surface style contract', () => {
  it('gives timed terminal and ghost blocks one shared scale, rail geometry, fill, and tag outline', () => {
    const terminal = declarationsFor('.tc-tg-block');
    const ghost = declarationsFor('.tc-tg-block-continuation');
    const sharedFill = declarationsForRuleContaining('.tc-tg-block', '.tc-tg-span', '.tc-tg-plain');

    expect(terminal).toMatch(/font-size\s*:\s*var\(--tc-calendar-item-font-size\)/u);
    expect(terminal).toMatch(/border-radius\s*:\s*var\(--tc-calendar-item-radius\)/u);
    expect(terminal).toMatch(/padding\s*:\s*2px\s+var\(--tc-calendar-item-pad-inline\)/u);
    expect(ghost).toMatch(/border-inline-start\s*:\s*var\(--tc-calendar-ghost-rail\) dashed/u);
    expect(ghost).toMatch(/var\(--tc-event-fill-strength\)/u);
    expect(sharedFill).toMatch(/border-inline-start\s*:\s*var\(--tc-calendar-item-rail\) solid/u);
    expect(sharedFill).toMatch(/var\(--tc-event-fill-strength\)/u);
    expect(sharedFill).toMatch(
      /box-shadow\s*:\s*inset 0 0 0 1px[\s\S]*--tc-event-outline-strength/u,
    );
  });
});
