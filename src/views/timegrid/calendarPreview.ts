export interface CalendarPreviewContent {
  readonly title: string;
  readonly subtitle?: string;
  readonly time?: string;
  readonly density: 'regular';
  readonly phase: 'ghost' | 'terminal';
}

const COPIED_COLOR_PROPERTIES = ['--tc-tag-color', '--tc-tag-text-color'] as const;

export function populateCalendarPreview(
  preview: HTMLElement,
  source: HTMLElement,
  content: CalendarPreviewContent,
): void {
  preview.replaceChildren();
  preview.setAttribute('aria-hidden', 'true');
  preview.removeAttribute('tabindex');
  preview.removeAttribute('draggable');
  delete preview.dataset['activeResize'];
  preview.classList.remove('is-picked-up', 'is-dragging', 'is-selected', 'is-edge-resizing');
  preview.dataset['density'] = content.density;
  preview.dataset['phase'] = content.phase;

  for (const property of COPIED_COLOR_PROPERTIES) {
    const value = source.style.getPropertyValue(property);
    if (value) preview.style.setProperty(property, value);
    else preview.style.removeProperty(property);
  }

  const title = preview.ownerDocument.createElement('span');
  title.className = 'tc-calendar-preview-title';
  title.textContent = content.title;
  preview.appendChild(title);

  if (content.subtitle) {
    const subtitle = preview.ownerDocument.createElement('span');
    subtitle.className = 'tc-calendar-preview-subtitle';
    subtitle.textContent = content.subtitle;
    preview.appendChild(subtitle);
  }

  if (content.time) {
    const time = preview.ownerDocument.createElement('span');
    time.className = 'tc-calendar-preview-time';
    time.textContent = content.time;
    preview.appendChild(time);
  }
}
