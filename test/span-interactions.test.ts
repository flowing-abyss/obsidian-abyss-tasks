import { describe, expect, it, vi } from 'vitest';
import {
  attachSpanInteractions,
  createSpanInteractionOwner,
  parseSpanMovePayload,
  resolveGrabbedDate,
  resolveSpanMoveTarget,
  serializeSpanMovePayload,
} from '../src/views/spanInteractions';
import { task } from './helpers';

const columns = [
  { date: '2026-07-06', left: 100, right: 200 },
  { date: '2026-07-07', left: 200, right: 300 },
  { date: '2026-07-08', left: 300, right: 400 },
] as const;

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
});
