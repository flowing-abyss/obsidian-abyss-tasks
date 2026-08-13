import { renderCalendarLeadingSlots } from './renderTaskMeta';

export interface CalendarTimedContent {
  readonly timeLabel: string;
  readonly title: string;
  readonly recurrence?: string;
  readonly actionable: boolean;
  readonly countLabel?: string;
}

interface CalendarTimedRenderHooks {
  readonly forecast?: boolean;
  readonly renderControl?: (row: HTMLElement) => void;
  readonly renderCounts?: (row: HTMLElement) => void;
  readonly renderTitle?: (row: HTMLElement) => void;
}

export interface CalendarPreviewContent {
  readonly title: string;
  readonly subtitle?: string;
  readonly timed?: CalendarTimedContent;
  readonly density: 'regular';
  readonly phase: 'ghost' | 'terminal';
}

const COPIED_COLOR_PROPERTIES = ['--tc-tag-color', '--tc-tag-text-color'] as const;

function appendElement<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tagName: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = parent.ownerDocument.createElement(tagName);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  parent.appendChild(element);
  return element;
}

/**
 * Canonical two-row presentation shared by committed timed blocks and their transient overlays.
 * Hooks preserve the committed surface's rich Markdown/status/count renderers; the default path is
 * deliberately inert and is used by previews.
 */
export function renderTimedContent(
  container: HTMLElement,
  content: CalendarTimedContent,
  hooks: CalendarTimedRenderHooks = {},
): void {
  const topRow = appendElement(container, 'div', 'tc-tg-block-toprow');
  appendElement(topRow, 'div', 'tc-tg-block-subtitle', content.timeLabel);
  if (content.countLabel) {
    const counts = appendElement(topRow, 'div', 'tc-tg-block-badges');
    if (hooks.renderCounts) hooks.renderCounts(counts);
    else appendElement(counts, 'span', '', content.countLabel);
  }

  const head = appendElement(container, 'div', 'tc-tg-block-head');
  renderCalendarLeadingSlots(
    head,
    content.recurrence,
    hooks.forecast ?? false,
    content.actionable ? hooks.renderControl : undefined,
  );
  if (hooks.renderTitle) hooks.renderTitle(head);
  else {
    appendElement(
      head,
      'span',
      'tc-tg-block-title tc-calendar-title tc-calendar-preview-title',
      content.title,
    );
  }
}

function stripPreviewInteractivity(root: HTMLElement): void {
  for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]) {
    element.removeAttribute('tabindex');
    element.removeAttribute('role');
    element.removeAttribute('aria-checked');
    element.removeAttribute('aria-label');
    element.removeAttribute('draggable');
  }
  root.classList.add('tc-status-marker--inert');
}

function renderPreviewTimedContent(
  shell: HTMLElement,
  source: HTMLElement,
  content: CalendarTimedContent,
): void {
  const sourceMarker = source.querySelector<HTMLElement>('.tc-tg-block-head .tc-status-marker');
  const sourceCounts = source.querySelector<HTMLElement>('.tc-tg-block-toprow .tc-tg-block-badges');
  const forecast =
    source.dataset['occurrenceState'] === 'forecast' ||
    source.querySelector('.tc-recurrence-badge[data-recurrence-forecast="true"]') !== null;
  renderTimedContent(shell, content, {
    forecast,
    ...(sourceMarker && content.actionable
      ? {
          renderControl: (row: HTMLElement) => {
            const marker = sourceMarker.cloneNode(true) as HTMLElement;
            stripPreviewInteractivity(marker);
            row.appendChild(marker);
          },
        }
      : {}),
    ...(sourceCounts && content.countLabel
      ? {
          renderCounts: (row: HTMLElement) => {
            for (const child of Array.from(sourceCounts.children)) {
              row.appendChild(child.cloneNode(true));
            }
          },
        }
      : {}),
  });
}

function updateStableTimedContent(
  shell: HTMLElement,
  source: HTMLElement,
  content: CalendarTimedContent,
): boolean {
  const topRow = shell.querySelector<HTMLElement>(':scope > .tc-tg-block-toprow');
  const head = shell.querySelector<HTMLElement>(':scope > .tc-tg-block-head');
  if (!topRow || !head) return false;
  const markerPresent = head.querySelector('.tc-status-marker') !== null;
  const sourceMarkerPresent =
    source.querySelector('.tc-tg-block-head .tc-status-marker') !== null && content.actionable;
  const recurrencePresent = head.querySelector('.tc-recurrence-badge') !== null;
  if (markerPresent !== sourceMarkerPresent || recurrencePresent !== Boolean(content.recurrence)) {
    return false;
  }
  const subtitle = topRow.querySelector<HTMLElement>('.tc-tg-block-subtitle');
  const title = head.querySelector<HTMLElement>('.tc-calendar-title');
  if (!subtitle || !title) return false;
  subtitle.textContent = content.timeLabel;
  title.textContent = content.title;
  return true;
}

export function populateCalendarPreview(
  preview: HTMLElement,
  source: HTMLElement,
  content: CalendarPreviewContent,
): void {
  preview.classList.add('tc-calendar-preview');
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

  const existingShell = preview.querySelector<HTMLElement>(':scope > .tc-calendar-preview-shell');
  if (
    content.timed &&
    existingShell &&
    updateStableTimedContent(existingShell, source, content.timed)
  ) {
    return;
  }

  preview.replaceChildren();
  const targetOutline = preview.ownerDocument.createElement('div');
  targetOutline.className = 'tc-calendar-preview-target-outline';
  preview.appendChild(targetOutline);

  const shell = preview.ownerDocument.createElement('div');
  shell.className = 'tc-calendar-preview-shell';
  preview.appendChild(shell);

  if (content.timed) {
    renderPreviewTimedContent(shell, source, content.timed);
    return;
  }

  const title = preview.ownerDocument.createElement('span');
  title.className = 'tc-calendar-preview-title';
  title.textContent = content.title;
  shell.appendChild(title);

  if (content.subtitle) {
    const subtitle = preview.ownerDocument.createElement('span');
    subtitle.className = 'tc-calendar-preview-subtitle';
    subtitle.textContent = content.subtitle;
    shell.appendChild(subtitle);
  }
}
