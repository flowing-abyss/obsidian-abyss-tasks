import { describe, expect, it, vi } from 'vitest';
import { clockFrom, systemClock } from '../../src/tasks/domain/clock';

describe('Clock', () => {
  it.each([
    [0, '2026-08-11T09:32:10+00:00', '2026-08-11'],
    [420, '2026-08-11T16:32:10+07:00', '2026-08-11'],
    [-300, '2026-08-11T04:32:10-05:00', '2026-08-11'],
  ] as const)('formats one UTC instant at offset %s', (offsetMinutes, atom, localDate) => {
    const reading = clockFrom(Date.parse('2026-08-11T09:32:10Z'), offsetMinutes).read();

    expect(reading).toEqual({
      localDate,
      epochMs: Date.parse('2026-08-11T09:32:10Z'),
      offsetMinutes,
      atom,
    });
  });

  it('reads the ambient instant exactly once per atomic reading', () => {
    const instantSource = vi.fn(() => Date.parse('2026-08-11T09:32:10Z'));
    const offsetSource = vi.fn(() => 420);

    expect(systemClock(instantSource, offsetSource).read().atom).toBe('2026-08-11T16:32:10+07:00');
    expect(instantSource).toHaveBeenCalledOnce();
    expect(offsetSource).toHaveBeenCalledOnce();
    expect(offsetSource).toHaveBeenCalledWith(Date.parse('2026-08-11T09:32:10Z'));
  });
});
