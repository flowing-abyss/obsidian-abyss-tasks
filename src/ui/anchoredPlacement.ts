export interface AnchoredPlacementInput {
  readonly anchor: DOMRect;
  readonly floating: { readonly width: number; readonly height: number };
  readonly boundary: DOMRect;
  readonly gap: number;
  readonly edgeGap: number;
  readonly preferred: 'below-start' | 'below-end' | 'right-end';
}

export interface AnchoredPlacement {
  readonly left: number;
  readonly top: number;
  readonly side: 'above' | 'below' | 'right';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** The horizontal inset a surface of this width has to stay inside. */
function leftBounds(input: AnchoredPlacementInput): { min: number; max: number } {
  return {
    min: input.boundary.left + input.edgeGap,
    max: input.boundary.right - input.edgeGap - input.floating.width,
  };
}

export function anchoredPlacement(input: AnchoredPlacementInput): AnchoredPlacement {
  const horizontal = leftBounds(input);
  if (input.preferred === 'right-end') return besideAnchor(input, horizontal);
  const preferredLeft =
    input.preferred === 'below-start'
      ? input.anchor.left
      : input.anchor.right - input.floating.width;
  const left = clamp(preferredLeft, horizontal.min, horizontal.max);

  const belowTop = input.anchor.bottom + input.gap;
  const maxBottom = input.boundary.bottom - input.edgeGap;
  const minTop = input.boundary.top + input.edgeGap;
  const below = maxBottom - belowTop;
  const above = input.anchor.top - input.gap - minTop;
  const side =
    input.floating.height <= below || (input.floating.height > above && below > above)
      ? 'below'
      : 'above';
  const preferredTop =
    side === 'below' ? belowTop : input.anchor.top - input.gap - input.floating.height;
  const maxTop = maxBottom - input.floating.height;
  const top = clamp(preferredTop, minTop, maxTop);

  return { left, top, side };
}

/**
 * A surface that opens out of the side of a narrow anchor instead of under it, with its own end
 * level with the anchor's. It never flips: the rail it grows out of has the whole panel beside it,
 * so the boundary clamp is the only adjustment such a surface can need.
 */
function besideAnchor(
  input: AnchoredPlacementInput,
  horizontal: { min: number; max: number },
): AnchoredPlacement {
  const minTop = input.boundary.top + input.edgeGap;
  const maxTop = input.boundary.bottom - input.edgeGap - input.floating.height;
  return {
    left: clamp(input.anchor.right + input.gap, horizontal.min, horizontal.max),
    top: clamp(input.anchor.bottom - input.floating.height, minTop, maxTop),
    side: 'right',
  };
}
