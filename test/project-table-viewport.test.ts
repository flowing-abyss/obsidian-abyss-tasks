import { describe, expect, it } from 'vitest';
import { ProjectTableViewport } from '../src/panels/projects/projectTableViewport';

describe('project table viewport geometry', () => {
  it('uses exclusive boundaries, clamps shrink and includes the final row', () => {
    const viewport = new ProjectTableViewport();
    viewport.replace(
      Array.from({ length: 500 }, (_, index) => ({ key: String(index), height: 34 })),
    );
    expect(viewport.window(3400, 340, [])).toMatchObject({ scrollTop: 3400, start: 94, end: 115 });
    expect(viewport.window(999999, 340, [])).toMatchObject({ scrollTop: 16660, end: 500 });
    viewport.replace([
      { key: '0', height: 34 },
      { key: '1', height: 34 },
    ]);
    expect(viewport.window(16660, 340, [])).toMatchObject({ scrollTop: 0, start: 0, end: 2 });
  });

  it('reuses the buffer until the visible interval crosses its mounted boundary', () => {
    const viewport = new ProjectTableViewport();
    viewport.replace(
      Array.from({ length: 500 }, (_, index) => ({ key: String(index), height: 34 })),
    );
    expect(viewport.window(0, 340, [])).toMatchObject({ start: 0, end: 15 });
    expect(viewport.window(170, 340, [])).toMatchObject({ start: 0, end: 15 });
    expect(viewport.window(171, 340, [])).toMatchObject({ start: 0, end: 21 });
  });

  it('replenishes the buffer on reverse scrolling and large jumps', () => {
    const viewport = new ProjectTableViewport();
    viewport.replace(
      Array.from({ length: 500 }, (_, index) => ({ key: String(index), height: 34 })),
    );
    expect(viewport.window(3400, 340, [])).toMatchObject({ start: 94, end: 115 });
    expect(viewport.window(3196, 340, [])).toMatchObject({ start: 94, end: 115 });
    expect(viewport.window(3195, 340, [])).toMatchObject({ start: 88, end: 109 });
    expect(viewport.window(10000, 340, [])).toMatchObject({ start: 289, end: 310 });
  });

  it('resets the buffer when viewport size or measured row heights change', () => {
    const viewport = new ProjectTableViewport();
    viewport.replace(
      Array.from({ length: 500 }, (_, index) => ({ key: String(index), height: 34 })),
    );
    expect(viewport.window(0, 680, [])).toMatchObject({ start: 0, end: 25 });
    expect(viewport.window(0, 340, [])).toMatchObject({ start: 0, end: 15 });
    viewport.measure(
      [
        { key: '0', height: 60 },
        { key: '1', height: 60 },
      ],
      0,
    );
    expect(viewport.window(0, 340, [])).toMatchObject({ start: 0, end: 14 });
  });

  it('keeps pinned rows separate from buffer coverage and supports unknown viewport height', () => {
    const viewport = new ProjectTableViewport();
    viewport.replace(
      Array.from({ length: 100 }, (_, index) => ({ key: String(index), height: 34 })),
    );
    expect(viewport.window(0, 0, ['99'])).toMatchObject({ start: 0, end: 15 });
    const retained = viewport.window(100, 0, ['99']);
    expect(retained).toMatchObject({ start: 0, end: 15 });
    expect(retained.segments[retained.segments.length - 1]).toEqual({ index: 99 });
    const jumped = viewport.window(1700, 340, ['99']);
    expect(jumped).toMatchObject({ start: 44, end: 65 });
    const unpinned = viewport.window(1734, 340, []);
    expect(unpinned).toMatchObject({ start: 44, end: 65 });
    expect(unpinned.segments[unpinned.segments.length - 1]).toEqual({ height: 1190 });
  });

  it('retains a valid scroll offset while a detached host has no measured viewport height', () => {
    const viewport = new ProjectTableViewport();
    viewport.replace([
      { key: 'group', height: 32 },
      { key: 'project', height: 34 },
    ]);
    expect(viewport.window(33, 0, []).scrollTop).toBe(33);
    expect(viewport.window(33, 340, []).scrollTop).toBe(0);
  });

  it('anchors the next row when measurement changes exactly at a row boundary', () => {
    const viewport = new ProjectTableViewport();
    viewport.replace([
      { key: 'a', height: 34 },
      { key: 'b', height: 34 },
    ]);
    expect(viewport.measure([{ key: 'a', height: 60 }], 34).scrollTop).toBe(60);
  });

  it('keeps pinned rows at their original offsets with intervening spacers', () => {
    const viewport = new ProjectTableViewport();
    viewport.replace(
      Array.from({ length: 100 }, (_, index) => ({ key: String(index), height: 34 })),
    );
    const window = viewport.window(1700, 340, ['0', '99']);
    expect(window.segments[0]).toEqual({ index: 0 });
    expect(window.segments[1]).toEqual({ height: 1462 });
    expect(window.segments[window.segments.length - 1]).toEqual({ index: 99 });
    expect(window.segments[window.segments.length - 2]).toEqual({ height: 1156 });
  });

  it('preserves the visible anchor through measured corrections and prunes removed measurements', () => {
    const viewport = new ProjectTableViewport();
    viewport.replace([
      { key: 'a', height: 34 },
      { key: 'b', height: 34 },
      { key: 'c', height: 34 },
    ]);
    expect(viewport.measure([{ key: 'a', height: 60 }], 40).scrollTop).toBe(66);
    expect(viewport.reveal('c', 0, 50)).toBe(78);
    viewport.replace([{ key: 'c', height: 34 }]);
    viewport.replace([
      { key: 'a', height: 34 },
      { key: 'c', height: 34 },
    ]);
    expect(viewport.reveal('c', 0, 50)).toBe(18);
  });

  it('bounds zero-size hosts and ignores zero or invalid measured heights', () => {
    const viewport = new ProjectTableViewport();
    viewport.replace(
      Array.from({ length: 500 }, (_, index) => ({ key: String(index), height: 34 })),
    );
    expect(viewport.window(0, 0, []).end).toBeLessThan(60);
    expect(
      viewport.measure(
        [
          { key: '0', height: 0 },
          { key: '1', height: NaN },
        ],
        0,
      ).scrollTop,
    ).toBe(0);
    expect(viewport.reveal('10', 0, 340)).toBe(34);
    viewport.replace([]);
    expect(viewport.window(999, 0, [])).toMatchObject({ scrollTop: 0, segments: [] });
  });
});
