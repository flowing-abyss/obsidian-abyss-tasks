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

const COPIED_COLOR_PROPERTIES = ['--abyss-tag-color', '--abyss-tag-text-color'] as const;

function appendElement<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tagName: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = parent.ownerDocument.createElementNS(
    'http://www.w3.org/1999/xhtml',
    tagName,
  ) as HTMLElementTagNameMap[K];
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
  const topRow = appendElement(container, 'div', 'abyss-tg-block-toprow');
  appendElement(topRow, 'div', 'abyss-tg-block-subtitle', content.timeLabel);
  if (content.countLabel !== undefined && content.countLabel.length > 0) {
    const counts = appendElement(topRow, 'div', 'abyss-tg-block-badges');
    if (hooks.renderCounts != null) hooks.renderCounts(counts);
    else appendElement(counts, 'span', '', content.countLabel);
  }

  const head = appendElement(container, 'div', 'abyss-tg-block-head');
  renderCalendarLeadingSlots(
    head,
    content.recurrence,
    hooks.forecast ?? false,
    content.actionable ? hooks.renderControl : undefined,
  );
  if (hooks.renderTitle != null) hooks.renderTitle(head);
  else {
    appendElement(
      head,
      'span',
      'abyss-tg-block-title abyss-calendar-title abyss-calendar-preview-title',
      content.title,
    );
  }
}

function copyPreviewColors(preview: HTMLElement, source: HTMLElement): void {
  for (const property of COPIED_COLOR_PROPERTIES) {
    const value = source.style.getPropertyValue(property);
    if (value.length > 0) preview.style.setProperty(property, value);
    else preview.style.removeProperty(property);
  }
}

function renderUntimedPreview(shell: HTMLElement, content: CalendarPreviewContent): void {
  appendElement(shell, 'span', 'abyss-calendar-preview-title', content.title);
  if (content.subtitle !== undefined && content.subtitle.length > 0) {
    appendElement(shell, 'span', 'abyss-calendar-preview-subtitle', content.subtitle);
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
  root.classList.add('abyss-status-marker--inert');
}

function renderPreviewTimedContent(
  shell: HTMLElement,
  source: HTMLElement,
  content: CalendarTimedContent,
): void {
  const sourceMarker = source.querySelector<HTMLElement>(
    '.abyss-tg-block-head .abyss-status-marker',
  );
  const sourceCounts = source.querySelector<HTMLElement>(
    '.abyss-tg-block-toprow .abyss-tg-block-badges',
  );
  const forecast =
    source.dataset['occurrenceState'] === 'forecast' ||
    source.querySelector('.abyss-recurrence-badge[data-recurrence-forecast="true"]') !== null;
  renderTimedContent(shell, content, {
    forecast,
    ...(sourceMarker != null && content.actionable
      ? {
          renderControl: (row: HTMLElement) => {
            const marker = sourceMarker.cloneNode(true) as HTMLElement;
            stripPreviewInteractivity(marker);
            row.appendChild(marker);
          },
        }
      : {}),
    ...(sourceCounts != null && Boolean(content.countLabel)
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
  const topRow = shell.querySelector<HTMLElement>(':scope > .abyss-tg-block-toprow');
  const head = shell.querySelector<HTMLElement>(':scope > .abyss-tg-block-head');
  if (topRow == null || head == null) return false;
  const markerPresent = head.querySelector('.abyss-status-marker') !== null;
  const sourceMarkerPresent =
    source.querySelector('.abyss-tg-block-head .abyss-status-marker') !== null &&
    content.actionable;
  const recurrencePresent = head.querySelector('.abyss-recurrence-badge') !== null;
  if (markerPresent !== sourceMarkerPresent || recurrencePresent !== Boolean(content.recurrence)) {
    return false;
  }
  const subtitle = topRow.querySelector<HTMLElement>('.abyss-tg-block-subtitle');
  const title = head.querySelector<HTMLElement>('.abyss-calendar-title');
  if (subtitle == null || title == null) return false;
  subtitle.textContent = content.timeLabel;
  title.textContent = content.title;
  return true;
}

export function populateCalendarPreview(
  preview: HTMLElement,
  source: HTMLElement,
  content: CalendarPreviewContent,
): void {
  preview.classList.add('abyss-calendar-preview');
  preview.setAttribute('aria-hidden', 'true');
  preview.removeAttribute('tabindex');
  preview.removeAttribute('draggable');
  delete preview.dataset['activeResize'];
  preview.classList.remove('is-picked-up', 'is-dragging', 'is-selected', 'is-edge-resizing');
  preview.dataset['density'] = content.density;
  preview.dataset['phase'] = content.phase;

  copyPreviewColors(preview, source);

  const existingShell = preview.querySelector<HTMLElement>(
    ':scope > .abyss-calendar-preview-shell',
  );
  if (
    content.timed != null &&
    existingShell != null &&
    updateStableTimedContent(existingShell, source, content.timed)
  ) {
    return;
  }

  preview.replaceChildren();
  appendElement(preview, 'div', 'abyss-calendar-preview-target-outline');
  const shell = appendElement(preview, 'div', 'abyss-calendar-preview-shell');

  if (content.timed != null) {
    renderPreviewTimedContent(shell, source, content.timed);
    return;
  }

  renderUntimedPreview(shell, content);
}
