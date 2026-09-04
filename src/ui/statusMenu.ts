import { Component, setIcon, type Menu } from 'obsidian';
import { PRIORITY_LEVELS } from '../priority';
import type { StatusRegistry } from '../status/StatusRegistry';
import type { SubtaskSnapshot, TaskPriority, TaskSnapshot } from '../tasks';
import { renderStatusMarker } from './StatusMarker';
import { noInteractionOwnership, type InteractionOwnershipPort } from './interactionOwnership';

export interface StatusMenuOpts {
  task: TaskSnapshot | SubtaskSnapshot;
  registry: StatusRegistry;
  onPickStatus: (char: string) => void;
  onPickPriority: (p: TaskPriority) => void;
  /** Consumer lifetime that owns this body-mounted surface. */
  owner?: Component;
  /** Notifies a retaining consumer after this handle has fully closed, exactly once. */
  onClose?: () => void;
  /** Panel-owned shortcut blocker; standalone consumers may omit it. */
  interactionOwnership?: InteractionOwnershipPort;
}

export interface StatusMenuHandle {
  readonly element: HTMLElement;
  close(options?: { restoreFocus?: boolean }): void;
}

const PRIORITY_OPTIONS: Array<{ p: TaskPriority; label: string }> = PRIORITY_LEVELS.map((l) => ({
  p: l.value,
  label: l.label,
}));
const statusPopoverClose = new WeakMap<HTMLElement, () => void>();

export function registerStatusPopoverClose(element: HTMLElement, close: () => void): () => void {
  statusPopoverClose.set(element, close);
  let registered = true;
  return (): void => {
    if (!registered) return;
    registered = false;
    if (statusPopoverClose.get(element) === close) statusPopoverClose.delete(element);
  };
}

export function closeStatusPopovers(ownerDocument: Document): void {
  ownerDocument.querySelectorAll<HTMLElement>('.abyss-status-popover').forEach((element) => {
    const closeExisting = statusPopoverClose.get(element);
    if (closeExisting != null) closeExisting();
    else element.remove();
  });
}

/**
 * Adds the status items (grouped by open/in-progress/done/cancelled) to `sub`,
 * one `setSection(group.type)` group per status type, current status checked.
 * Relies on Obsidian's native section dividers (no text group-header items —
 * those read as redundant noise next to the divider Obsidian already draws).
 */
export function buildStatusSubmenu(
  sub: Menu,
  task: TaskSnapshot | SubtaskSnapshot,
  registry: StatusRegistry,
  onPickStatus: (char: string) => void,
): void {
  for (const group of registry.grouped()) {
    for (const def of group.statuses) {
      sub.addItem((i) => {
        i.setTitle(def.name)
          .setSection(group.type)
          .setChecked(task.statusSymbol === def.symbol)
          .onClick(() => {
            onPickStatus(def.symbol);
          });

        // Match the popover's visual language: a shape-marker (not a bare
        // setIcon check/x) in the item's icon slot. Reach the native item's
        // undocumented `.dom` the same way applyPriorityFlagColor does for
        // priority flags.
        const dom = (i as unknown as { dom?: HTMLElement }).dom;
        if (dom != null) {
          const iconEl = dom.querySelector('.menu-item-icon');
          if (iconEl instanceof HTMLElement) {
            iconEl.empty();
            renderStatusMarker(iconEl, {
              task: { statusSymbol: def.symbol, priority: 'D' },
              registry,
              interactive: false,
              onLeftClick: () => {},
              onContextMenu: () => {},
            });
          }
        }
        return i;
      });
    }
  }
}

/**
 * Clamps a popover positioned at the mouse event's viewport coordinates so it
 * never overflows the window, then applies it as `position: fixed` coords.
 */
