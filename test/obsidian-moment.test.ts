import { moment as hostMoment } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { moment } from '../src/obsidianMoment';

describe('Obsidian Moment compatibility boundary', () => {
  it('preserves the host callable, overloads, and static state', () => {
    expect(moment).toBe(hostMoment);
    const parsed: ReturnType<typeof moment> = moment('2026-09-20', 'YYYY-MM-DD', 'en', true);
    expect(parsed.format('YYYY-MM-DD')).toBe('2026-09-20');
    expect(moment('2026-02-31', 'YYYY-MM-DD', true).isValid()).toBe(false);
    expect(moment([2026, 8, 20]).format('YYYY-MM-DD')).toBe('2026-09-20');
    expect(moment(undefined, true).isValid()).toBe(true);
    expect(moment.isMoment(parsed)).toBe(true);
    expect(moment.locale).toBe(hostMoment.locale);
  });
});
