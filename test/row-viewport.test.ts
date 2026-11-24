// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RowViewport, type RowViewportRow } from '../src/panels/virtualization/rowViewport';
import { numericRowSource } from './support/virtualSurfaceAudit';

function rows(keys: readonly string[], height = 40, revision = '1'): RowViewportRow[] {
  return keys.map((key) => ({ key, estimatedHeight: height, measurementRevision: revision }));
}

it.each([false, true])('measures a shrunken strict source with retained anchor=%s', (retained) => {
  const viewport = new RowViewport();
  viewport.replace(rows(['number:0'], 100));
  const anchor = viewport.captureAnchor(80);
  viewport.replaceIndexed(numericRowSource(0, 0));
  expect(viewport.restoreAnchor(anchor, 0)).toBe(80);
  expect(
    viewport.measure([{ key: 'number:0', height: 100 }], 80, retained ? anchor : undefined),
  ).toEqual({ scrollTop: 80, changed: true });
  expect(viewport.rowBounds('number:0')).toMatchObject({ top: 0, bottom: 100 });
  expect(viewport.restoreAnchor(anchor, 0)).toBe(80);
});

describe('shared row viewport geometry', () => {
  it('falls forward to the next survivor and invalidates revision-changed measurements', () => {
    const v = new RowViewport();
    const rows = ['a', 'b', 'c'].map((key) => ({
      key,
      estimatedHeight: 40,
      measurementRevision: '1',
    }));
    v.replace(rows);
    v.measure([{ key: 'a', height: 80 }], 0);
    const anchor = v.captureAnchor(85);
    v.replace(rows.filter((row) => row.key !== 'b'));
    expect(v.restoreAnchor(anchor, 0)).toBe(85);
    v.replace(rows.map((row) => ({ ...row, measurementRevision: '2' })));
    expect(v.rowBounds('b')).toMatchObject({ top: 40, bottom: 80 });
  });

  it('retains unchanged measurements when estimates change and prunes removed keys', () => {
    const v = new RowViewport();
    v.replace(rows(['a', 'b']));
    v.measure([{ key: 'a', height: 80 }], 0);
    v.replace(rows(['a', 'b'], 20));
    expect(v.rowBounds('b')).toEqual({ key: 'b', index: 1, top: 80, bottom: 100 });
    v.replace(rows(['b']));
    v.replace(rows(['a', 'b']));
    expect(v.rowBounds('b')?.top).toBe(40);
  });

  it('restores a surviving key after reorder with its intra-row offset', () => {
    const v = new RowViewport();
    v.replace(rows(['a', 'b', 'c']));
    const anchor = v.captureAnchor(45);
    v.replace(rows(['b', 'c', 'a']));
    expect(v.restoreAnchor(anchor, 99)).toBe(5);
  });

  it('uses prior order for next and preceding survivor fallback', () => {
    const v = new RowViewport();
    v.replace(rows(['a', 'b', 'c', 'd', 'e']));
    const anchor = v.captureAnchor(85);
    v.replace(rows(['e', 'b', 'd']));
    expect(v.restoreAnchor(anchor, 99)).toBe(85);
    v.replace(rows(['b', 'a']));
    expect(v.restoreAnchor(anchor, 99)).toBe(5);
    v.replace(rows(['new']));
    expect(v.restoreAnchor(anchor, 99)).toBe(0);
    expect(v.restoreAnchor(undefined, 12)).toBe(12);
  });

  it('shares immutable prior keys across anchors and preserves them after replacement', () => {
    const v = new RowViewport();
    v.replace(rows(['a', 'b', 'c']));
    const first = v.captureAnchor(5);
    const second = v.captureAnchor(45);
    expect(first?.previousOrder).toBe(second?.previousOrder);
    expect(Object.isFrozen(first?.previousOrder)).toBe(true);
    v.replace(rows(['d']));
    expect(second?.previousOrder.anchorRanges()).toEqual(
      ['a', 'b', 'c'].map((key) => ({ kind: 'key', key })),
    );
  });

  it('looks up half-open bounds and excludes offsets outside the sequence', () => {
    const v = new RowViewport();
    v.replace(rows(['a', 'b']));
    expect(v.rowAt(0)).toEqual({ key: 'a', index: 0, top: 0, bottom: 40 });
    expect(v.rowAt(39.9)?.key).toBe('a');
    expect(v.rowAt(40)).toEqual({ key: 'b', index: 1, top: 40, bottom: 80 });
    for (const offset of [-1, 80, 81, NaN, Infinity]) expect(v.rowAt(offset)).toBeUndefined();
    expect(v.rowBounds('missing')).toBeUndefined();
    expect(v.captureAnchor(80)).toBeUndefined();
  });

  it('retains an existing window for a covered Timeline seek and admits only visible rows, two neighbors and pins for a distant one', () => {
    const viewport = new RowViewport();
    viewport.replace(rows(Array.from({ length: 1000 }, (_, i) => String(i))));
    const opening = viewport.window(4000, 400, [], 'timeline');
    const covered = viewport.window(4100, 400, [], 'timeline-seek');
    expect([covered.start, covered.end]).toEqual([opening.start, opening.end]);
    const jump = viewport.window(8001, 400, ['42'], 'timeline-seek');
    expect([jump.start, jump.end]).toEqual([198, 213]);
    expect(jump.segments).toContainEqual({ index: 42 });
    expect(viewport.window(8001, 400, [], 'timeline').end).toBeGreaterThan(jump.end);
  });

  it('preserves the exact-boundary anchor through a measurement batch', () => {
    const v = new RowViewport();
    v.replace(rows(['a', 'b', 'c']));
    expect(
      v.measure(
        [
          { key: 'a', height: 80 },
          { key: 'b', height: 60 },
        ],
        80,
      ),
    ).toEqual({ scrollTop: 140, changed: true });
    expect(v.rowBounds('c')?.top).toBe(140);
    expect(v.measure([{ key: 'a', height: 80.2 }], 140)).toEqual({
      scrollTop: 140,
      changed: false,
    });
  });

  it('ignores unknown, nonpositive and nonfinite measurements', () => {
    const v = new RowViewport();
    v.replace(rows(['a', 'b', 'c']));
    expect(
      v.measure(
        [
          { key: 'a', height: 0 },
          { key: 'b', height: -5 },
          { key: 'b', height: NaN },
          { key: 'c', height: Infinity },
          { key: 'missing', height: 50 },
        ],
        45,
      ),
    ).toEqual({ scrollTop: 45, changed: false });
    expect(v.rowBounds('c')?.bottom).toBe(120);
  });

  it('normalizes invalid estimates to positive finite geometry', () => {
    const v = new RowViewport();
    v.replace(
      [0, -5, NaN, Infinity].map((estimatedHeight, index) => ({
        key: String(index),
        estimatedHeight,
        measurementRevision: '1',
      })),
    );
    for (const key of ['0', '1', '2', '3']) {
      const bounds = v.rowBounds(key);
      expect(Number.isFinite(bounds?.bottom)).toBe(true);
      expect(bounds?.bottom).toBeGreaterThan(bounds?.top ?? Infinity);
    }
  });

  it('reveals tall rows without oscillating when they intersect the viewport', () => {
    const v = new RowViewport();
    v.replace([...rows(['a'], 40), ...rows(['tall'], 500), ...rows(['c'], 40)]);
    for (const top of [0, 40, 100, 440, 500]) {
      const revealed = v.reveal('tall', top, 100);
      expect(v.reveal('tall', revealed, 100)).toBe(revealed);
      expect(revealed).toBe(top);
    }
    expect(v.reveal('tall', 540, 100)).toBe(440);
    expect(v.reveal('missing', 12, 100)).toBe(12);
  });

  it('aligns an entirely offscreen tall row to the nearest edge', () => {
    const v = new RowViewport();
    v.replace([...rows(['a'], 200), ...rows(['tall'], 500), ...rows(['c'], 200)]);
    expect(v.reveal('tall', 0, 100)).toBe(200);
    expect(v.reveal('tall', 800, 100)).toBe(600);
  });

  it('keeps distant pins sparse at their original offsets', () => {
    const v = new RowViewport(0);
    v.replace(
      Array.from({ length: 1000 }, (_, index) => ({
        key: String(index),
        estimatedHeight: 40,
        measurementRevision: '1',
      })),
    );
    const window = v.window(400, 80, ['0', '999', '999', 'unknown']);
    expect(window).toMatchObject({ start: 9, end: 12, scrollTop: 400 });
    expect(window.segments).toEqual([
      { index: 0 },
      { height: 320 },
      { index: 9 },
      { index: 10 },
      { index: 11 },
      { height: 39480 },
      { index: 999 },
    ]);
  });

  it.each([1000, 10000])('bounds mounted rows independently of a %i-row collection', (count) => {
    const v = new RowViewport();
    v.replace(
      Array.from({ length: count }, (_, index) => ({
        key: String(index),
        estimatedHeight: 40,
        measurementRevision: '1',
      })),
    );
    const window = v.window(20000, 400, []);
    expect(window).toMatchObject({ start: 495, end: 515, scrollTop: 20000 });
    expect(window.segments.filter((segment) => 'index' in segment)).toHaveLength(20);
    expect(v.rowAt(20000)?.key).toBe('500');
    expect(v.reveal(String(count - 1), 0, 400)).toBe(count * 40 - 400);
  });

  it.each([320, 700])('keeps fast steps covered across refills in a %ipx viewport', (height) => {
    const viewport = new RowViewport(170, 400);
    viewport.replace(
      rows(
        Array.from({ length: 1000 }, (_, index) => String(index)),
        40,
      ),
    );
    let previous = viewport.window(0, height, []);
    for (const top of [560, 840, 1120, 840, 560, 280, 0, 280]) {
      expect(previous.start * 40).toBeLessThanOrEqual(top);
      expect(previous.end * 40).toBeGreaterThanOrEqual(top + height);
      previous = viewport.window(top, height, []);
      expect(previous.end - previous.start).toBeLessThanOrEqual(
        Math.ceil((height + 2 * (Math.max(400, height * 1.25) + height * 0.75)) / 40) + 2,
      );
    }
  });

  it.each([16, 48, 80])('buffers rapid turns with bounded extra rows at height %i', (rowHeight) => {
    const viewport = new RowViewport();
    viewport.replace(
      rows(
        Array.from({ length: 2000 }, (_, n) => String(n)),
        rowHeight,
      ),
    );
    const height = 400;
    const step = Math.min(260, 7 * rowHeight);
    let top = 8000;
    let previous = viewport.window(top, height, [], 'interactive');
    for (const direction of [1, 1, 1, -1, -1, -1]) {
      top += direction * step;
      expect(previous.start * rowHeight).toBeLessThanOrEqual(top);
      expect(previous.end * rowHeight).toBeGreaterThanOrEqual(top + height);
      previous = viewport.window(top, height, [], 'interactive');
      expect(previous.end - previous.start).toBeLessThanOrEqual(Math.ceil(height / rowHeight) + 26);
    }
  });

  it('keeps two quick wheel steps actionable in a short asynchronous result list', () => {
    const viewport = new RowViewport();
    viewport.replace(
      rows(
        Array.from({ length: 500 }, (_, n) => String(n)),
        38,
      ),
    );
    const height = 288;
    let top = 320;
    for (const delta of [640, 640, -640, -640]) {
      const previous = viewport.window(top, height, [], 'search');
      top += delta;
      expect(previous.start * 38).toBeLessThanOrEqual(top);
      expect(previous.end * 38).toBeGreaterThanOrEqual(top + height);
      expect(previous.end - previous.start).toBeLessThan(52);
    }
  });

  it('covers jumps of more than a screen in both directions before the next render', () => {
    const height = 933;
    const viewport = new RowViewport(170, 400);
    viewport.replace(
      rows(
        Array.from({ length: 4000 }, (_, n) => String(n)),
        40,
      ),
    );
    let top = 10000;
    let previous = viewport.window(top, height, []);
    for (const delta of [280, 700, 1100, 1100, -1100, -1100, -700, -280]) {
      top += delta;
      expect(previous.start * 40).toBeLessThanOrEqual(top);
      expect(previous.end * 40).toBeGreaterThanOrEqual(top + height);
      previous = viewport.window(top, height, []);
      expect(previous.end - previous.start).toBeLessThan(130);
    }
  });

  it('retains recently traversed rows for reversals and releases them on a distant jump', () => {
    const viewport = new RowViewport(170, 400);
    viewport.replace(
      rows(
        Array.from({ length: 4000 }, (_, n) => String(n)),
        40,
      ),
    );
    const origin = viewport.window(0, 933, [], 'history');
    for (let top = 550; top <= 5500; top += 550) viewport.window(top, 933, [], 'history');
    const back = viewport.window(0, 933, [], 'history');
    expect(back.end).toBeGreaterThan(origin.end + 100);
    for (let top = 0; top < 30000; top += 550) {
      const window = viewport.window(top, 933, [], 'history');
      expect(window.end - window.start).toBeLessThanOrEqual(256);
    }
    const jumped = viewport.window(100000, 933, [], 'history');
    expect(jumped.start * 40).toBeGreaterThan(97000);
    expect(jumped.end - jumped.start).toBeLessThan(130);
  });

  it('defers final clamping until window height is known after shrinking', () => {
    const v = new RowViewport();
    v.replace(rows(['a', 'b', 'c']));
    const anchor = v.captureAnchor(85);
    v.replace(rows(['c']));
    expect(v.restoreAnchor(anchor, 0)).toBe(5);
    expect(v.window(5, 100, [])).toMatchObject({ scrollTop: 0, start: 0, end: 1 });
    v.replace([]);
    expect(v.rowAt(0)).toBeUndefined();
    expect(v.restoreAnchor(anchor, 99)).toBe(0);
    expect(v.window(999, 0, [])).toEqual({ start: 0, end: 0, scrollTop: 0, segments: [] });
  });
});

