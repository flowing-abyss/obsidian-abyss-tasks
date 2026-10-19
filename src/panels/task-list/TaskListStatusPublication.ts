import type { Component } from 'obsidian';
import type { TaskQueryApi, TaskRef, TaskSnapshot } from '../../tasks';
import {
  rebuildTaskSelection,
  taskNodeRef,
  taskSelectionRefPath,
  type TaskSelectionNode,
} from '../../ui/taskSelection';

interface StatusActivation {
  readonly marker: HTMLElement;
  readonly owner: Window;
  readonly cleanup: Array<() => void>;
  readonly menus: Set<() => void>;
  releasePublication?: (() => void) | undefined;
  timer?: number | undefined;
  pressed: boolean;
  pending: number;
}

function pressedStatusMarker(target: EventTarget | null): HTMLElement | null {
  if (target === null || !('closest' in target)) return null;
  const control = (target as Element).closest<HTMLElement>(
    '.abyss-status-control, .abyss-status-marker',
  );
  return control?.matches('.abyss-status-control') === true
    ? control.querySelector<HTMLElement>('.abyss-status-marker')
    : control;
}

/** One pressed list status control owns its publication, row pin, menu and command lifetimes. */
export class TaskListStatusPublication {
  #active: StatusActivation | undefined;
  readonly #targets = new WeakMap<HTMLElement, () => TaskSelectionNode | undefined>();
  constructor(
    private readonly queries: Pick<TaskQueryApi, 'resolve'>,
    private readonly hold: (accept: () => boolean, cancel: () => void) => (() => void) | undefined,
    private readonly pin: (key: string, ref: TaskRef, cancel: () => void) => () => void,
  ) {}

  capture(marker: HTMLElement, current: () => TaskSelectionNode | undefined): void {
    this.#targets.set(marker, current);
  }

  bind(
    card: HTMLElement,
    component: Component,
    key: string,
    currentRoot: () => TaskSnapshot,
  ): void {
    const press = (event: MouseEvent): void => {
      if (event.button !== 0 && event.button !== 2) return;
      const marker = pressedStatusMarker(event.target);
      if (marker === null || !card.contains(marker)) return;
      if (this.#active?.marker === marker) return;
      const node = this.#targets.get(marker)?.();
      if (node !== undefined) this.#start(marker, key, currentRoot(), node);
    };
    card.addEventListener('pointerdown', press, true);
    card.addEventListener('mousedown', press, true);
    component.register(() => {
      card.removeEventListener('pointerdown', press, true);
      card.removeEventListener('mousedown', press, true);
      if (this.#active !== undefined && card.contains(this.#active.marker)) this.#cancel();
    });
  }

  #start(marker: HTMLElement, key: string, root: TaskSnapshot, node: TaskSelectionNode): void {
    this.#cancel();
    const owner = marker.ownerDocument.defaultView;
    if (owner === null) return;
    let ref = root.ref;
    const path = taskSelectionRefPath(root, taskNodeRef(node));
    if (path === undefined) return;
    let selection = path;
    const accept = (): boolean => {
      if (!marker.isConnected || marker.ownerDocument.defaultView !== owner) return false;
      const resolution = this.queries.resolve(ref);
      if (resolution.type === 'exact') return true;
      if (resolution.type !== 'rebased' || resolution.evidence !== 'authority-transition')
        return false;
      const next = rebuildTaskSelection(resolution.current, selection);
      if (next.length !== selection.length) return false;
      selection = next;
      ref = resolution.current.ref;
      return true;
    };
    const active: StatusActivation = {
      marker,
      owner,
      cleanup: [],
      menus: new Set(),
      pressed: true,
      pending: 0,
    };
    const release = this.hold(accept, () => {
      this.#cancel(active);
    });
    if (release === undefined) return;
    active.releasePublication = release;
    this.#active = active;
    active.cleanup.push(
      this.pin(key, root.ref, () => {
        this.#cancel(active);
      }),
    );
    const up = (): void => {
      active.pressed = false;
      this.#releaseLater(active);
    };
    const cancel = (): void => {
      this.#cancel(active);
    };
    owner.addEventListener('mouseup', up, true);
    owner.addEventListener('pointerup', up, true);
    owner.addEventListener('pointercancel', cancel, true);
    owner.addEventListener('blur', cancel);
    active.cleanup.push(() => {
      owner.removeEventListener('mouseup', up, true);
      owner.removeEventListener('pointerup', up, true);
      owner.removeEventListener('pointercancel', cancel, true);
      owner.removeEventListener('blur', cancel);
    });
  }

  async run(action: () => Promise<void>): Promise<void> {
    const active = this.#active;
    if (active !== undefined) active.pending++;
    try {
      await action();
    } finally {
      if (active !== undefined) {
        active.pending--;
        this.#releaseLater(active);
      }
    }
  }

  menu(close: () => void): () => void {
    const active = this.#active;
    if (active === undefined) return () => {};
    active.menus.add(close);
    return () => {
      active.menus.delete(close);
      this.#releaseLater(active);
    };
  }

  #releaseLater(active: StatusActivation): void {
    if (this.#active !== active || active.timer !== undefined) return;
    // Native click/contextmenu follows release in the same browser task, after pointerup handlers.
    active.timer = active.owner.setTimeout(() => {
      active.timer = undefined;
      if (!active.pressed && active.pending === 0 && active.menus.size === 0) this.#cancel(active);
    }, 0);
  }

  #cancel(active = this.#active): void {
    if (active === undefined || this.#active !== active) return;
    this.#active = undefined;
    if (active.timer !== undefined) active.owner.clearTimeout(active.timer);
    for (const close of active.menus) close();
    for (const cleanup of active.cleanup) cleanup();
    active.releasePublication?.();
  }
}