function positionPopoverAt(pop: HTMLElement, ev: MouseEvent): void {
  const ownerWindow = pop.ownerDocument.defaultView ?? window;
  const margin = 8;
  // Measure after appending (offsetWidth/Height are 0 before layout).
  const width = pop.offsetWidth;
  const height = pop.offsetHeight;
  const maxLeft = Math.max(margin, ownerWindow.innerWidth - width - margin);
  const maxTop = Math.max(margin, ownerWindow.innerHeight - height - margin);
  const left = Math.min(Math.max(ev.clientX, margin), maxLeft);
  const top = Math.min(Math.max(ev.clientY, margin), maxTop);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

interface StatusPopoverLifecycleOptions {
  readonly popover: HTMLElement;
  readonly trigger: HTMLElement | null;
  readonly owner: Component | undefined;
  readonly onClose: (() => void) | undefined;
  readonly ownershipToken: { release(): void };
}

class StatusPopoverLifecycle {
  private readonly ownerDocument: Document;
  private readonly ownerWindow: Window;
  private dismissTimer: number | undefined;
  private dismissListening = false;
  private closed = false;
  private ownerLifetime: Component | null = null;
  private unregisterPopover = (): void => undefined;

  constructor(private readonly options: StatusPopoverLifecycleOptions) {
    this.ownerDocument = options.popover.ownerDocument;
    this.ownerWindow = this.ownerDocument.defaultView ?? window;
  }

  initialize(): void {
    this.unregisterPopover = registerStatusPopoverClose(this.options.popover, this.close);
    const { owner } = this.options;
    if (owner == null) return;
    const lifetime = new Component();
    lifetime.register(() => {
      if (this.ownerLifetime === lifetime) this.ownerLifetime = null;
      this.close();
    });
    this.ownerLifetime = owner.addChild(lifetime);
  }

  armDismissal(): void {
    this.dismissTimer = this.ownerWindow.setTimeout(() => {
      this.dismissTimer = undefined;
      if (this.closed || !this.options.popover.isConnected) return;
      this.ownerDocument.addEventListener('mousedown', this.onOutside, true);
      this.ownerDocument.addEventListener('keydown', this.onKey, true);
      this.dismissListening = true;
    }, 0);
  }

  readonly close = (restoreFocus = false): void => {
    if (this.closed) return;
    this.closed = true;
    this.clearDismissal();
    this.options.popover.remove();
    this.unregisterPopover();
    const lifetime = this.ownerLifetime;
    this.ownerLifetime = null;
    if (lifetime != null) this.options.owner?.removeChild(lifetime);
    const { trigger } = this.options;
    if (restoreFocus && trigger?.isConnected === true) trigger.focus({ preventScroll: true });
    this.options.ownershipToken.release();
    this.options.onClose?.();
  };

  private clearDismissal(): void {
    if (this.dismissTimer !== undefined) this.ownerWindow.clearTimeout(this.dismissTimer);
    if (!this.dismissListening) return;
    this.ownerDocument.removeEventListener('mousedown', this.onOutside, true);
    this.ownerDocument.removeEventListener('keydown', this.onKey, true);
  }

  private readonly onOutside = (event: MouseEvent): void => {
    if (!this.options.popover.contains(event.target as Node)) this.close();
  };

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    this.close(true);
  };
}

function eventDocumentAndTrigger(event: MouseEvent): {
  readonly document: Document;
  readonly trigger: HTMLElement | null;
} {
  const target = event.currentTarget ?? event.target;
  const document =
    (target != null && 'ownerDocument' in target ? (target as Node).ownerDocument : null) ??
    activeDocument;
  const trigger =
    target != null && typeof (target as HTMLElement).focus === 'function' && 'isConnected' in target
      ? (target as HTMLElement)
      : null;
  return { document, trigger };
}