it('uses an explicit pre-replacement key instead of an estimated numeric neighbor', () => {
  const v = new RowViewport();
  v.replace(rows(['above', 'anchor', 'after'], 64));
  v.measure(
    [
      { key: 'above', height: 80 },
      { key: 'anchor', height: 160 },
    ],
    0,
  );
  const anchor = v.captureAnchor(200.5);
  v.replace(rows(['above', 'anchor', 'after'], 64, 'next'));
  const top = v.restoreAnchor(anchor, 0);
  expect(top).toBe(184.5);
  expect(
    v.measure(
      [
        { key: 'above', height: 100 },
        { key: 'anchor', height: 180 },
      ],
      top,
      anchor,
    ),
  ).toEqual({ changed: true, scrollTop: 220.5 });
});

it.each([35.5, 18])(
  'converges shrinking reveal geometry for %s-pixel rows with a finite demanded window',
  (actual) => {
    const v = new RowViewport();
    const keys = Array.from({ length: 1201 }, (_, index) => String(index));
    v.replace(rows(keys, 64));
    let top = v.reveal('1200', 0, 935);
    let window = v.window(top, 935, ['1200']);
    let stable = false;
    for (let pass = 0; pass < 16; pass++) {
      const measured = v.measure(
        window.segments.flatMap((segment) =>
          'index' in segment ? [{ key: String(segment.index), height: actual }] : [],
        ),
        top,
      );
      top = v.reveal('1200', measured.scrollTop, 935);
      window = v.window(top, 935, ['1200']);
      if (!measured.changed) {
        stable = true;
        break;
      }
    }
    expect(stable).toBe(true);
    expect(v.rowBounds('1200')?.bottom).toBeLessThanOrEqual(top + 935);
    expect(v.rowBounds('1200')?.top).toBeGreaterThanOrEqual(top);
    expect(window.segments.filter((segment) => 'index' in segment).length).toBeLessThan(120);
  },
);

it('preserves full previous-array survivors across long vanished runs', () => {
  const v = new RowViewport();
  v.replace(
    rows(['before', 'anchor', ...Array.from({ length: 5000 }, (_, i) => `gone:${i}`), 'after']),
  );
  const anchor = v.captureAnchor(45);
  v.replace(rows(['after', 'before']));
  expect(v.restoreAnchor(anchor, 99)).toBe(5);
  v.replace(rows(['before']));
  expect(v.restoreAnchor(anchor, 99)).toBe(5);
  v.replace(rows(['new-only']));
  expect(v.restoreAnchor(anchor, 99)).toBe(0);
});
