// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LogicalScrollWindow } from '../src/panels/virtualization/logicalScrollWindow';

const total = 1_000_000_000;
const height = 600;
const L = 999_999_400;
const N = 999_400;
describe('logical native scroll window', () => {
  it('reaches both absolute endpoints without a prior far placement', () => {
    const window = new LogicalScrollWindow();
    const initial = window.place(0, total, height);
    window.acknowledge(initial.writeId, 0);
    expect(window.read(N, total, height, 'absolute').logicalTop).toBe(L);
    expect(window.read(0, total, height, 'absolute').logicalTop).toBe(0);
    expect(window.read(N / 2, total, height, 'absolute').logicalTop).toBe(L / 2);
  });
  it('keeps local movement and quantized owned feedback precise', () => {
    const window = new LogicalScrollWindow();
    const middle = window.place(500_000_000, total, height);
    window.acknowledge(middle.writeId, middle.nativeTop);
    const moved = window.read(middle.nativeTop + 120, total, height, 'local');
    expect(moved.logicalTop).toBe(500_000_120);
    const rounded = Math.round(moved.nativeTop * 64) / 64;
    window.acknowledge(moved.writeId, rounded);
    expect(window.read(rounded, total, height, 'owned').logicalTop).toBe(500_000_120);
    const latest = window.place(700_000_000, total, height);
    window.acknowledge(latest.writeId, latest.nativeTop);
    window.acknowledge(moved.writeId, 0);
    expect(window.read(latest.nativeTop + 120, total, height, 'local').logicalTop).toBe(
      700_000_120,
    );
  });
  it.each([
    [120, 120, 0, 0],
    [L - 120, N - 120, N, L],
  ])('retains endpoint apron movement and reversal from %i', (logical, native, end, logicalEnd) => {
    const window = new LogicalScrollWindow();
    const placed = window.place(logical, total, height);
    expect(placed.nativeTop).toBe(native);
    window.acknowledge(placed.writeId, native);
    const moved = window.read(end, total, height, 'local');
    expect(moved.logicalTop).toBe(logicalEnd);
    window.acknowledge(moved.writeId, end);
    expect(window.read(native, total, height, 'local').logicalTop).toBe(logical);
  });
  it('is monotone and continuous across aprons with inverse round trips', () => {
    const window = new LogicalScrollWindow();
    const A = N / 4;
    let previous = -1;
    for (const x of [0, A - 0.01, A, A + 0.01, L / 2, L - A - 0.01, L - A, L - A + 0.01, L]) {
      const placed = window.place(x, total, height);
      expect(placed.nativeTop).toBeGreaterThanOrEqual(previous);
      expect(window.read(placed.nativeTop, total, height, 'absolute').logicalTop).toBeCloseTo(x, 5);
      expect(placed.extent).toBe(1_000_000);
      previous = placed.nativeTop;
    }
  });
  it('uses identity for finite lists and zero for unavailable ranges', () => {
    const window = new LogicalScrollWindow();
    expect(window.place(120.5, 1000, 600)).toMatchObject({
      nativeTop: 120.5,
      logicalTop: 120.5,
      origin: 0,
      extent: 1000,
    });
    expect(window.place(120, 500, 600)).toMatchObject({ nativeTop: 0, logicalTop: 0 });
    expect(window.read(500, total, 1_000_001, 'absolute').logicalTop).toBe(0);
  });
});

it('does not invent unobserved local movement when a native delta hits its bound', () => {
  const window = new LogicalScrollWindow();
  const placed = window.place(L / 2, total, height);
  window.acknowledge(placed.writeId, N / 2);
  expect(window.read(N, total, height, 'local').logicalTop).toBe(L / 2 + N / 2);
});
