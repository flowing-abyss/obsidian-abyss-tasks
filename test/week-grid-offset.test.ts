// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { weekStartOffset } from '../src/domain/weekGridOffset';

describe('weekStartOffset', () => {
  // Task 42b: the bug this guards against — the naive `firstDayOfWeek - weekday` (no
  // wraparound) goes *forward* into next week instead of back to the start of the
  // current one whenever weekday < firstDayOfWeek (e.g. anchor is a Sunday=0 and
  // firstDayOfWeek is Monday=1), entirely excluding the anchor date from the range.
  it('is always <= 0 (never walks forward past the anchor) for every weekday/firstDayOfWeek pair', () => {
    for (let firstDayOfWeek = 0; firstDayOfWeek < 7; firstDayOfWeek++) {
      for (let weekday = 0; weekday < 7; weekday++) {
        expect(weekStartOffset(weekday, firstDayOfWeek)).toBeLessThanOrEqual(0);
      }
    }
  });

  it('is always > -7 (stays within the same 7-day window)', () => {
    for (let firstDayOfWeek = 0; firstDayOfWeek < 7; firstDayOfWeek++) {
      for (let weekday = 0; weekday < 7; weekday++) {
        expect(weekStartOffset(weekday, firstDayOfWeek)).toBeGreaterThan(-7);
      }
    }
  });

  it('(anchor weekday + offset) mod 7 always equals firstDayOfWeek', () => {
    for (let firstDayOfWeek = 0; firstDayOfWeek < 7; firstDayOfWeek++) {
      for (let weekday = 0; weekday < 7; weekday++) {
        const offset = weekStartOffset(weekday, firstDayOfWeek);
        const shifted = weekday + offset;
        expect(((shifted % 7) + 7) % 7).toBe(firstDayOfWeek);
      }
    }
  });

  it('is 0 when the anchor is already the configured first day of the week', () => {
    for (let firstDayOfWeek = 0; firstDayOfWeek < 7; firstDayOfWeek++) {
      expect(weekStartOffset(firstDayOfWeek, firstDayOfWeek)).toBe(0);
    }
  });

  // The exact regression: Sunday (0) anchor, Monday-first (1) config.
  it('regression: Sunday anchor with Monday-first config walks back 6 days, not forward 1', () => {
    expect(weekStartOffset(0, 1)).toBe(-6);
  });
});
