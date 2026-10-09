import { Component } from 'obsidian';
import { vi } from 'vitest';
import { methodOf } from '../helpers';

/** Observe real Component load/unload and owner-native resources, without production telemetry. */
export function recordVirtualSurfaceResources(owner = window) {
  // Initialize jsdom's lazily installed selector/style delegates before tracking plugin listeners.
  owner.document.querySelector(':root');
  owner.getComputedStyle(owner.document.body);
  const liveComponents = new Set<Component>();
  const load = methodOf(Component.prototype, 'load');
  const unload = methodOf(Component.prototype, 'unload');
  vi.spyOn(Component.prototype, 'load').mockImplementation(function (this: Component) {
    load.call(this);
    liveComponents.add(this);
  });
  vi.spyOn(Component.prototype, 'unload').mockImplementation(function (this: Component) {
    try {
      unload.call(this);
    } finally {
      liveComponents.delete(this);
    }
  });
  const nativeListeners = new Set<{
    target: EventTarget;
    type: string;
    listener: EventListenerOrEventListenerObject | null;
    capture: boolean;
  }>();
  const ownsTarget = (target: EventTarget) =>
    target === owner || target === owner.document || target === owner.document.fonts;
  const add = methodOf(owner.EventTarget.prototype, 'addEventListener');
  const remove = methodOf(owner.EventTarget.prototype, 'removeEventListener');
  vi.spyOn(owner.EventTarget.prototype, 'addEventListener').mockImplementation(function (
    this: EventTarget,
    type,
    listener,
    options,
  ) {
    const capture = typeof options === 'boolean' ? options : (options?.capture ?? false);
    if (
      ownsTarget(this) &&
      !Array.from(nativeListeners).some(
        (entry) =>
          entry.target === this &&
          entry.type === type &&
          entry.listener === listener &&
          entry.capture === capture,
      )
    )
      nativeListeners.add({ target: this, type, listener, capture });
    add.call(this, type, listener, options);
  });
  vi.spyOn(owner.EventTarget.prototype, 'removeEventListener').mockImplementation(function (
    this: EventTarget,
    type,
    listener,
    options,
  ) {
    const capture = typeof options === 'boolean' ? options : (options?.capture ?? false);
    for (const entry of nativeListeners)
      if (
        entry.target === this &&
        entry.type === type &&
        entry.listener === listener &&
        entry.capture === capture
      )
        nativeListeners.delete(entry);
    remove.call(this, type, listener, options);
  });
  const observers = new Set<ResizeObserver>();
  const observed = new Set<Element>();
  const callbacks: ResizeObserverCallback[] = [];
  class Observer implements ResizeObserver {
    readonly #targets = new Set<Element>();
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(callback);
      observers.add(this);
    }
    observe(target: Element): void {
      this.#targets.add(target);
      observed.add(target);
    }
    unobserve(target: Element): void {
      this.#targets.delete(target);
      observed.delete(target);
    }
    disconnect(): void {
      for (const target of this.#targets) observed.delete(target);
      this.#targets.clear();
      observers.delete(this);
    }
  }
  const installObserver = () => vi.stubGlobal('ResizeObserver', Observer);
  installObserver();
  return {
    liveComponents,
    nativeListeners,
    observers,
    observed,
    callbacks,
    installObserver,
    counts: () => ({
      components: liveComponents.size,
      listeners: nativeListeners.size,
      observers: observers.size,
      targets: observed.size,
    }),
  };
}
