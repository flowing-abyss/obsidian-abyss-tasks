import { describe, expect, it } from 'vitest';
import { InteractionRegistry, noInteractionOwnership } from '../src/ui/interactionOwnership';

type TestAction = 'openQuickCapture' | 'openTasks' | 'openCalendar';

describe('InteractionRegistry', () => {
  it('allows actions when no blocking owner is active', () => {
    const registry = new InteractionRegistry<TestAction>();

    expect(registry.allows('openQuickCapture')).toBe(true);
    expect(registry.allows('openTasks')).toBe(true);
  });

  it('ignores active owners that do not block shortcuts', () => {
    const registry = new InteractionRegistry<TestAction>();
    registry.acquire({ blocksShortcuts: false });

    expect(registry.allows('openCalendar')).toBe(true);
  });

  it('blocks every action not named by the active owner allowlist', () => {
    const registry = new InteractionRegistry<TestAction>();
    registry.acquire({
      blocksShortcuts: true,
      allowActions: ['openQuickCapture'],
    });

    expect(registry.allows('openQuickCapture')).toBe(true);
    expect(registry.allows('openTasks')).toBe(false);
    expect(registry.allows('openCalendar')).toBe(false);
  });

  it('requires every nested blocking owner to allow an action', () => {
    const registry = new InteractionRegistry<TestAction>();
    const outer = registry.acquire({
      blocksShortcuts: true,
      allowActions: ['openQuickCapture', 'openTasks'],
    });
    const inner = registry.acquire({
      blocksShortcuts: true,
      allowActions: ['openQuickCapture'],
    });

    expect(registry.allows('openQuickCapture')).toBe(true);
    expect(registry.allows('openTasks')).toBe(false);
    inner.release();
    expect(registry.allows('openTasks')).toBe(true);
    outer.release();
    expect(registry.allows('openCalendar')).toBe(true);
  });

  it('releases each ownership token idempotently without disturbing nested owners', () => {
    const registry = new InteractionRegistry<TestAction>();
    const first = registry.acquire({ blocksShortcuts: true });
    const second = registry.acquire({ blocksShortcuts: true, allowActions: ['openTasks'] });

    first.release();
    first.release();

    expect(registry.allows('openTasks')).toBe(true);
    expect(registry.allows('openCalendar')).toBe(false);
    second.release();
    expect(registry.allows('openCalendar')).toBe(true);
  });

  it('clears active owners on destroy and makes later acquisitions inert', () => {
    const registry = new InteractionRegistry<TestAction>();
    const token = registry.acquire({ blocksShortcuts: true });

    registry.destroy();
    const afterDestroy = registry.acquire({ blocksShortcuts: true });

    expect(registry.allows('openTasks')).toBe(true);
    token.release();
    afterDestroy.release();
    expect(registry.allows('openCalendar')).toBe(true);
  });
});

describe('noInteractionOwnership', () => {
  it('provides an idempotently releasable ownership port without a registry', () => {
    const token = noInteractionOwnership.acquire({ blocksShortcuts: true });

    expect(() => {
      token.release();
      token.release();
    }).not.toThrow();
  });
});