function renderPriorityRow(
  popover: HTMLElement,
  task: TaskSnapshot | SubtaskSnapshot,
  onPickPriority: (priority: TaskPriority) => void,
  close: () => void,
): HTMLElement {
  const row = popover.createDiv({
    cls: 'abyss-status-popover-priority-row',
    attr: { role: 'group', 'aria-label': 'Priority' },
  });
  for (const option of PRIORITY_OPTIONS) {
    const active = task.priority === option.p;
    const button = row.createEl('button', {
      cls: `abyss-status-popover-flag${active ? ' is-active' : ''}`,
      attr: {
        'data-abyss-priority': option.p,
        'aria-label': option.label,
        role: 'menuitemradio',
        'aria-checked': String(active),
        title: option.label,
      },
    });
    setIcon(button, 'flag');
    button.addEventListener('click', () => {
      onPickPriority(option.p);
      close();
    });
  }
  return row;
}

interface StatusRowOptions {
  readonly list: HTMLElement;
  readonly task: TaskSnapshot | SubtaskSnapshot;
  readonly registry: StatusRegistry;
  readonly definition: ReturnType<StatusRegistry['grouped']>[number]['statuses'][number];
  readonly onPickStatus: (symbol: string) => void;
  readonly close: () => void;
}

function renderStatusRow(options: StatusRowOptions): void {
  const row = options.list.createDiv({ cls: 'abyss-status-popover-row' });
  const current = options.task.statusSymbol === options.definition.symbol;
  row.setAttrs({ role: 'menuitemradio', tabindex: '0', 'aria-checked': String(current) });
  renderStatusMarker(row, {
    task: { statusSymbol: options.definition.symbol, priority: 'D' },
    registry: options.registry,
    interactive: false,
    onLeftClick: () => {},
    onContextMenu: () => {},
  });
  row.createSpan({ cls: 'abyss-status-popover-name', text: options.definition.name });
  if (current) {
    row.addClass('is-current');
    setIcon(row.createSpan({ cls: 'abyss-status-popover-check' }), 'check');
  }
  const pickStatus = (): void => {
    options.onPickStatus(options.definition.symbol);
    options.close();
  };
  row.addEventListener('click', pickStatus);
  row.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    pickStatus();
  });
}

function renderStatusList(popover: HTMLElement, options: StatusMenuOpts, close: () => void): void {
  const list = popover.createDiv({ cls: 'abyss-status-popover-list' });
  const groups = options.registry.grouped();
  groups.forEach((group, groupIndex) => {
    for (const definition of group.statuses) {
      renderStatusRow({
        list,
        task: options.task,
        registry: options.registry,
        definition,
        onPickStatus: options.onPickStatus,
        close,
      });
    }
    if (groupIndex < groups.length - 1) {
      list.createDiv({ cls: 'abyss-status-popover-divider' });
    }
  });
}

/**
 * Opens the combined priority+status popover at the mouse event's position:
 * a horizontal row of colored priority flags, a divider, then the status list
 * (grouped by open/in-progress/done/cancelled, groups separated by thin
 * dividers — no text group headers). Appended to `document.body` so it can
 * float above any panel; dismissed on outside click, Escape, or after a pick.
 */
export function showStatusMenuAt(ev: MouseEvent, opts: StatusMenuOpts): StatusMenuHandle {
  const { document, trigger } = eventDocumentAndTrigger(ev);
  closeStatusPopovers(document);
  const popover = document.body.createDiv({ cls: 'abyss-status-popover' });
  const lifecycle = new StatusPopoverLifecycle({
    popover,
    trigger,
    owner: opts.owner,
    onClose: opts.onClose,
    ownershipToken: (opts.interactionOwnership ?? noInteractionOwnership).acquire({
      blocksShortcuts: true,
    }),
  });
  lifecycle.initialize();
  popover.setAttrs({ role: 'menu', 'aria-label': 'Task status and priority' });
  const priorityRow = renderPriorityRow(popover, opts.task, opts.onPickPriority, lifecycle.close);
  popover.createDiv({ cls: 'abyss-status-popover-divider' });
  renderStatusList(popover, opts, lifecycle.close);
  positionPopoverAt(popover, ev);
  priorityRow.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  lifecycle.armDismissal();
  return {
    element: popover,
    close: (options) => {
      lifecycle.close(options?.restoreFocus === true);
    },
  };
}
