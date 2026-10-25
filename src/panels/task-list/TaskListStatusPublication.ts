import type { Component } from 'obsidian';
import {
  sameTaskNodeRef,
  type TaskNodeSnapshot,
  type TaskQueryApi,
  type TaskRef,
  type TaskSnapshot,
} from '../../tasks';
import type { OwnedTaskSelectionProof } from '../../ui/ownedTaskSelection';
import {
  rebuildTaskSelection,
  rootTaskRef,
  taskNodeRef,
  taskSelectionRefPath,
  type TaskSelectionNode,
} from '../../ui/taskSelection';
import type { RightPanelMutationLifecycle } from '../RightPanel';

interface Completion {
  readonly done: Promise<void>;
  readonly finish: () => void;
}
function completion(): Completion {
  let finish = (): void => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { done, finish };
}
interface InspectorOperation extends Completion {
  readonly ref: TaskRef;
}
interface HeldTarget {
  readonly original: TaskSelectionNode;
  root: TaskSnapshot;
  selection: TaskSelectionNode[];
  waitingForProof: boolean;
}
interface StatusActivation {
  readonly marker: HTMLElement;
  readonly owner: NonNullable<Document['defaultView']>;
  readonly target: HeldTarget;
  readonly cancelled: Completion;
  readonly operations: Map<InspectorOperation, TaskSelectionNode>;
  readonly cleanup: Array<() => void>;
  readonly menus: Set<() => void>;
  releasePublication?: (() => void) | undefined;
  timer?: number | undefined;
  pressed: boolean;
  dragging: boolean;
  pending: number;
}
function sameRef(a: TaskRef, b: TaskRef): boolean {
  return sameTaskNodeRef({ type: 'task', ref: a }, { type: 'task', ref: b });
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

/** Owns one native status activation and its exact successors through inspector save settlement. */
export class TaskListStatusPublication {
  #active: StatusActivation | undefined;
  #disposed = false;
  readonly #targets = new WeakMap<HTMLElement, () => TaskSelectionNode | undefined>();
  readonly #operations = new Map<object, InspectorOperation>();
  readonly #drags = new WeakMap<
    HTMLElement,
    { readonly key: string; readonly current: () => TaskNodeSnapshot }
  >();
  constructor(
    private readonly queries: Pick<TaskQueryApi, 'resolve'>,
    private readonly hold: (accept: () => boolean, cancel: () => void) => (() => void) | undefined,
    private readonly pin: (key: string, ref: TaskRef, cancel: () => void) => () => void,
  ) {}

  capture(marker: HTMLElement, current: () => TaskSelectionNode | undefined): void {
    this.#targets.set(marker, current);
  }

  captureDrag(
    card: HTMLElement,
    source: { readonly key: string; readonly current: () => TaskNodeSnapshot },
  ): void {
    this.#drags.set(card, source);
  }
  drag(card: HTMLElement): () => void {
    const source = this.#drags.get(card);
    if (source === undefined) return () => {};
    if (this.#active?.marker !== card) {
      const task = source.current();
      this.#start(card, source.key, task.root, task.node);
    }
    const active = this.#active;
    if (active?.marker !== card) return () => {};
    active.pending++;
    active.dragging = true;
    active.pressed = false;
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      active.dragging = false;
      active.pending--;
      this.#releaseLater(active);
    };
  }

  mutation(event: RightPanelMutationLifecycle): void {
    if (this.#disposed || event.operation === 'hierarchy') return;
    if (event.phase === 'started') {
      this.#startOperation(event);
      return;
    }
    const operation = this.#operations.get(event.token);
    if (operation === undefined) return;
    this.#operations.delete(event.token);
    const active = this.#active;
    const basis = active?.operations.get(operation);
    if (active !== undefined && basis !== undefined) {
      active.operations.delete(operation);
      if (!this.#settleTarget(active, basis, event.proof)) this.#cancel(active);
    }
    operation.finish();
  }
  #startOperation(event: RightPanelMutationLifecycle): void {
    const operation = { ...completion(), ref: event.ref };
    this.#operations.set(event.token, operation);
    const active = this.#active;
    if (active !== undefined && this.#matchesOperation(active.target, operation))
      active.operations.set(operation, this.#current(active.target));
  }

  #matchesOperation(target: HeldTarget, operation: InspectorOperation): boolean {
    return (
      sameRef(target.root.ref, operation.ref) ||
      sameRef(rootTaskRef(target.original), operation.ref)
    );
  }
  #current(target: HeldTarget): TaskSelectionNode {
    return target.selection[target.selection.length - 1] ?? target.original;
  }
  #settleTarget(
    active: StatusActivation,
    basis: TaskSelectionNode,
    proof: OwnedTaskSelectionProof | undefined,
  ): boolean {
    if (proof === undefined) return this.#validate(active);
    const successor = proof.nodeSuccessor(taskNodeRef(basis));
    if (successor === undefined) return false;
    const resolution = this.queries.resolve(rootTaskRef(successor));
    if (resolution.type !== 'exact') return false;
    const selection = taskSelectionRefPath(resolution.task, taskNodeRef(successor));
    if (selection === undefined) return false;
    active.target.root = resolution.task;
    active.target.selection = selection;
    active.target.waitingForProof = false;
    return this.#validate(active);
  }
  #validate(active: StatusActivation): boolean {
    if (!active.marker.isConnected || active.marker.ownerDocument.defaultView !== active.owner)
      return false;
    const target = active.target;
    const resolution = this.queries.resolve(target.root.ref);
    if (resolution.type === 'exact') return !target.waitingForProof || active.operations.size > 0;
    if (resolution.type !== 'rebased' || resolution.evidence !== 'authority-transition')
      return false;
    const next = rebuildTaskSelection(resolution.current, target.selection);
    target.root = resolution.current;
    target.waitingForProof = next.length !== target.selection.length;
    if (!target.waitingForProof) target.selection = next;
    return !target.waitingForProof || active.operations.size > 0;
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
      if (marker === null) {
        this.#pressDrag(card, event);
        return;
      }
      if (!card.contains(marker)) return;
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

  #pressDrag(card: HTMLElement, event: MouseEvent): void {
    const source = this.#drags.get(card);
    const target = event.target;
    if (source === undefined || event.button !== 0 || this.#active?.marker === card) return;
    if (
      target !== null &&
      'closest' in target &&
      (target as Element).closest(
        'button, input, textarea, a, [contenteditable="true"], .abyss-subtask-row, .abyss-task-tag',
      ) !== null
    )
      return;
    const task = source.current();
    this.#start(card, source.key, task.root, task.node);
  }

  #start(marker: HTMLElement, key: string, root: TaskSnapshot, node: TaskSelectionNode): void {
    const owner = marker.ownerDocument.defaultView;
    const selection = taskSelectionRefPath(root, taskNodeRef(node));
    if (this.#disposed || owner === null || selection === undefined) {
      this.#cancel();
      return;
    }
    const target: HeldTarget = { original: node, root, selection, waitingForProof: false };
    const active: StatusActivation = {
      marker,
      owner,
      target,
      cancelled: completion(),
      operations: new Map(),
      cleanup: [],
      menus: new Set(),
      pressed: true,
      dragging: false,
      pending: 0,
    };
    for (const operation of this.#operations.values())
      if (this.#matchesOperation(target, operation)) active.operations.set(operation, node);
    const release = this.hold(
      () => this.#validate(active),
      () => {
        this.#cancel(active);
      },
    );
    // Acquire the next publication lease before retiring the previous marker and menu.
    this.#cancel();
    if (release === undefined) return;
    active.releasePublication = release;
    this.#active = active;
    active.cleanup.push(
      this.pin(key, root.ref, () => {
        this.#cancel(active);
      }),
    );
    this.#listen(active);
  }
  #listen(active: StatusActivation): void {
    const { owner } = active;
    const up = (): void => {
      active.pressed = false;
      this.#releaseLater(active);
    };
    const cancel = (): void => {
      this.#cancel(active);
    };
    const pointerCancel = (): void => {
      // Native dragstart suppresses its pointer stream; dragend owns that lease now.
      if (!active.dragging) cancel();
    };
    owner.addEventListener('mouseup', up, true);
    owner.addEventListener('pointerup', up, true);
    owner.addEventListener('pointercancel', pointerCancel, true);
    owner.addEventListener('blur', cancel);
    active.cleanup.push(() => {
      owner.removeEventListener('mouseup', up, true);
      owner.removeEventListener('pointerup', up, true);
      owner.removeEventListener('pointercancel', pointerCancel, true);
      owner.removeEventListener('blur', cancel);
    });
  }

  async run(
    subject: TaskSelectionNode,
    action: (current: TaskSelectionNode) => Promise<void>,
  ): Promise<void> {
    const active = this.#active;
    if (
      active === undefined ||
      !sameTaskNodeRef(taskNodeRef(subject), taskNodeRef(active.target.original))
    ) {
      await action(subject);
      return;
    }
    active.pending++;
    try {
      while (this.#active === active && active.operations.size > 0)
        await Promise.race([
          Promise.all([...active.operations.keys()].map((operation) => operation.done)),
          active.cancelled.done,
        ]);
      if (this.#active !== active) return;
      if (!this.#validate(active) || active.target.waitingForProof) {
        this.#cancel(active);
        return;
      }
      await action(this.#current(active.target));
    } finally {
      active.pending--;
      this.#releaseLater(active);
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
    active.cancelled.finish();
    if (active.timer !== undefined) active.owner.clearTimeout(active.timer);
    for (const close of active.menus) close();
    for (const cleanup of active.cleanup) cleanup();
    active.releasePublication?.();
  }
  dispose(): void {
    this.#disposed = true;
    this.#cancel();
    for (const operation of this.#operations.values()) operation.finish();
    this.#operations.clear();
  }
}
