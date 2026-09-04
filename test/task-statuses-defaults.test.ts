import { describe, expect, it } from 'vitest';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { expectDefined } from './helpers';

describe('buildDefaultTaskStatuses', () => {
  it('seeds exactly the 4 core group statuses', () => {
    const s = buildDefaultTaskStatuses();
    expect(s).toHaveLength(4);
    const bySymbol = Object.fromEntries(s.map((d) => [d.symbol, d]));
    expect(expectDefined(bySymbol[' ']).type).toBe('todo');
    expect(expectDefined(bySymbol[' ']).core).toBe(true);
    expect(expectDefined(bySymbol['/']).type).toBe('in-progress');
    expect(expectDefined(bySymbol['/']).core).toBe(true);
    expect(expectDefined(bySymbol['x']).type).toBe('done');
    expect(expectDefined(bySymbol['x']).core).toBe(true);
    expect(expectDefined(bySymbol['-']).type).toBe('cancelled');
    expect(expectDefined(bySymbol['-']).core).toBe(true);
  });

  it('gives every status a unique id and single-char symbol', () => {
    const s = buildDefaultTaskStatuses();
    const ids = new Set(s.map((d) => d.id));
    expect(ids.size).toBe(s.length);
    for (const d of s) expect([...d.symbol]).toHaveLength(1);
  });

  it('marks all 4 backbone types as core', () => {
    const core = buildDefaultTaskStatuses().filter((d) => d.core);
    expect(core.map((d) => d.type).sort((left, right) => left.localeCompare(right))).toEqual([
      'cancelled',
      'done',
      'in-progress',
      'todo',
    ]);
    expect(core).toHaveLength(4);
  });

  it('has no color or iconKind fields; icons are lucide ids only', () => {
    const s = buildDefaultTaskStatuses();
    for (const d of s) {
      expect((d as unknown as Record<string, unknown>)['color']).toBeUndefined();
      expect((d as unknown as Record<string, unknown>)['iconKind']).toBeUndefined();
    }
  });

  it('fixes the canonical icon per core status — empty/check/x, no auto-icon for in-progress', () => {
    const s = buildDefaultTaskStatuses();
    const bySymbol = Object.fromEntries(s.map((d) => [d.symbol, d]));
    // In-progress relies purely on the circle marker shape — no icon on top.
    expect(expectDefined(bySymbol[' ']).icon).toBe('');
    expect(expectDefined(bySymbol['/']).icon).toBe('');
    expect(expectDefined(bySymbol['x']).icon).toBe('check');
    expect(expectDefined(bySymbol['-']).icon).toBe('x');
  });
});
