import { setIcon } from 'obsidian';

interface CardPayload {
  id: string;
  listKey: string;
  groupKey?: string;
}

export interface SettingsCardOptions<T> {
  readonly container: HTMLElement;
  readonly item: T;
  readonly expandedIds: Set<string>;
  readonly id: (item: T) => string;
  readonly listKey: string;
  readonly groupKey?: string;
  readonly draggable?: boolean;
  readonly title?: (item: T) => string;
  readonly renderSummary?: (header: HTMLElement, item: T) => void;
  readonly renderBody: (body: HTMLElement, item: T) => void;
  readonly onReorder?: (draggedId: string, targetId: string) => boolean;
  readonly onCrossGroupDrop?: (draggedId: string, targetGroup: string) => void;
  readonly cardClass?: string;
  readonly toggleClass?: string;
}

export interface SettingsReorderOptions {
  readonly listKey: string;
  readonly groupKey?: string;
  readonly draggable?: boolean;
  readonly onReorder?: (draggedId: string, targetId: string) => boolean;
  readonly onCrossGroupDrop?: (draggedId: string, targetGroup: string) => void;
}

const SETTINGS_CARD_MIME_PREFIX = 'application/x-abyss-settings-card-';
const INTERACTIVE_SELECTOR = 'button, input, select, textarea, a, [contenteditable="true"]';

function dragType(listKey: string): string {
  return `${SETTINGS_CARD_MIME_PREFIX}${listKey.replaceAll(/[^a-z0-9-]/giu, '-')}`.toLowerCase();
}

function payload(value: string): CardPayload | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object') return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record['id'] !== 'string' || typeof record['listKey'] !== 'string') return undefined;
    return {
      id: record['id'],
      listKey: record['listKey'],
      ...(typeof record['groupKey'] === 'string' ? { groupKey: record['groupKey'] } : {}),
    };
  } catch {
    return undefined;
  }
}

function clearDragState(card: HTMLElement): void {
  card.ownerDocument
    .querySelectorAll(
      '[data-settings-item-id].abyss-dragging, [data-settings-item-id].abyss-drag-over',
    )
    .forEach((candidate) => {
      candidate.removeClass('abyss-dragging');
      candidate.removeClass('abyss-drag-over');
    });
}

