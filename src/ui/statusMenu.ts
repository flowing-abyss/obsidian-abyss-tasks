import { Component, setIcon, type Menu } from 'obsidian';
import { PRIORITY_LEVELS } from '../priority';
import type { StatusRegistry } from '../status/StatusRegistry';
import type { SubtaskSnapshot, TaskPriority, TaskSnapshot } from '../tasks';
import { recurrenceBadgeInput, renderRecurrenceBadge } from './recurrence/renderRecurrenceBadge';
import { renderStatusMarker } from './StatusMarker';

export interface StatusMenuOpts {
  task: TaskSnapshot | SubtaskSnapshot;
  registry: StatusRegistry;
  onPickStatus: (char: string) => void;
  onPickPriority: (p: TaskPriority) => void;
  onEditRepeat?: () => void;
  /** Consumer lifetime that owns this body-mounted surface. */
  owner?: Component;
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
          .onClick(() => onPickStatus(def.symbol));

        // Match the popover's visual language: a shape-marker (not a bare
        // setIcon check/x) in the item's icon slot. Reach the native item's
        // undocumented `.dom` the same way applyPriorityFlagColor does for
        // priority flags.
        const dom = (i as unknown as { dom?: HTMLElement }).dom;
        if (dom) {
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

/**
 * Opens the combined priority+status popover at the mouse event's position:
 * a horizontal row of colored priority flags, a divider, then the status list
 * (grouped by open/in-progress/done/cancelled, groups separated by thin
 * dividers — no text group headers). Appended to `document.body` so it can
 * float above any panel; dismissed on outside click, Escape, or after a pick.
 */
export function showStatusMenuAt(ev: MouseEvent, opts: StatusMenuOpts): StatusMenuHandle {
  const { task, registry, onPickStatus, onPickPriority, onEditRepeat, owner } = opts;
  const eventTarget = ev.currentTarget ?? ev.target;
  const targetDocument =
    eventTarget && 'ownerDocument' in eventTarget ? (eventTarget as Node).ownerDocument : null;
  const eventDocument = targetDocument ?? activeDocument;
  const trigger =
    eventTarget &&
    typeof (eventTarget as HTMLElement).focus === 'function' &&
    'isConnected' in eventTarget
      ? (eventTarget as HTMLElement)
      : null;

  // Only one status popover at a time.
  eventDocument.querySelectorAll<HTMLElement>('.tc-status-popover').forEach((element) => {
    const closeExisting = statusPopoverClose.get(element);
    if (closeExisting) closeExisting();
    else element.remove();
  });

  const pop = eventDocument.body.createDiv({ cls: 'tc-status-popover' });
  const ownerDocument = pop.ownerDocument;
  const ownerWindow = ownerDocument.defaultView ?? window;
  let dismissTimer: number | undefined;
  let dismissListening = false;
  let closed = false;
  let ownerLifetime: Component | null = null;

  const close = (restoreFocus = false): void => {
    if (closed) return;
    closed = true;
    if (dismissTimer !== undefined) ownerWindow.clearTimeout(dismissTimer);
    if (dismissListening) {
      ownerDocument.removeEventListener('mousedown', onOutside, true);
      ownerDocument.removeEventListener('keydown', onKey, true);
    }
    pop.remove();
    statusPopoverClose.delete(pop);
    const lifetime = ownerLifetime;
    ownerLifetime = null;
    if (lifetime) owner?.removeChild(lifetime);
    if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
  };
  const onOutside = (e: MouseEvent): void => {
    if (!pop.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    close(true);
  };
  statusPopoverClose.set(pop, close);
  if (owner) {
    const lifetime = new Component();
    lifetime.register(() => {
      if (ownerLifetime === lifetime) ownerLifetime = null;
      close();
    });
    ownerLifetime = owner.addChild(lifetime);
  }

  pop.setAttrs({ role: 'menu', 'aria-label': 'Task status and priority' });

  // ── Priority row ──────────────────────────────────────────
  const priorityRow = pop.createDiv({ cls: 'tc-status-popover-priority-row' });
  const currentPriority = task.priority ?? 'D';
  for (const opt of PRIORITY_OPTIONS) {
    const btn = priorityRow.createEl('button', {
      cls: `tc-status-popover-flag${currentPriority === opt.p ? ' is-active' : ''}`,
      attr: {
        'data-tc-priority': opt.p,
        'aria-label': opt.label,
        'aria-pressed': String(currentPriority === opt.p),
        title: opt.label,
      },
    });
    setIcon(btn, 'flag');
    btn.addEventListener('click', () => {
      onPickPriority(opt.p);
      close();
    });
  }

  pop.createDiv({ cls: 'tc-status-popover-divider' });

  // ── Status list ───────────────────────────────────────────
  const list = pop.createDiv({ cls: 'tc-status-popover-list' });
  const groups = registry.grouped();
  groups.forEach((group, groupIndex) => {
    for (const def of group.statuses) {
      const row = list.createDiv({ cls: 'tc-status-popover-row' });
      const isCurrent = task.statusSymbol === def.symbol;
      row.setAttrs({ role: 'menuitemradio', tabindex: '0', 'aria-checked': String(isCurrent) });
      renderStatusMarker(row, {
        // A faithful mini status chip needs only the symbol; priority is
        // irrelevant here so it's pinned to 'D' to avoid drawing a border.
        task: { statusSymbol: def.symbol, priority: 'D' },
        registry,
        interactive: false,
        onLeftClick: () => {},
        onContextMenu: () => {},
      });
      row.createSpan({ cls: 'tc-status-popover-name', text: def.name });
      if (isCurrent) {
        row.addClass('is-current');
        const check = row.createSpan({ cls: 'tc-status-popover-check' });
        setIcon(check, 'check');
      }
      const pickStatus = (): void => {
        onPickStatus(def.symbol);
        close();
      };
      row.addEventListener('click', pickStatus);
      row.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        pickStatus();
      });
    }
    if (groupIndex < groups.length - 1) {
      list.createDiv({ cls: 'tc-status-popover-divider' });
    }
  });

  if (onEditRepeat) {
    pop.createDiv({ cls: 'tc-status-popover-divider' });
    const editRepeat = pop.createDiv({
      cls: 'tc-status-popover-row tc-status-popover-edit-repeat',
      attr: { role: 'menuitem', tabindex: '0' },
    });
    if (task.recurrence) {
      renderRecurrenceBadge(editRepeat, recurrenceBadgeInput(task.recurrence));
    }
    editRepeat.createSpan({ cls: 'tc-status-popover-name', text: 'Edit repeat…' });
    const edit = (): void => {
      close();
      onEditRepeat();
    };
    editRepeat.addEventListener('click', edit);
    editRepeat.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      edit();
    });
  }

  positionPopoverAt(pop, ev);
  priorityRow.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  dismissTimer = ownerWindow.setTimeout(() => {
    dismissTimer = undefined;
    if (closed || !pop.isConnected) return;
    ownerDocument.addEventListener('mousedown', onOutside, true);
    ownerDocument.addEventListener('keydown', onKey, true);
    dismissListening = true;
  }, 0);
  return {
    element: pop,
    close: (options) => close(options?.restoreFocus === true),
  };
}
