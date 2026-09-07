import { setIcon } from 'obsidian';
import type { StatusRegistry } from '../status/StatusRegistry';
import type { TaskPriority } from '../tasks';

interface Opts {
  // Structural type: only statusSymbol/priority are read, so Task/SubTask
  // satisfy this without a cast, and callers needing a fake stand-in task
  // (menus/previews) can pass a plain object literal instead of a cast.
  task: { statusSymbol: string; priority?: TaskPriority };
  registry: StatusRegistry;
  interactive?: boolean | 'menu';
  completionBlocked?: boolean;
  onLeftClick: () => void;
  onContextMenu: (ev: MouseEvent) => void;
}

// Lucide icons are identical for every marker sharing an icon id; building the
// svg via `setIcon` once and cloning it is far cheaper than re-running
// `setIcon` for every marker (hundreds in a non-virtualized calendar view).
const ICON_CACHE = new Map<string, SVGElement>();

function getLucideIcon(iconId: string): SVGElement | null {
  let svg = ICON_CACHE.get(iconId);
  if (svg == null) {
    const scratch = createFragment().createSpan();
    setIcon(scratch, iconId);
    svg = scratch.querySelector('svg') ?? undefined;
    if (svg == null) return null;
    ICON_CACHE.set(iconId, svg);
  }
  return svg.cloneNode(true) as SVGElement;
}

const completionBlockUpdates = new WeakMap<HTMLElement, (blocked: boolean) => void>();

export function setStatusMarkerCompletionBlocked(marker: HTMLElement, blocked: boolean): void {
  completionBlockUpdates.get(marker)?.(blocked);
}

function bindContextMenu(control: HTMLElement, onContextMenu: (event: MouseEvent) => void): void {
  control.oncontextmenu = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onContextMenu(event);
  };
}

function makeMarkerInteractive(
  ...args: [HTMLElement, string, boolean, () => void, (event: MouseEvent) => void]
): void {
  const [marker, label, isDone, onLeftClick, onContextMenu] = args;
  let blocked = false;
  let wrapper: HTMLElement | undefined;
  const semantics = (control: HTMLElement): void => {
    control.setAttrs({
      role: 'checkbox',
      'aria-checked': String(isDone),
      'aria-label': `Task status: ${label}`,
      tabindex: '0',
    });
  };
  const onClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    if (!blocked) onLeftClick();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) onLeftClick();
  };
  const onPointer = (event: Event): void => {
    if (!blocked) return;
    event.preventDefault();
    event.stopPropagation();
    wrapper?.focus({ preventScroll: true });
  };
  const bind = (control: HTMLElement): void => {
    control.onclick = onClick;
    bindContextMenu(control, onContextMenu);
    control.onkeydown = onKeyDown;
    control.onpointerdown = onPointer;
    control.ontouchstart = onPointer;
  };
  semantics(marker);
  bind(marker);
  completionBlockUpdates.set(marker, (next) => {
    if (blocked === next) return;
    const focused = marker.ownerDocument.activeElement === (wrapper ?? marker);
    blocked = next;
    marker.classList.toggle('abyss-status-marker--blocked', blocked);
    if (blocked) {
      wrapper = marker.parentElement?.createSpan({ cls: 'abyss-status-control' });
      if (wrapper === undefined) return;
      marker.before(wrapper);
      wrapper.append(marker);
      semantics(wrapper);
      wrapper.title = 'Complete prerequisite tasks or remove the dependency first.';
      wrapper.setAttrs({
        'aria-disabled': 'true',
        'aria-label': `Task status: ${label}. ${wrapper.title}`,
      });
      bind(wrapper);
      for (const attr of ['role', 'aria-checked', 'aria-label', 'tabindex'])
        marker.removeAttribute(attr);
      marker.setAttribute('aria-hidden', 'true');
    } else if (wrapper !== undefined) {
      wrapper.before(marker);
      wrapper.remove();
      wrapper = undefined;
      marker.removeAttribute('aria-hidden');
      semantics(marker);
    }
    if (focused) (wrapper ?? marker).focus({ preventScroll: true });
  });
}

function setMarkerMetadata(
  marker: HTMLElement,
  presentation: { id: string; type: string },
  priority: TaskPriority | undefined,
): void {
  marker.setAttrs({
    'data-status': presentation.id,
    'data-status-type': presentation.type,
    ...(priority != null && priority !== 'D' ? { 'data-priority': priority } : {}),
  });
}

function renderMarkerIcon(
  marker: HTMLElement,
  statusSymbol: string,
  icon: string | undefined,
  hasDefinition: boolean,
): void {
  if (icon !== undefined && icon !== '') {
    const svg = getLucideIcon(icon);
    if (svg != null) marker.appendChild(svg);
  } else if (!hasDefinition) {
    const raw = statusSymbol.trim();
    if (raw !== '') marker.setText(raw);
  }
}

export function renderStatusMarker(parent: HTMLElement, opts: Opts): HTMLElement {
  const { task, registry, interactive = true, onLeftClick, onContextMenu } = opts;
  const def = registry.bySymbol(task.statusSymbol);
  const presentation =
    def == null
      ? { id: 'other', type: 'todo', label: task.statusSymbol, icon: undefined, isDone: false }
      : {
          id: def.id,
          type: def.type,
          label: def.name,
          icon: def.icon,
          isDone: def.type === 'done',
        };
  const el = parent.createSpan({ cls: 'abyss-status-marker' });
  if (interactive !== true) el.addClass('abyss-status-marker--inert');
  setMarkerMetadata(el, presentation, task.priority);
  renderMarkerIcon(el, task.statusSymbol, presentation.icon, def != null);

  if (interactive === true) {
    makeMarkerInteractive(el, presentation.label, presentation.isDone, onLeftClick, onContextMenu);
    setStatusMarkerCompletionBlocked(el, opts.completionBlocked === true);
  } else if (interactive === 'menu') {
    el.setAttrs({
      role: 'img',
      'aria-label': presentation.label,
      'aria-haspopup': 'menu',
      tabindex: 0,
    });
    el.onclick = (event) => {
      event.stopPropagation();
    };
    bindContextMenu(el, onContextMenu);
  }
  return el;
}
