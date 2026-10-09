// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { IndexedRowGeometry } from '../src/panels/virtualization/indexedRowGeometry';
import { RowViewport } from '../src/panels/virtualization/rowViewport';
import { expectDefined } from './helpers';
import { numericRowSource } from './support/virtualSurfaceAudit';

it.each([0, 1, 8])('keeps beyond-end lookup inside a strict %i-row boundary domain', (length) => {
  const geometry = new IndexedRowGeometry();
  geometry.replace(numericRowSource(0, length - 1));
  const boundary = geometry.boundary(length * 40 + 80);
  expect(boundary).toBe(length);
  expect(geometry.offset(boundary)).toBe(length * 40);
});

describe('indexed sparse geometry', () => {
  it('locates and replaces ten million rows without visiting their sequence', () => {
    const source = numericRowSource(0, 9_999_999);
    const viewport = new RowViewport();
    viewport.replaceIndexed(source);
    expect(viewport.rowAt(399_999_965)).toMatchObject({ key: 'number:9999999', top: 399_999_960 });
    const anchor = viewport.captureAnchor(45);
    viewport.replaceIndexed(numericRowSource(9_000_000, 9_999_999));
    expect(viewport.restoreAnchor(anchor, 99)).toBe(5);
    expect(source.reads()).toBeLessThan(100);
  });
  it('bounds measurement history while retaining mounted, pinned and current anchor entries', () => {
    const viewport = new RowViewport();
    viewport.replaceIndexed(numericRowSource(0, 9_999_999));
    viewport.window(0, 80, ['number:9000000']);
    viewport.measure(
      [
        { key: 'number:0', height: 60 },
        { key: 'number:9000000', height: 70 },
      ],
      0,
    );
    const anchor = viewport.captureAnchor(5);
    for (let i = 1; i < 2200; i++)
      viewport.measure([{ key: `number:${i * 100}`, height: 50 }], 5, anchor);
    expect(viewport.rowBounds('number:0')?.bottom).toBe(60);
    const pinned = expectDefined(viewport.rowBounds('number:9000000'));
    expect(pinned.bottom - pinned.top).toBe(70);
    const evicted = expectDefined(viewport.rowBounds('number:100'));
    expect(evicted.bottom - evicted.top).toBe(40);
    const end = expectDefined(viewport.rowBounds('number:9999999'));
    expect(end.bottom - 400_000_000).toBeLessThanOrEqual(2048 * 30);
    expect(viewport.restoreAnchor(anchor, 99)).toBe(5);
  });
});

it('retains the finite live pin set even above the cache limit, then evicts released history', () => {
  const viewport = new RowViewport();
  viewport.replaceIndexed(numericRowSource(0, 9999));
  const keys = Array.from({ length: 2100 }, (_, index) => `number:${index}`);
  viewport.window(0, 40, keys);
  viewport.measure(
    keys.map((key) => ({ key, height: 50 })),
    5,
  );
  expect(expectDefined(viewport.rowBounds('number:2099')).bottom).toBe(105000);
  viewport.window(0, 40, []);
  viewport.measure([], 5);
  expect(expectDefined(viewport.rowBounds('number:100')).top).toBeLessThan(5000);
  expect(expectDefined(viewport.rowBounds('number:0')).bottom).toBe(50);
});

it('exposes every finite task-list key for source-specific anchor intersection', async () => {
  const { indexedRows } = await import('../src/panels/task-list/taskListRows');
  const keys = [
    'number:0',
    'number:1',
    ...Array.from({ length: 5000 }, (_, n) => `gone:${n}`),
    'number:9000000',
  ];
  const prior = indexedRows(
    keys.map((key) => ({ kind: 'task' as const, key, taskKey: key, task: 0 })),
  );
  expect(prior.anchorRanges()).toHaveLength(5003);
  expect(prior.survivingNeighbor(1, 1, numericRowSource(9_000_000, 9_000_000))).toBe(
    'number:9000000',
  );
  expect(prior.survivingNeighbor(1, -1, numericRowSource(0, 0))).toBe('number:0');
});
