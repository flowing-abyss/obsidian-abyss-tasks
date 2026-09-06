export interface AnchoredPlacementInput {
  readonly anchor: DOMRect;
  readonly floating: { readonly width: number; readonly height: number };
  readonly boundary: DOMRect;
  readonly gap: number;
  readonly edgeGap: number;
  readonly preferred: 'below-start' | 'below-end';
}

export interface AnchoredPlacement {
  readonly left: number;
  readonly top: number;
  readonly side: 'above' | 'below';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function anchoredPlacement(input: AnchoredPlacementInput): AnchoredPlacement {
  const minLeft = input.boundary.left + input.edgeGap;
  const maxLeft = input.boundary.right - input.edgeGap - input.floating.width;
  const preferredLeft =
    input.preferred === 'below-start'
      ? input.anchor.left
      : input.anchor.right - input.floating.width;
  const left = clamp(preferredLeft, minLeft, maxLeft);

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
