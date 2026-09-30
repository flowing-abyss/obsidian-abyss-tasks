// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildDefaultTaskStatuses } from '../src/settings/defaults';
import { toStatusRules } from '../src/settings/statusCatalogAdapter';
import { StatusRegistry } from '../src/status/StatusRegistry';

const reg = () => new StatusRegistry(buildDefaultTaskStatuses());

describe('StatusRegistry', () => {
  it('maps symbols to types', () => {
    const r = reg();
    expect(r.typeForSymbol(' ')).toBe('open');
    expect(r.typeForSymbol('/')).toBe('in-progress');
    expect(r.typeForSymbol('x')).toBe('done');
    expect(r.typeForSymbol('-')).toBe('cancelled');
  });

  it('treats uppercase X as an alias for lowercase x (done)', () => {
    expect(reg().typeForSymbol('X')).toBe('done');
  });

  it('bySymbol folds uppercase X to the same Done def as lowercase x', () => {
    const r = reg();
    const upper = r.bySymbol('X');
    const lower = r.bySymbol('x');
    expect(upper).toBeDefined();
    expect(upper).toBe(lower);
    expect(upper?.type).toBe('done');
  });

  it('falls back to open for unknown symbols', () => {
    expect(reg().typeForSymbol('@')).toBe('open');
    expect(reg().bySymbol('@')).toBeUndefined();
  });

  it('resolves default todo and done by core+type', () => {
    const r = reg();
    expect(r.defaultTodo().symbol).toBe(' ');
    expect(r.defaultDone().symbol).toBe('x');
  });

  it('groups in fixed type order', () => {
    const groups = reg()
      .grouped()
      .map((g) => g.type);
    expect(groups).toEqual(['todo', 'in-progress', 'done', 'cancelled']);
  });

  it('orders by settings order for sorting; unknown last', () => {
    const r = reg();
    expect(r.orderIndex(' ')).toBeLessThan(r.orderIndex('x'));
    expect(r.orderIndex('@')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('orderIndex folds uppercase X to the same slot as lowercase x', () => {
    const r = reg();
    expect(r.orderIndex('X')).toBe(r.orderIndex('x'));
    expect(r.orderIndex('X')).toBeLessThan(r.orderIndex('@'));
  });

  it('rebuilds one live presentation registry after status settings change', () => {
    const r = reg();
    const defs = buildDefaultTaskStatuses();
    defs.push({
      id: 'waiting',
      symbol: '?',
      name: 'Waiting',
      type: 'todo',
      icon: 'pause',
      core: false,
    });

    r.replace(defs);

    expect(r.bySymbol('?')?.name).toBe('Waiting');
    expect(r.all()).toHaveLength(5);
  });
});

describe('toStatusRules', () => {
  it('prefers the first core status for a type over an earlier custom status', () => {
    const rules = toStatusRules([
      {
        id: 'custom-todo',
        symbol: '?',
        name: 'Custom todo',
        type: 'todo',
        icon: 'circle',
        core: false,
      },
      {
        id: 'core-todo',
        symbol: ' ',
        name: 'Core todo',
        type: 'todo',
        icon: '',
        core: true,
      },
    ]);

    expect(rules).toEqual([
      { id: 'custom-todo', symbol: '?', type: 'todo', defaultForType: false },
      { id: 'core-todo', symbol: ' ', type: 'todo', defaultForType: true },
    ]);
  });

  it('falls back to the first configured status when a type has no core status', () => {
    const rules = toStatusRules([
      {
        id: 'first-progress',
        symbol: '/',
        name: 'First progress',
        type: 'in-progress',
        icon: '',
        core: false,
      },
      {
        id: 'later-progress',
        symbol: '>',
        name: 'Later progress',
        type: 'in-progress',
        icon: 'loader',
        core: false,
      },
    ]);

    expect(rules.map(({ id, defaultForType }) => ({ id, defaultForType }))).toEqual([
      { id: 'first-progress', defaultForType: true },
      { id: 'later-progress', defaultForType: false },
    ]);
  });
});
