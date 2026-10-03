// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { clampDurationToDay, durationMinutes, localTime } from '../../src/tasks';

describe('clampDurationToDay', () => {
  it.each([
    ['20:30', 1200, 210],
    ['20:30', 5940, 210],
    ['23:59', 60, 1],
    ['00:00', 1500, 1440],
    ['09:00', 60, 60],
  ])('bounds %s + %i minutes to %i', (time, duration, expected) => {
    expect(clampDurationToDay(localTime(time), durationMinutes(duration))).toBe(expected);
  });

  it.each([
    [1500, 1440],
    [1440, 1440],
    [1320, 1320],
  ])('bounds an untimed %i minute block to %i', (duration, expected) => {
    expect(clampDurationToDay(undefined, durationMinutes(duration))).toBe(expected);
  });

  it('keeps the standalone duration value capable of representing 99 hours', () => {
    expect(durationMinutes(5940)).toBe(5940);
  });
});
