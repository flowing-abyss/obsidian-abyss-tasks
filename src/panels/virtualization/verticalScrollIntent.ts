/** Prepare the active viewport before its first vertical wheel step or single-finger swipe. */
export function onVerticalScrollIntent(scroll: HTMLElement, prepare: () => void): () => void {
  let start: { x: number; y: number } | undefined;
  const wheel = (event: WheelEvent): void => {
    if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    consume();
  };
  const touchStart = (event: TouchEvent): void => {
    const touch = event.touches[0];
    start =
      touch !== undefined && event.touches.length === 1
        ? { x: touch.clientX, y: touch.clientY }
        : undefined;
  };
  const touchMove = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (start === undefined || touch === undefined || event.touches.length !== 1) return;
    const dy = Math.abs(touch.clientY - start.y);
    if (dy >= 4 && dy > Math.abs(touch.clientX - start.x)) consume();
  };
  function dispose(): void {
    scroll.removeEventListener('wheel', wheel);
    scroll.removeEventListener('touchstart', touchStart);
    scroll.removeEventListener('touchmove', touchMove);
  }
  function consume(): void {
    dispose();
    prepare();
  }
  scroll.addEventListener('wheel', wheel, { passive: true });
  scroll.addEventListener('touchstart', touchStart, { passive: true });
  scroll.addEventListener('touchmove', touchMove, { passive: true });
  return dispose;
}
