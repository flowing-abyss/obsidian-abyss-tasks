// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RowViewport, type RowViewportRow } from '../src/panels/virtualization/rowViewport';

function rows(keys: readonly string[], height = 40, revision = '1'): RowViewportRow[] {
  return keys.map((key) => ({ key, estimatedHeight: height, measurementRevision: revision }));
}

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
    expect(first?.previousKeys).toBe(second?.previousKeys);
    expect(Object.isFrozen(first?.previousKeys)).toBe(true);
    v.replace(rows(['d']));
    expect(second?.previousKeys).toEqual(['a', 'b', 'c']);
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
