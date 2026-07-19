import { describe, expect, it } from 'vitest';
import { StatusCatalog } from '../../src/tasks/domain/StatusCatalog';
import { shiftLocalDate } from '../../src/tasks/domain/localDateMath';
import { sameTaskNodeRef, type TaskNodeRef } from '../../src/tasks/domain/types';
import { durationMinutes, localDate, localTime } from '../../src/tasks/domain/validation';

describe('task domain values', () => {
  it('rejects an unknown runtime node kind instead of treating it as the same node', () => {
    const injected = { type: 'external', ref: {} } as unknown as TaskNodeRef;

    expect(sameTaskNodeRef(injected, injected)).toBe(false);
  });

  it('accepts real dates and rejects rollover dates', () => {
    expect(localDate('2026-07-13')).toBe('2026-07-13');
    expect(() => localDate('2026-02-30')).toThrow('invalid-date');
  });

  it('accepts 24-hour time and positive integer minutes only', () => {
    expect(localTime('23:59')).toBe('23:59');
    expect(durationMinutes(90)).toBe(90);
    expect(() => localTime('24:00')).toThrow('invalid-time');
    expect(() => durationMinutes(1.5)).toThrow('invalid-duration');
  });

  it('shifts local dates across ordinary, month, year, and leap-day boundaries', () => {
    expect(shiftLocalDate(localDate('2026-07-20'), 1)).toBe('2026-07-21');
    expect(shiftLocalDate(localDate('2026-01-01'), -1)).toBe('2025-12-31');
    expect(shiftLocalDate(localDate('2028-02-28'), 1)).toBe('2028-02-29');
    expect(shiftLocalDate(localDate('2028-03-01'), -1)).toBe('2028-02-29');
    expect(shiftLocalDate(localDate('0000-01-01'), -1)).toBeUndefined();
    expect(shiftLocalDate(localDate('9999-12-31'), 1)).toBeUndefined();
  });
});

describe('StatusCatalog', () => {
  const catalog = new StatusCatalog([
    { id: 'todo', symbol: ' ', type: 'todo', defaultForType: true },
    { id: 'done', symbol: 'x', type: 'done', defaultForType: true },
  ]);

  it('normalizes uppercase X while retaining an unknown status as open', () => {
    expect(catalog.statusForSymbol('X')).toBe('done');
    expect(catalog.statusForSymbol('?')).toBe('open');
  });

  it('uses first-rule precedence for duplicate symbols', () => {
    const duplicateCatalog = new StatusCatalog([
      { id: 'first', symbol: '!', type: 'in-progress', defaultForType: false },
      { id: 'second', symbol: '!', type: 'cancelled', defaultForType: false },
    ]);

    expect(duplicateCatalog.statusForSymbol('!')).toBe('in-progress');
  });

  it('selects marked defaults and returns detached rule copies', () => {
    expect(catalog.defaultForType('done')).toEqual({
      id: 'done',
      symbol: 'x',
      type: 'done',
      defaultForType: true,
    });
    expect(catalog.defaultForType('cancelled')).toBeUndefined();

    const returned = catalog.all();
    returned.splice(0, returned.length);
    expect(catalog.all()).toHaveLength(2);

    const mutableRule = catalog.all()[0] as { symbol: string };
    mutableRule.symbol = '!';
    expect(catalog.all()[0]?.symbol).toBe(' ');
  });

  it('detaches its rules from mutable constructor input', () => {
    const input = [{ id: 'todo', symbol: ' ', type: 'todo' as const, defaultForType: true }];
    const detachedCatalog = new StatusCatalog(input);

    input[0]!.symbol = '!';

    expect(detachedCatalog.all()[0]?.symbol).toBe(' ');
  });
});
