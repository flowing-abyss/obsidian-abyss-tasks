import { describe, expect, it } from 'vitest';
import { anchoredPlacement } from '../src/ui/anchoredPlacement';

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return new DOMRect(left, top, width, height);
}

describe('anchoredPlacement', () => {
  it('places a below-start surface at the anchor start when it fits', () => {
    expect(
      anchoredPlacement({
        anchor: rect(50, 20, 20, 10),
        floating: { width: 60, height: 40 },
        boundary: rect(0, 0, 200, 200),
        gap: 4,
        edgeGap: 8,
        preferred: 'below-start',
      }),
    ).toEqual({ left: 50, top: 34, side: 'below' });
  });

  it('places a below-end surface at the anchor end when it fits', () => {
    expect(
      anchoredPlacement({
        anchor: rect(100, 20, 20, 10),
        floating: { width: 60, height: 40 },
        boundary: rect(0, 0, 200, 200),
        gap: 4,
        edgeGap: 8,
        preferred: 'below-end',
      }),
    ).toEqual({ left: 60, top: 34, side: 'below' });
  });

  it('clamps a below-start surface to the left boundary edge', () => {
    expect(
      anchoredPlacement({
        anchor: rect(2, 20, 20, 10),
        floating: { width: 60, height: 40 },
        boundary: rect(0, 0, 200, 200),
        gap: 4,
        edgeGap: 8,
        preferred: 'below-start',
      }),
    ).toEqual({ left: 8, top: 34, side: 'below' });
  });

  it('clamps a below-start surface to the right boundary edge', () => {
    expect(
      anchoredPlacement({
        anchor: rect(180, 20, 20, 10),
        floating: { width: 50, height: 40 },
        boundary: rect(0, 0, 200, 200),
        gap: 4,
        edgeGap: 8,
        preferred: 'below-start',
      }),
    ).toEqual({ left: 142, top: 34, side: 'below' });
  });

  it('flips above when the surface would cross the lower boundary edge', () => {
    expect(
      anchoredPlacement({
        anchor: rect(50, 180, 20, 10),
        floating: { width: 80, height: 40 },
        boundary: rect(0, 0, 200, 220),
        gap: 4,
        edgeGap: 8,
        preferred: 'below-start',
      }),
    ).toEqual({ left: 50, top: 136, side: 'above' });
  });

  it('clamps the surface vertically when neither side has enough room', () => {
    expect(
      anchoredPlacement({
        anchor: rect(50, 50, 20, 10),
        floating: { width: 50, height: 90 },
        boundary: rect(0, 20, 200, 80),
        gap: 4,
        edgeGap: 8,
        preferred: 'below-start',
      }),
    ).toEqual({ left: 50, top: 28, side: 'below' });
  });

  it('prefers the larger lower space when an over-tall surface fits on neither side', () => {
    expect(
      anchoredPlacement({
        anchor: rect(50, 30, 20, 20),
        floating: { width: 80, height: 200 },
        boundary: rect(0, 0, 200, 180),
        gap: 4,
        edgeGap: 8,
        preferred: 'below-start',
      }),
    ).toEqual({ left: 50, top: 8, side: 'below' });
  });

  it.each(['below-start', 'below-end'] as const)(
    'keeps an over-wide %s surface anchored to the left inset',
    (preferred) => {
      expect(
        anchoredPlacement({
          anchor: rect(150, 20, 20, 10),
          floating: { width: 120, height: 40 },
          boundary: rect(100, 0, 100, 200),
          gap: 4,
          edgeGap: 10,
          preferred,
        }),
      ).toEqual({ left: 110, top: 34, side: 'below' });
    },
  );

  it('places a right-end surface past the anchor and level with its bottom', () => {
    expect(
      anchoredPlacement({
        anchor: rect(0, 100, 48, 20),
        floating: { width: 200, height: 80 },
        boundary: rect(0, 0, 400, 400),
        gap: 4,
        edgeGap: 8,
        preferred: 'right-end',
      }),
    ).toEqual({ left: 52, top: 40, side: 'right' });
  });

  it('clamps a right-end surface to the lower boundary edge', () => {
    expect(
      anchoredPlacement({
        anchor: rect(0, 380, 48, 20),
        floating: { width: 200, height: 80 },
        boundary: rect(0, 0, 400, 400),
        gap: 4,
        edgeGap: 8,
        preferred: 'right-end',
      }),
    ).toEqual({ left: 52, top: 312, side: 'right' });
  });

  it('clamps a right-end surface to the upper boundary edge', () => {
    expect(
      anchoredPlacement({
        anchor: rect(0, 10, 48, 20),
        floating: { width: 200, height: 80 },
        boundary: rect(0, 0, 400, 400),
        gap: 4,
        edgeGap: 8,
        preferred: 'right-end',
      }),
    ).toEqual({ left: 52, top: 8, side: 'right' });
  });

  it('keeps an over-wide right-end surface anchored to the left inset', () => {
    expect(
      anchoredPlacement({
        anchor: rect(0, 100, 48, 20),
        floating: { width: 420, height: 80 },
        boundary: rect(0, 0, 400, 400),
        gap: 4,
        edgeGap: 8,
        preferred: 'right-end',
      }),
    ).toEqual({ left: 8, top: 40, side: 'right' });
  });
});
