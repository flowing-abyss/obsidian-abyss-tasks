import { setIcon, setTooltip } from 'obsidian';
import type { StatusRegistry } from '../status/StatusRegistry';
import type { TaskOccurrenceCompletion, TaskPriority } from '../tasks';

interface Opts {
  // Structural type: only statusSymbol/priority are read, so Task/SubTask
  // satisfy this without a cast, and callers needing a fake stand-in task
  // (menus/previews) can pass a plain object literal instead of a cast.
  task: { statusSymbol: string; priority?: TaskPriority };
  registry: StatusRegistry;
  interactive?: boolean | 'menu';
  completionBlocked?: boolean;
  completion?: TaskOccurrenceCompletion;
  completionHint?: string;
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

const semanticUpdates = new WeakMap<HTMLElement, (label: string, isDone: boolean) => void>();

const completionBlockUpdates = new WeakMap<HTMLElement, (blocked: boolean) => void>();

export function setStatusMarkerCompletionBlocked(marker: HTMLElement, blocked: boolean): void {
  completionBlockUpdates.get(marker)?.(blocked);
}

const occurrenceCompletionUpdates = new WeakMap<
  HTMLElement,
  (completion: TaskOccurrenceCompletion, hint: string) => void
>();

export function setStatusMarkerOccurrenceCompletion(
  marker: HTMLElement,
  completion: TaskOccurrenceCompletion,
  hint: string,
): void {
  occurrenceCompletionUpdates.get(marker)?.(completion, hint);
}

function bindContextMenu(control: HTMLElement, onContextMenu: (event: MouseEvent) => void): void {
  control.oncontextmenu = (event) => {
    event.preventDefault();
    event.stopPropagation();
    onContextMenu(event);
  };
}

const BLOCKED_HINT = 'Complete prerequisite tasks or remove the dependency first.';

function setControlSemantics(
  control: HTMLElement,
  label: string,
  isDone: boolean,
  hints: readonly string[],
): void {
  const suffix = hints.length > 0 ? `. ${hints.join(' ')}` : '';
  const name = `Task status: ${label}${suffix}`;
  control.setAttrs({
    role: 'checkbox',
    'aria-checked': String(isDone),
    'aria-label': name,
    tabindex: '0',
  });
  if (hints.length > 0) control.setAttribute('aria-disabled', 'true');
  else control.removeAttribute('aria-disabled');
  setTooltip(control, name);
}

function wrapStatusMarker(marker: HTMLElement): HTMLElement | undefined {
  const wrapper = marker.parentElement?.createSpan({ cls: 'abyss-status-control' });
  if (wrapper === undefined) return undefined;
  marker.before(wrapper);
  wrapper.append(marker);
  for (const attr of ['role', 'aria-checked', 'aria-label', 'aria-disabled', 'tabindex'])
    marker.removeAttribute(attr);
  marker.setAttribute('aria-hidden', 'true');
  return wrapper;
}

function makeMarkerInteractive(
  ...args: [HTMLElement, string, boolean, () => void, (event: MouseEvent) => void]
): void {
  const [marker, initialLabel, initialDone, onLeftClick, onContextMenu] = args;
  let label = initialLabel;
  let isDone = initialDone;
  let blocked = false;
  let continuation = false;
  let completionHint = '';
  let wrapper: HTMLElement | undefined;
  const control = (): HTMLElement => wrapper ?? marker;
  const semantics = (element: HTMLElement): void => {
    setControlSemantics(element, label, isDone, [
      ...(blocked ? [BLOCKED_HINT] : []),
      ...(continuation ? [completionHint] : []),
    ]);
  };
  const onClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    if (!blocked && !continuation) onLeftClick();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    // Dependency-only keyboard activation retains the command's confirmation path.
    if (!event.repeat && !continuation) onLeftClick();
  };
  const onPointer = (event: Event): void => {
    if (!blocked && !continuation) return;
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
  const refresh = (): void => {
    const focused = marker.ownerDocument.activeElement === control();
    marker.classList.toggle('abyss-status-marker--blocked', blocked);
    marker.classList.toggle('abyss-status-marker--continuation', continuation);
    if (blocked || continuation) {
      if (wrapper === undefined) {
        wrapper = wrapStatusMarker(marker);
        if (wrapper === undefined) return;
        bind(wrapper);
      }
    } else if (wrapper !== undefined) {
      wrapper.before(marker);
      wrapper.remove();
      wrapper = undefined;
      marker.removeAttribute('aria-hidden');
    }
    semantics(control());
    if (focused) control().focus({ preventScroll: true });
  };
  semanticUpdates.set(marker, (nextLabel, nextDone) => {
    label = nextLabel;
    isDone = nextDone;
    semantics(control());
  });
  semantics(marker);
  bind(marker);
  completionBlockUpdates.set(marker, (next) => {
    if (blocked === next) return;
    blocked = next;
    refresh();
  });
  occurrenceCompletionUpdates.set(marker, (completion, hint) => {
    const next = completion.kind === 'continuation';
    if (continuation === next && completionHint === hint) return;
    continuation = next;
    completionHint = hint;
    refresh();
  });
}

function setMarkerMetadata(
  marker: HTMLElement,
  presentation: { id: string; type: string },
  priority: TaskPriority | undefined,
): void {
  marker.removeAttribute('data-priority');
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

function markerPresentation(
  task: Opts['task'],
  registry: StatusRegistry,
): {
  id: string;
  type: string;
  label: string;
  icon: string | undefined;
  isDone: boolean;
  defined: boolean;
} {
  const def = registry.bySymbol(task.statusSymbol);
  return def == null
    ? {
        id: 'other',
        type: 'todo',
        label: task.statusSymbol,
        icon: undefined,
        isDone: false,
        defined: false,
      }
    : {
        id: def.id,
        type: def.type,
        label: def.name,
        icon: def.icon,
        isDone: def.type === 'done',
        defined: true,
      };
}

/** Refresh the existing marker and its owned accessibility wrapper without replacing focus. */
export function updateStatusMarker(
  marker: HTMLElement,
  opts: Pick<Opts, 'task' | 'registry' | 'completionBlocked' | 'completion' | 'completionHint'>,
): void {
  const presentation = markerPresentation(opts.task, opts.registry);
  setMarkerMetadata(marker, presentation, opts.task.priority);
  marker.empty();
  renderMarkerIcon(marker, opts.task.statusSymbol, presentation.icon, presentation.defined);
  semanticUpdates.get(marker)?.(presentation.label, presentation.isDone);
  setStatusMarkerCompletionBlocked(marker, opts.completionBlocked === true);
  setStatusMarkerOccurrenceCompletion(
    marker,
    opts.completion ?? { kind: 'allowed' },
    opts.completionHint ?? '',
  );
}

export function renderStatusMarker(parent: HTMLElement, opts: Opts): HTMLElement {
  const { task, registry, interactive = true, onLeftClick, onContextMenu } = opts;
  const presentation = markerPresentation(task, registry);
  const el = parent.createSpan({ cls: 'abyss-status-marker' });
  if (interactive !== true) el.addClass('abyss-status-marker--inert');
  setMarkerMetadata(el, presentation, task.priority);
  renderMarkerIcon(el, task.statusSymbol, presentation.icon, presentation.defined);

  if (interactive === true) {
    makeMarkerInteractive(el, presentation.label, presentation.isDone, onLeftClick, onContextMenu);
    setStatusMarkerCompletionBlocked(el, opts.completionBlocked === true);
    setStatusMarkerOccurrenceCompletion(
      el,
      opts.completion ?? { kind: 'allowed' },
      opts.completionHint ?? '',
    );
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
