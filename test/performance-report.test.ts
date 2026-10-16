// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseRun, renderReport } from '../tooling/performance/report';
import { compareRuns, summarize } from '../tooling/performance/statistics';
import type { ProfileRun } from '../tooling/performance/types';

function run(values: number[], overrides: Partial<ProfileRun> = {}): ProfileRun {
  return {
    schemaVersion: 1,
    id: 'test',
    createdAt: '2026-10-16T00:00:00Z',
    status: 'complete',
    restored: true,
    identity: { fixture: 'same', viewport: '1280x800' },
    build: { commit: 'abc', dirty: false, sha256: 'exact' },
    expectedScenarios: ['startup'],
    samples: values.map((durationMs, iteration) => ({
      scenario: 'startup',
      iteration,
      durationMs,
      longTasks: 0,
      longTaskMs: 0,
      maxFrameGapMs: 0,
      domNodes: 10,
      facts: { roots: 4000 },
    })),
    diagnostics: [],
    errors: [],
    ...overrides,
  };
}

describe('native performance statistics', () => {
  it('reports distribution without pretending low-count p95 is stable', () => {
    expect(summarize([100, 1, 4, 2, 3])).toEqual({
      n: 5,
      median: 3,
      p95: 100,
      mad: 1,
      min: 1,
      max: 100,
      lowSampleCount: true,
    });
    expect(() => summarize([])).toThrow();
    expect(() => summarize([NaN])).toThrow();
    expect(() => summarize([-1])).toThrow();
  });
  it('separates material changes, equivalence and uncertain samples', () => {
    const before = run(Array<number>(20).fill(100));
    expect(compareRuns(before, run(Array<number>(20).fill(140))).scenarios[0]?.verdict).toBe(
      'regression',
    );
    expect(compareRuns(before, run(Array<number>(20).fill(60))).scenarios[0]?.verdict).toBe(
      'improvement',
    );
    expect(compareRuns(before, run(Array<number>(20).fill(102))).scenarios[0]?.verdict).toBe(
      'no-material-difference',
    );
    expect(compareRuns(before, run([100, 100])).scenarios[0]?.verdict).toBe('inconclusive');
    const noisy = run(Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 10 : 250)));
    expect(compareRuns(before, noisy).scenarios[0]?.verdict).toBe('inconclusive');
    expect(compareRuns(before, noisy)).toEqual(compareRuns(before, noisy));
  });
  it('rejects incompatible, failed, missing and logically different work', () => {
    const before = run(Array<number>(20).fill(100));
    for (const candidate of [
      run([100], { identity: { fixture: 'changed' } }),
      run([100], { status: 'failed' }),
      run([100], { restored: false }),
      run([100], { expectedScenarios: ['startup', 'search'] }),
      run([100], { samples: [] }),
      run([100], { errors: ['runtime failed'] }),
    ])
      expect(compareRuns(before, candidate).compatible).toBe(false);
    const changed = run(Array<number>(20).fill(90));
    const first = changed.samples[0];
    if (first === undefined) throw new Error('Missing sample');
    first.facts = { roots: 3999 };
    expect(compareRuns(before, changed).compatible).toBe(false);
  });
  it('validates saved results and escapes report labels', () => {
    const saved = run([12, 15], { id: 'test|<script>' });
    expect(parseRun(JSON.stringify(saved))).toEqual(saved);
    expect(() => parseRun('{"schemaVersion":99}')).toThrow();
    expect(() => parseRun(JSON.stringify({ ...saved, samples: [{ durationMs: null }] }))).toThrow();
    expect(renderReport(saved)).toContain('12');
    expect(renderReport(saved)).not.toContain('<script>');
  });
});
