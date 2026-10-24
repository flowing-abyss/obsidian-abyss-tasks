const TEXT_LAYOUT = [
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'font-stretch',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-transform',
  'text-indent',
  'text-align',
  'direction',
  'tab-size',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
] as const;

/** Mirror only the active field; no vault text is rendered as HTML or retained in the document. */
export function textFieldAnchor(
  input: HTMLInputElement | HTMLTextAreaElement,
  opener: number,
): DOMRect {
  const owner = input.ownerDocument;
  const win = owner.defaultView;
  if (win === null) return input.getBoundingClientRect();
  const field = input.getBoundingClientRect();
  const style = win.getComputedStyle(input);
  const mirror = owner.body.createDiv({
    cls: 'abyss-text-field-mirror',
    attr: { 'aria-hidden': 'true' },
  });
  mirror.classList.toggle('is-single-line', input.tagName === 'INPUT');
  try {
    for (const property of TEXT_LAYOUT)
      mirror.style.setProperty(property, style.getPropertyValue(property));
    mirror.style.setProperty(
      '--abyss-field-width',
      `${input.clientWidth + pixels(style.borderLeftWidth) + pixels(style.borderRightWidth)}px`,
    );
    const measure = (offset: number): DOMRect => {
      mirror.empty();
      mirror.appendText(input.value.slice(0, offset));
      const remainder = input.value.slice(offset);
      const marker = mirror.createSpan({ text: remainder.length > 0 ? remainder : '\u200b' });
      const range = owner.createRange();
      range.setStart(marker.firstChild ?? marker, 0);
      range.setEnd(marker.firstChild ?? marker, Math.min(1, marker.textContent.length));
      const point = range.getBoundingClientRect();
      const origin = mirror.getBoundingClientRect();
      const line = point.height > 0 ? point.height : fallbackLineHeight(style);
      const vertical = inputLineOffset(input, style, line);
      return new win.DOMRect(
        field.left + point.left - origin.left - input.scrollLeft,
        field.top + point.top - origin.top - input.scrollTop + vertical,
        Math.max(1, point.width),
        line,
      );
    };
    const start = measure(opener);
    const visible = insideField(start, field);
    const point = visible ? start : measure(input.selectionStart ?? input.value.length);
    return new win.DOMRect(
      Math.max(field.left, Math.min(point.left, field.right)),
      Math.max(field.top, Math.min(point.top, Math.max(field.top, field.bottom - point.height))),
      1,
      Math.min(point.height, field.height > 0 ? field.height : point.height),
    );
  } finally {
    mirror.remove();
  }
}

function pixels(value: string): number {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
function fallbackLineHeight(style: CSSStyleDeclaration): number {
  const line = pixels(style.lineHeight);
  return line > 0 ? line : Math.max(20, pixels(style.fontSize) * 1.2);
}
function inputLineOffset(input: HTMLElement, style: CSSStyleDeclaration, line: number): number {
  if (input.tagName !== 'INPUT') return 0;
  return Math.max(
    0,
    (input.clientHeight - pixels(style.paddingTop) - pixels(style.paddingBottom) - line) / 2,
  );
}
function insideField(point: DOMRect, field: DOMRect): boolean {
  return (
    point.left >= field.left &&
    point.right <= field.right &&
    point.top >= field.top &&
    point.bottom <= field.bottom
  );
}

/** Optional owned scroll containers also clip hosts whose keyboard leaves VisualViewport intact. */
export function textFieldViewport(
  input: HTMLElement,
  containers?: readonly HTMLElement[],
): DOMRect {
  const win = input.ownerDocument.defaultView;
  if (win === null) return input.getBoundingClientRect();
  const viewport = win.visualViewport;
  const visible = new win.DOMRect(
    viewport?.offsetLeft ?? 0,
    viewport?.offsetTop ?? 0,
    viewport?.width ?? win.innerWidth,
    viewport?.height ?? win.innerHeight,
  );
  return clipToContainers(visible, containers);
}

function clipToContainers(visible: DOMRect, containers: readonly HTMLElement[] = []): DOMRect {
  let { left, top, right, bottom } = visible;
  for (const container of containers) {
    const rect = container.getBoundingClientRect();
    left = Math.max(left, rect.left);
    top = Math.max(top, rect.top);
    right = Math.min(right, rect.right);
    bottom = Math.min(bottom, rect.bottom);
  }
  visible.x = left;
  visible.y = top;
  visible.width = Math.max(0, right - left);
  visible.height = Math.max(0, bottom - top);
  return visible;
}
