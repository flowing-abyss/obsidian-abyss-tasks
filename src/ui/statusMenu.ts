import { setIcon, type Menu } from 'obsidian';
import { PRIORITY_LEVELS } from '../priority';
import type { StatusRegistry } from '../status/StatusRegistry';
import type { SubtaskSnapshot, TaskPriority, TaskSnapshot } from '../tasks';
import { renderStatusMarker } from './StatusMarker';

export interface StatusMenuOpts {
  task: TaskSnapshot | SubtaskSnapshot;
  registry: StatusRegistry;
  onPickStatus: (char: string) => void;
  onPickPriority: (p: TaskPriority) => void;
}

const PRIORITY_OPTIONS: Array<{ p: TaskPriority; label: string }> = PRIORITY_LEVELS.map((l) => ({
  p: l.value,
  label: l.label,
}));

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
  const margin = 8;
  // Measure after appending (offsetWidth/Height are 0 before layout).
  const width = pop.offsetWidth;
  const height = pop.offsetHeight;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);
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
export function showStatusMenuAt(ev: MouseEvent, opts: StatusMenuOpts): void {
  const { task, registry, onPickStatus, onPickPriority } = opts;

  // Only one status popover at a time.
  activeDocument.querySelectorAll('.tc-status-popover').forEach((el) => el.remove());

  const pop = activeDocument.body.createDiv({ cls: 'tc-status-popover' });

  const close = (): void => {
    pop.remove();
    activeDocument.removeEventListener('mousedown', onOutside, true);
    activeDocument.removeEventListener('keydown', onKey, true);
  };
  const onOutside = (e: MouseEvent): void => {
    if (!pop.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };

  // ── Priority row ──────────────────────────────────────────
  const priorityRow = pop.createDiv({ cls: 'tc-status-popover-priority-row' });
  const currentPriority = task.priority ?? 'D';
  for (const opt of PRIORITY_OPTIONS) {
    const btn = priorityRow.createEl('button', {
      cls: `tc-status-popover-flag${currentPriority === opt.p ? ' is-active' : ''}`,
      attr: { 'data-tc-priority': opt.p, 'aria-label': opt.label, title: opt.label },
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
      const isCurrent = task.statusSymbol === def.symbol;
      if (isCurrent) {
        row.addClass('is-current');
        const check = row.createSpan({ cls: 'tc-status-popover-check' });
        setIcon(check, 'check');
      }
      row.addEventListener('click', () => {
        onPickStatus(def.symbol);
        close();
      });
    }
    if (groupIndex < groups.length - 1) {
      list.createDiv({ cls: 'tc-status-popover-divider' });
    }
  });

  positionPopoverAt(pop, ev);
  window.setTimeout(() => {
    activeDocument.addEventListener('mousedown', onOutside, true);
    activeDocument.addEventListener('keydown', onKey, true);
  }, 0);
}
