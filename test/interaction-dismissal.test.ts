import { afterEach, expect, it, vi } from 'vitest';
import { InteractionRegistry } from '../src/ui/interactionOwnership';

afterEach(() => {
  document.body.empty();
});

function surface(registry: InteractionRegistry<string>, element = document.body.createDiv()) {
  const close = vi.fn(() => {
    element.remove();
    token.release();
  });
  const token = registry.acquire({ blocksShortcuts: true, dismiss: { element, close } });
  return { element, close, token };
}

it('dismisses only the newest connected child surface, skipping plain editing leases and parent owners', () => {
  const parent = new InteractionRegistry();
  const child = new InteractionRegistry(parent);
  const outside = surface(parent);
  const older = surface(child);
  const newer = surface(child);
  newer.element.remove();
  child.acquire({ blocksShortcuts: true });

  expect(child.dismissLatest()).toBe(true);
  expect(older.close).toHaveBeenCalledOnce();
  expect(newer.close).not.toHaveBeenCalled();
  expect(outside.close).not.toHaveBeenCalled();
  expect(child.dismissLatest()).toBe(false);
  document.body.append(newer.element);
  expect(child.dismissLatest()).toBe(true);
  expect(newer.close).toHaveBeenCalledOnce();
  expect(child.dismissLatest()).toBe(false);
  child.destroy();
  expect(parent.allows('navigate')).toBe(false);
  outside.token.release();
  expect(parent.allows('navigate')).toBe(true);
});

it('preserves registration order through retained reattachment and gives a reopened surface fresh ownership', () => {
  const registry = new InteractionRegistry();
  const first = surface(registry);
  const second = surface(registry);
  first.element.remove();
  document.body.append(first.element);
  expect(registry.dismissLatest()).toBe(true);
  expect(second.close).toHaveBeenCalledOnce();
  expect(first.close).not.toHaveBeenCalled();
  first.token.release();
  const third = surface(registry);
  const reopened = surface(registry, first.element);
  first.token.release();
  expect(registry.dismissLatest()).toBe(true);
  expect(reopened.close).toHaveBeenCalledOnce();
  expect(third.close).not.toHaveBeenCalled();
  registry.destroy();
  expect(registry.dismissLatest()).toBe(false);
  expect(third.close).not.toHaveBeenCalled();
  expect(registry.allows('navigate')).toBe(true);
});
