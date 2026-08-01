import { describe, expect, it, vi } from 'vitest';
import {
  attachSpanInteractions,
  createSpanInteractionOwner,
  parseSpanMovePayload,
  resolveGrabbedDate,
  resolveSpanMoveTarget,
  serializeSpanMovePayload,
} from '../src/views/spanInteractions';
import { layoutVisibleSpans } from '../src/views/spanLayout';
import { task } from './helpers';

const columns = [
  { date: '2026-07-06', left: 100, right: 200 },
  { date: '2026-07-07', left: 200, right: 300 },
  { date: '2026-07-08', left: 300, right: 400 },
] as const;

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

describe('span interaction geometry', () => {
  it.each([
    [100, '2026-07-06'],
    [250, '2026-07-07'],
    [400, '2026-07-08'],
  ])('resolves pointer X %d to grabbedDate %s', (clientX, expected) => {
    expect(resolveGrabbedDate(clientX, columns)).toBe(expected);
  });

  it('resolves dates from clipped visible columns without assuming the task start is visible', () => {
    expect(resolveGrabbedDate(150, columns.slice(0, 2))).toBe('2026-07-06');
  });

  it.each([99, 401, Number.NaN])('rejects an outside or invalid coordinate %s', (clientX) => {
    expect(resolveGrabbedDate(clientX, columns)).toBeUndefined();
  });

  it('round-trips a structured payload with identity and grabbedDate', () => {
    const snapshot = task({ source: { filePath: 'folder/a.md', line: 7 } });
    const serialized = serializeSpanMovePayload(snapshot, '2026-07-07');

    expect(parseSpanMovePayload(serialized)).toEqual({
      version: 1,
      task: { filePath: 'folder/a.md', line: 7 },
      grabbedDate: '2026-07-07',
    });
  });

  it('returns one immutable whole-schedule delta and rejects a no-op drop', () => {
    const snapshot = task({ source: { filePath: 'folder/a.md', line: 7 } });
    const payload = parseSpanMovePayload(serializeSpanMovePayload(snapshot, '2026-07-07'))!;

    expect(resolveSpanMoveTarget(payload, '2026-07-10')).toEqual({
      grabbedDate: '2026-07-07',
      targetDate: '2026-07-10',
      days: 3,
    });
    expect(resolveSpanMoveTarget(payload, '2026-07-07')).toBeUndefined();
    expect(Object.isFrozen(resolveSpanMoveTarget(payload, '2026-07-10'))).toBe(true);
  });

  it.each(['', '{}', '{"version":2}', '{"version":1,"task":{},"grabbedDate":"bad"}'])(
    'rejects malformed payload %s',
    (payload) => expect(parseSpanMovePayload(payload)).toBeUndefined(),
  );

  it('uses the source document window for a single active create-span session', () => {
    const root = document.createElement('div');
    root.className = 'tc-tg-root';
    const row = root.createDiv({ cls: 'tc-tg-allday-days' });
    const layer = row.createDiv({ cls: 'tc-tg-span-layer' });
    const first = row.createDiv({ cls: 'tc-tg-allday-cell' });
    first.dataset['tgDate'] = '2026-07-06';
    const second = row.createDiv({ cls: 'tc-tg-allday-cell' });
    second.dataset['tgDate'] = '2026-07-07';
    document.body.appendChild(root);
    const source = layer.createDiv();
    const firstHandle = source.createDiv();
    const secondHandle = source.createDiv();
    const foreignWindow = new EventTarget();
    const ownerDocument = {
      defaultView: foreignWindow,
      createElement: document.createElement.bind(document),
    } as unknown as Document;
    Object.defineProperty(source, 'ownerDocument', { configurable: true, value: ownerDocument });
    vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
    vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(new DOMRect(100, 0, 100, 100));
    const onBoundary = vi.fn();
    const owner = createSpanInteractionOwner();
    const snapshot = task({ planning: { scheduled: '2026-07-06' } });

    attachSpanInteractions({
      source,
      task: snapshot,
      segmentStart: '2026-07-06',
      segmentEnd: '2026-07-06',
      owner,
      boundaryHandles: [
        { element: firstHandle, boundary: 'create-span' },
        { element: secondHandle, boundary: 'create-span' },
      ],
      onMove: vi.fn(),
      onBoundary,
    });

    try {
      firstHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
      secondHandle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2 }));
      foreignWindow.dispatchEvent(new PointerEvent('pointerup', { clientX: 150, pointerId: 1 }));
      expect(onBoundary).not.toHaveBeenCalled();
      foreignWindow.dispatchEvent(new PointerEvent('pointerup', { clientX: 150, pointerId: 2 }));
      expect(onBoundary).toHaveBeenCalledWith(
        snapshot,
        expect.objectContaining({ boundary: 'create-span', date: '2026-07-07' }),
      );
    } finally {
      root.remove();
    }
  });

  it('computes one prospective layout per multi-row Month pointer update', () => {
    const root = document.createElement('div');
    root.className = 'tc-mg-grid';
    const dates = [
      '2026-07-06',
      '2026-07-07',
      '2026-07-08',
      '2026-07-09',
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
      '2026-07-13',
      '2026-07-14',
      '2026-07-15',
      '2026-07-16',
      '2026-07-17',
      '2026-07-18',
      '2026-07-19',
    ];
    const layers = Array.from({ length: 2 }, (_, rowIndex) => {
      const row = root.createDiv({ cls: 'tc-mg-row' });
      const layer = row.createDiv({ cls: 'tc-mg-span-layer' });
      for (let columnIndex = 0; columnIndex < 7; columnIndex++) {
        const dateIndex = rowIndex * 7 + columnIndex;
        const cell = row.createDiv({ cls: 'tc-mg-cell' });
        cell.dataset['mgDate'] = dates[dateIndex];
        vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(
          new DOMRect(columnIndex * 100, rowIndex * 100, 100, 100),
        );
      }
      return layer;
    });
    document.body.appendChild(root);
    const source = layers[0]!.createDiv();
    source.style.gridRow = '1';
    const snapshot = task({
      source: { filePath: 'span.md', line: 1 },
      planning: { start: '2026-07-10', due: '2026-07-15' },
    });
    let layoutComputations = 0;

    attachSpanInteractions({
      source,
      task: snapshot,
      segmentStart: '2026-07-10',
      segmentEnd: '2026-07-12',
      owner: createSpanInteractionOwner(),
      previewLayoutFor: (candidate, planning) => {
        layoutComputations++;
        return layoutVisibleSpans([{ ...candidate, planning }], dates);
      },
      boundaryHandles: [],
      onMove: vi.fn(),
      onBoundary: vi.fn(),
    });

    try {
      source.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: 450,
          clientY: 50,
          pointerId: 3,
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', {
          clientX: 550,
          clientY: 50,
          pointerId: 3,
        }),
      );

      expect(
        Array.from(root.querySelectorAll<HTMLElement>('.tc-span-move-preview')).map((preview) => ({
          column: preview.style.gridColumn,
          row: preview.style.gridRow,
          target: JSON.parse(preview.dataset['target']!),
        })),
      ).toEqual([
        {
          column: '6 / 7',
          row: '1',
          target: { grabbedDate: '2026-07-10', targetDate: '2026-07-11', days: 1 },
        },
        {
          column: '7 / 8',
          row: '1',
          target: { grabbedDate: '2026-07-10', targetDate: '2026-07-11', days: 1 },
        },
        {
          column: '1 / 2',
          row: '1',
          target: { grabbedDate: '2026-07-10', targetDate: '2026-07-11', days: 1 },
        },
        {
          column: '2 / 3',
          row: '1',
          target: { grabbedDate: '2026-07-10', targetDate: '2026-07-11', days: 1 },
        },
        {
          column: '3 / 4',
          row: '1',
          target: { grabbedDate: '2026-07-10', targetDate: '2026-07-11', days: 1 },
        },
        {
          column: '4 / 5',
          row: '1',
          target: { grabbedDate: '2026-07-10', targetDate: '2026-07-11', days: 1 },
        },
      ]);
      for (const preview of root.querySelectorAll<HTMLElement>('.tc-span-move-preview')) {
        expectInertPreview(preview, snapshot.title);
      }
      expect(layoutComputations).toBe(1);
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 3 }));
      expect(root.querySelectorAll('.tc-span-move-preview')).toHaveLength(0);
    } finally {
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 3 }));
      root.remove();
    }
  });

  it('clears a boundary preview once when returning to its unchanged date', () => {
    const root = document.createElement('div');
    root.className = 'tc-tg-root';
    const row = root.createDiv({ cls: 'tc-tg-allday-days' });
    const layer = row.createDiv({ cls: 'tc-tg-span-layer' });
    for (const [index, date] of ['2026-07-06', '2026-07-07', '2026-07-08'].entries()) {
      const cell = row.createDiv({ cls: 'tc-tg-allday-cell' });
      cell.dataset['tgDate'] = date;
      vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(index * 100, 0, 100, 100),
      );
    }
    document.body.appendChild(root);
    const source = layer.createDiv();
    source.style.gridRow = '1';
    const handle = source.createDiv();
    const snapshot = task({ planning: { start: '2026-07-07', due: '2026-07-08' } });
    let layoutComputations = 0;

    attachSpanInteractions({
      source,
      task: snapshot,
      segmentStart: '2026-07-07',
      segmentEnd: '2026-07-07',
      owner: createSpanInteractionOwner(),
      previewLayoutFor: (candidate, planning) => {
        layoutComputations++;
        return layoutVisibleSpans(
          [{ ...candidate, planning }],
          ['2026-07-06', '2026-07-07', '2026-07-08'],
        );
      },
      boundaryHandles: [{ element: handle, boundary: 'start' }],
      onMove: vi.fn(),
      onBoundary: vi.fn(),
    });

    try {
      handle.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: 150,
          clientY: 50,
          pointerId: 4,
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 50, clientY: 50, pointerId: 4 }),
      );
      const firstPreview = root.querySelector<HTMLElement>('.tc-span-boundary-preview')!;
      const remove = vi.spyOn(firstPreview, 'remove');

      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 150, clientY: 50, pointerId: 4 }),
      );
      expect(root.querySelectorAll('.tc-span-boundary-preview')).toHaveLength(0);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(layoutComputations).toBe(1);

      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 175, clientY: 50, pointerId: 4 }),
      );
      expect(remove).toHaveBeenCalledTimes(1);
      expect(layoutComputations).toBe(1);

      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 75, clientY: 50, pointerId: 4 }),
      );
      expect(root.querySelectorAll('.tc-span-boundary-preview')).toHaveLength(3);
      expect(layoutComputations).toBe(2);
    } finally {
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 4 }));
      root.remove();
    }
  });

  it('does not cache a move target when its preview cannot be built', () => {
    const root = document.createElement('div');
    root.className = 'tc-tg-root';
    const row = root.createDiv({ cls: 'tc-tg-allday-days' });
    const layer = row.createDiv({ cls: 'tc-tg-span-layer' });
    for (const [index, date] of ['2026-07-06', '2026-07-07', '2026-07-08'].entries()) {
      const cell = row.createDiv({ cls: 'tc-tg-allday-cell' });
      cell.dataset['tgDate'] = date;
      vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(
        new DOMRect(index * 100, 0, 100, 100),
      );
    }
    document.body.appendChild(root);
    const source = layer.createDiv();
    source.style.gridRow = '1';
    const snapshot = task({ planning: { start: '0000-01-01', due: '2026-07-08' } });
    let layoutComputations = 0;

    attachSpanInteractions({
      source,
      task: snapshot,
      segmentStart: '2026-07-07',
      segmentEnd: '2026-07-07',
      owner: createSpanInteractionOwner(),
      previewLayoutFor: (candidate, planning) => {
        layoutComputations++;
        return layoutVisibleSpans(
          [{ ...candidate, planning }],
          ['2026-07-06', '2026-07-07', '2026-07-08'],
        );
      },
      boundaryHandles: [],
      onMove: vi.fn(),
      onBoundary: vi.fn(),
    });

    try {
      source.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          clientX: 150,
          clientY: 50,
          pointerId: 5,
        }),
      );
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 50, clientY: 50, pointerId: 5 }),
      );
      expect(root.querySelectorAll('.tc-span-move-preview')).toHaveLength(0);
      expect(layoutComputations).toBe(0);

      const mutablePlanning = snapshot.planning as { start?: string; due?: string };
      mutablePlanning.start = '2026-07-20';
      mutablePlanning.due = '2026-07-21';
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 75, clientY: 50, pointerId: 5 }),
      );
      expect(root.querySelectorAll('.tc-span-move-preview')).toHaveLength(0);
      expect(layoutComputations).toBe(1);

      mutablePlanning.start = '2026-07-07';
      mutablePlanning.due = '2026-07-08';
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 75, clientY: 50, pointerId: 5 }),
      );

      expect(root.querySelectorAll('.tc-span-move-preview')).toHaveLength(2);
      expect(layoutComputations).toBe(2);
    } finally {
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 5 }));
      root.remove();
    }
  });
});