function moveRenderedCard(target: HTMLElement, sourceId: string): void {
  const source = Array.from(target.parentElement?.children ?? []).find(
    (candidate) => candidate.getAttribute('data-settings-item-id') === sourceId,
  );
  if (source === undefined) return;
  if ((source.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) {
    target.after(source);
  } else target.before(source);
}

function owningSettingsItem(event: Event): Element | null {
  return (event.target as Element | null)?.closest('[data-settings-item-id]') ?? null;
}

function handleGroupDrop(dragged: CardPayload, options: SettingsReorderOptions): boolean {
  if (options.groupKey === undefined || dragged.groupKey === options.groupKey) return false;
  options.onCrossGroupDrop?.(dragged.id, options.groupKey);
  return true;
}

function handleCardDrop(
  event: DragEvent,
  card: HTMLElement,
  id: string,
  options: SettingsReorderOptions,
): void {
  if (owningSettingsItem(event) !== card) return;
  event.preventDefault();
  event.stopPropagation();
  clearDragState(card);
  const dragged = payload(event.dataTransfer?.getData('text/plain') ?? '');
  if (dragged?.listKey !== options.listKey) return;
  if (handleGroupDrop(dragged, options) || dragged.id === id) return;
  if (options.onReorder?.(dragged.id, id) === true) moveRenderedCard(card, dragged.id);
}

export function registerSettingsDragHandlers(
  card: HTMLElement,
  header: HTMLElement,
  id: string,
  options: SettingsReorderOptions,
): void {
  card.addEventListener('dragover', (event) => {
    if (owningSettingsItem(event) !== card) return;
    if (!Array.from(event.dataTransfer?.types ?? []).includes(dragType(options.listKey))) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
    card.addClass('abyss-drag-over');
  });
  card.addEventListener('dragleave', (event) => {
    if (owningSettingsItem(event) !== card) return;
    const OwnerNode = card.ownerDocument.defaultView?.Node;
    const inside = OwnerNode !== undefined && event.relatedTarget instanceof OwnerNode;
    if (inside && card.contains(event.relatedTarget)) return;
    card.removeClass('abyss-drag-over');
  });
  card.addEventListener('drop', (event) => {
    handleCardDrop(event, card, id, options);
  });
  header.addEventListener('dragstart', (event) => {
    if (owningSettingsItem(event) !== card) return;
    event.stopPropagation();
    const interactive = (event.target as Element | null)?.closest(INTERACTIVE_SELECTOR) ?? null;
    if (options.draggable === false || interactive !== null) {
      event.preventDefault();
      return;
    }
    const value: CardPayload = {
      id,
      listKey: options.listKey,
      ...(options.groupKey === undefined ? {} : { groupKey: options.groupKey }),
    };
    if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer?.setData('text/plain', JSON.stringify(value));
    event.dataTransfer?.setData(dragType(options.listKey), '1');
    card.addClass('abyss-dragging');
  });
  header.addEventListener('dragend', (event) => {
    if (owningSettingsItem(event) !== card) return;
    event.stopPropagation();
    clearDragState(card);
  });
}

function cardTitle<T>(options: SettingsCardOptions<T>, id: string): string {
  return options.title?.(options.item) ?? id;
}

function toggleCard<T>(
  card: HTMLElement,
  toggle: HTMLElement,
  id: string,
  options: SettingsCardOptions<T>,
): void {
  const opening = !card.hasClass('is-open');
  card.toggleClass('is-open', opening);
  toggle.empty();
  setIcon(toggle, opening ? 'chevron-down' : 'chevron-right');
  toggle.setAttribute('aria-expanded', String(opening));
  if (opening) {
    options.expandedIds.add(id);
    options.renderBody(card.createDiv({ cls: 'abyss-settings-card-body' }), options.item);
    return;
  }
  options.expandedIds.delete(id);
  card.querySelector(':scope > .abyss-settings-card-body')?.remove();
}

/** Shared collapsible/reorderable settings card used by status, tag, and project property editors. */
export function renderSettingsCard<T>(options: SettingsCardOptions<T>): HTMLElement {
  const id = options.id(options.item);
  const isOpen = options.expandedIds.has(id);
  const extraCardClass = options.cardClass === undefined ? '' : ` ${options.cardClass}`;
  const card = options.container.createDiv({
    cls: `abyss-settings-card${extraCardClass}${isOpen ? ' is-open' : ''}`,
    attr: { 'data-card-id': id, 'data-settings-item-id': id },
  });
  const header = card.createDiv({ cls: 'abyss-settings-card-header' });
  if (options.draggable !== false) header.setAttribute('draggable', 'true');
  registerSettingsDragHandlers(card, header, id, options);
  const grip = header.createSpan({ cls: 'abyss-settings-card-grip' });
  setIcon(grip, options.draggable === false ? 'lock' : 'grip-vertical');
  if (options.renderSummary !== undefined) options.renderSummary(header, options.item);
  else header.createSpan({ cls: 'abyss-settings-card-title', text: cardTitle(options, id) });
  const extraToggleClass = options.toggleClass === undefined ? '' : ` ${options.toggleClass}`;
  const toggle = header.createEl('button', {
    cls: `clickable-icon abyss-settings-card-chevron${extraToggleClass}`,
    attr: {
      type: 'button',
      'aria-label': `Configure ${cardTitle(options, id)}`,
      'aria-expanded': String(isOpen),
    },
  });
  setIcon(toggle, isOpen ? 'chevron-down' : 'chevron-right');
  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleCard(card, toggle, id, options);
  });
  header.addEventListener('click', (event) => {
    if (((event.target as Element | null)?.closest(INTERACTIVE_SELECTOR) ?? null) !== null) return;
    toggleCard(card, toggle, id, options);
  });
  if (isOpen) options.renderBody(card.createDiv({ cls: 'abyss-settings-card-body' }), options.item);
  return card;
}
