// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  medianFourfoldRatio,
  runRegexChild,
  runRegexScenario,
  type RegexScenarioResult,
} from './support/regexRuntimeHarness';
import { CHILD_PROCESS_TIMEOUT_MS } from './support/timeouts';

function expectNormalizedSamples(result: RegexScenarioResult): void {
  expect(result.samples).toHaveLength(10);
  for (const sample of result.samples) {
    expect(sample.iterations).toBeGreaterThan(0);
    expect(sample.elapsedCpuMs).toBeGreaterThanOrEqual(8);
    expect(sample.cpuMs).toBe(sample.elapsedCpuMs / sample.iterations);
  }
}

describe('bounded actual-module regex probes', () => {
  it(
    'rejects overlapping Unicode tag classes without exponential backtracking',
    async () => {
      const result = await runRegexScenario('tags');
      expect(result.outputs).toEqual(
        [4000, 16000].map((size) =>
          JSON.stringify([`#${'ℹ'.repeat(size)}`, null, `#${'\uFE0F'.repeat(size)}`, null]),
        ),
      );
      expectNormalizedSamples(result);
      expect(medianFourfoldRatio(result.samples)).toBeLessThan(8);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'does not rescan each unclosed comment suffix',
    async () => {
      const result = await runRegexScenario('comments');
      const expectedUnclosedCommentOutputs = [4000, 16000].map((size) =>
        JSON.stringify({
          visible: {
            text: '<!--'.repeat(size),
            map: [{ visible: { from: 0, to: 4 * size }, source: [{ from: 0, to: 4 * size }] }],
          },
          destinations: [],
        }),
      );
      expect(result.outputs).toEqual(expectedUnclosedCommentOutputs);
      expectNormalizedSamples(result);
      expect(medianFourfoldRatio(result.samples)).toBeLessThan(8);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'does not rescan malformed legacy-link suffixes',
    async () => {
      const result = await runRegexScenario('legacy-links');
      expect(result.outputs).toEqual(['a('.repeat(4000), 'a('.repeat(16000)]);
      expectNormalizedSamples(result);
      expect(medianFourfoldRatio(result.samples)).toBeLessThan(8);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'bounds bare, unequal and escaped backtick runs with exact ghost titles',
    async () => {
      const result = await runRegexScenario('ghost');
      expect(result.outputs).toEqual(
        [4000, 16000].map(() =>
          JSON.stringify(['', '`', 'leftright', 'a', '`a', 'a`', '``', '`', '`a`', 'a`']),
        ),
      );
      expectNormalizedSamples(result);
      expect(medianFourfoldRatio(result.samples)).toBeLessThan(8);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it('rejects quadratic per-operation cost even when adaptive batches take equal CPU', () => {
    const samples = [
      { size: 4000, cpuMs: 0.125, iterations: 64, elapsedCpuMs: 8 },
      { size: 16000, cpuMs: 2, iterations: 4, elapsedCpuMs: 8 },
    ];
    expect(medianFourfoldRatio(samples)).toBe(16);
    expect(medianFourfoldRatio(samples) < 8).toBe(false);
  });

  it(
    'bounds one- and two-tick near misses at escaped and Unicode line boundaries',
    async () => {
      const result = await runRegexScenario('ghost-bounded');
      expect(result.outputs).toEqual(
        [4000, 16000].map((size) =>
          JSON.stringify([
            `\`${'a'.repeat(size)}\``,
            `${'a'.repeat(size)}\`\``,
            `${'a'.repeat(size)}\u2028b`,
            `${'a'.repeat(size)}\u2029b`,
          ]),
        ),
      );
      expectNormalizedSamples(result);
      expect(medianFourfoldRatio(result.samples)).toBeLessThan(8);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'hard-terminates a synchronous child at the actual probe deadline',
    async () => {
      // Use the probe's normal startup budget before requiring proof that its code ran.
      await expect(
        runRegexChild('require("node:fs").writeSync(1, "blocking"); while (true) {}'),
      ).rejects.toThrow(/exceeded 4000ms deadline; exit=null signal=SIGKILL.*stdout=blocking/u);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it(
    'enforces an immediate deadline without requiring output from the child',
    async () => {
      await expect(runRegexChild('while (true) {}', 0)).rejects.toThrow(
        /exceeded 0ms deadline; exit=null signal=SIGKILL.*stdout=$/u,
      );
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );

  it.each([
    ['process.exit(2)', /exit=2/u],
    ['process.stderr.write("unexpected diagnostic")', /stderr=unexpected diagnostic/u],
  ])(
    'reports a failed child actionably: %s',
    async (contents, failure) => {
      await expect(runRegexChild(contents)).rejects.toThrow(failure);
    },
    CHILD_PROCESS_TIMEOUT_MS,
  );
});
