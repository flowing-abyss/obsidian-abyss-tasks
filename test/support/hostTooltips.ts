export function accessibleName(element: HTMLElement): string | null {
  const label = element.getAttribute('aria-labelledby');
  return label === null
    ? element.getAttribute('aria-label')
    : (element.ownerDocument.getElementById(label)?.textContent ?? null);
}
