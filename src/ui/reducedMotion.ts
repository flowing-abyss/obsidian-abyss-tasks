/** The owner window's reduced-motion preference, read now; no window or no `matchMedia` means none. */
export function prefersReducedMotion(ownerWindow: Window | null | undefined): boolean {
  return (
    typeof ownerWindow?.matchMedia === 'function' &&
    ownerWindow.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
