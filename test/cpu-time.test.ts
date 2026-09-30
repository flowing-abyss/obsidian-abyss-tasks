import { describe, expect, it } from 'vitest';
import { cpuMilliseconds } from './support/cpuTime';

describe('cpuMilliseconds', () => {
  it('leaves out the time the thread waits and moves in steps under 0.05 ms', () => {
    const cell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const waits = [0, 1, 2].map(() => {
      const wallStart = performance.now();
      const cpuStart = cpuMilliseconds();
      Atomics.wait(cell, 0, 0, 100);
      return { cpuMs: cpuMilliseconds() - cpuStart, wallMs: performance.now() - wallStart };
    });
    for (const { wallMs } of waits) expect(wallMs).toBeGreaterThanOrEqual(100);
    // A collection that is marking can add tens of milliseconds to one wait through helper threads.
    expect(Math.min(...waits.map(({ cpuMs }) => cpuMs))).toBeLessThan(20);

    const steps: number[] = [];
    const wallStart = performance.now();
    const first = cpuMilliseconds();
    let last = first;
    while (last - first < 20 && performance.now() - wallStart < 2_000) {
      const reading = cpuMilliseconds();
      if (reading !== last) steps.push(reading - last);
      last = reading;
    }
    const distinctReadings = steps.length + 1;
    expect(distinctReadings).toBeGreaterThanOrEqual(100);
    steps.sort((left, right) => left - right);
    expect(steps[Math.floor(steps.length / 2)]).toBeLessThan(0.05);
  });
});
