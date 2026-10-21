/** Trackpads can report unpressed motion (and capture loss) before the actual pointerup. */
export function isReleasedMousePointer(
  event: Pick<PointerEvent, 'pointerType' | 'buttons'>,
): boolean {
  return event.pointerType === 'mouse' && event.buttons === 0;
}
