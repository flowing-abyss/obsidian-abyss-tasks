import { Platform, setIcon } from 'obsidian';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { runtimeReferences } from './architecture/runtimeReferences';
import { interleavedRatio, subtask, task, useRealMoment, withMobile } from './helpers';

const processClock = vi.hoisted(() => ({ read: (): number => 0 }));

vi.mock('./support/cpuTime', () => ({ cpuMilliseconds: () => processClock.read() }));

interface StubCosts {
  readonly small: (call: number) => number;
  readonly large: (call: number) => number;
}

interface StubBatch {
  readonly input: 'small' | 'large';
  readonly ms: number;
}

interface StubReading {
  readonly at: number;
  readonly input: StubBatch['input'];
}

interface StubClock {
  readonly small: () => void;
  readonly large: () => void;
  readonly clock: () => number;
  readonly batches: () => readonly StubBatch[];
}

/**
 * A clock that only its own calls advance: each call of `small` or `large` by the cost `costs`
 * gives that call, counting the calls of each from 0. It keeps every reading, so a row can read each
 * batch the helper timed: the helper reads the clock once before and once after a batch.
 */
function stubClock(costs: StubCosts): StubClock {
  let now = 0;
  let smallCalls = 0;
  let largeCalls = 0;
  let lastInput: StubBatch['input'] = 'small';
  const readings: StubReading[] = [];
  return {
    small: () => {
      now += costs.small(smallCalls);
      smallCalls += 1;
      lastInput = 'small';
    },
    large: () => {
      now += costs.large(largeCalls);
      largeCalls += 1;
      lastInput = 'large';
    },
    clock: () => {
      readings.push({ at: now, input: lastInput });
      return now;
    },
    batches: () =>
      readings.flatMap((end, index) => {
        const start = readings[index - 1];
        return index % 2 === 1 && start !== undefined
          ? [{ input: end.input, ms: end.at - start.at }]
          : [];
      }),
  };
}

const ROOT = ts.sys.resolvePath(`${import.meta.dirname}/..`);
const PRESENTATION_FOLDERS = ['src/panels/', 'src/views/', 'src/ui/'];
const CODE_FILE = /\.[cm]?[jt]sx?$/;
const RESOLVED_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '/index.ts'];

interface ModuleGraph {
  /** Each module reached, relative to the repository, with the chain of modules that loads it. */
  readonly chains: ReadonlyMap<string, readonly string[]>;
  /**
   * Each place the graph cannot be followed: a specifier that is not a string literal, a module
   * that does not resolve, or a file that cannot be read.
   */
  readonly unreadable: readonly string[];
}

/**
 * Every module `entry` loads at run time, followed through each module outside packages (test
 * support and `src/` alike) by the run-time references the time limit check reads.
 */
function runtimeModuleGraph(entry: string): ModuleGraph {
  const chains = new Map<string, readonly string[]>([[entry, [entry]]]);
  const unreadable: string[] = [];
  const pending = [entry];
  for (let current = pending.shift(); current !== undefined; current = pending.shift()) {
    const chain = chains.get(current) ?? [current];
    const text = ts.sys.readFile(`${ROOT}/${current}`);
    if (text === undefined) {
      unreadable.push(`${current}: cannot be read`);
      continue;
    }
    const file = ts.createSourceFile(current, text, ts.ScriptTarget.Latest);
    for (const reference of runtimeReferences(file)) {
      const line = file.getLineAndCharacterOfPosition(reference.node.getStart(file)).line + 1;
      const { specifier } = reference;
      if (specifier === undefined) {
        unreadable.push(
          `${current}:${line}: ${reference.form} of a specifier that is not a string`,
        );
        continue;
      }
      if (!specifier.startsWith('.')) continue;
      const base = ts.sys.resolvePath(`${ROOT}/${current}/../${specifier}`);
      const resolved = RESOLVED_SUFFIXES.map((suffix) => `${base}${suffix}`).find((candidate) =>
        ts.sys.fileExists(candidate),
      );
      if (resolved === undefined) {
        unreadable.push(`${current}:${line}: ${specifier} does not resolve`);
        continue;
      }
      const target = resolved.slice(ROOT.length + 1);
      if (chains.has(target)) continue;
      chains.set(target, [...chain, target]);
      if (CODE_FILE.test(target)) pending.push(target);
    }
  }
  return { chains, unreadable };
}

function shifts(count: number): number[] {
  return Array.from({ length: count }, (_, shift) => shift);
}

describe('test helpers', () => {
  describe('useRealMoment', () => {
    useRealMoment();
    it('installs real moment as window.moment', () => {
      expect(window.moment('2026-06-24').isSame('2026-06-24', 'day')).toBe(true);
      expect(window.moment('2026-06-25').isAfter('2026-06-24', 'day')).toBe(true);
    });
    it('supports date arithmetic', () => {
      expect(window.moment('2026-06-24').add(1, 'day').format('YYYY-MM-DD')).toBe('2026-06-25');
    });
  });

  describe('withMobile', () => {
    withMobile(true);
    it('sets Platform.isMobile to the given value for the block', () => {
      expect(Platform.isMobile).toBe(true);
    });
  });

  describe('task builder', () => {
    it('produces a Task with sensible defaults', () => {
      const t = task();
      expect(t.source.filePath).toBe('f.md');
      expect(t.status).toBe('open');
      expect(t.priority).toBe('D');
    });
    it('overrides win', () => {
      const t = task({ status: 'done', priority: 'A', planning: { due: '2026-06-24' } });
      expect(t.status).toBe('done');
      expect(t.priority).toBe('A');
      expect(t.planning.due).toBe('2026-06-24');
    });
  });

  describe('subtask builder', () => {
    it('preserves dependency metadata and clones the dependency list override', () => {
      const dependsOn = ['schema', 'auth', 'schema'];
      const child = subtask({ dependencyId: 'build-api', dependsOn });

      expect(child.dependencyId).toBe('build-api');
      expect(child.dependsOn).toEqual(['schema', 'auth', 'schema']);
      expect(child.dependsOn).not.toBe(dependsOn);
    });
  });

  describe('obsidian alias resolution (proves vitest.config fix)', () => {
    it('resolves imports from obsidian via obsidian-test-mocks', () => {
      // setIcon is a function from the mocked obsidian module
      expect(typeof setIcon).toBe('function');
    });
  });

  describe('module graph', () => {
    it('loads no presentation module from test/helpers.ts', () => {
      const { chains, unreadable } = runtimeModuleGraph('test/helpers.ts');
      const presentation = [...chains]
        .filter(([module]) => PRESENTATION_FOLDERS.some((folder) => module.startsWith(folder)))
        .map(([, chain]) => chain.join(' > '));

      expect([...chains.keys()].some((module) => module.startsWith('src/'))).toBe(true);
      expect(presentation).toEqual([]);
      expect(unreadable).toEqual([]);
    });
  });

  describe('interleavedRatio', () => {
    const PAIRS = 41;
    const MIN_SAMPLE_MS = 0.1;
    // The ratio cases count in tenths, so that every batch reads a whole number: read off a running
    // clock in whole units, 2.4 over 0.6 comes out a little above 4. Every small batch then reads
    // far above minSampleMs, so each batch runs one call, and the helper calls small once, then
    // three times to calibrate, five times in the warm-up pairs, and three times to calibrate again,
    // before its recorded pairs: recorded pair `pair` runs call 12 + pair of small and call
    // 6 + pair of large.
    const SMALL = 10;
    const LARGE = 40;
    const LUMP = 100;
    const FAST_SMALL = 6;
    const FAST_LARGE = 24;
    const FIRST_RECORDED_SMALL_CALL = 12;
    const FIRST_RECORDED_LARGE_CALL = 6;

    const ratioCases: ReadonlyArray<readonly [name: string, phases: readonly StubCosts[]]> = [
      [
        'two of every three calls of large cost 10 more',
        shifts(3).map((shift) => ({
          small: () => SMALL,
          large: (call) => LARGE + ((call + shift) % 3 === 0 ? 0 : LUMP),
        })),
      ],
      [
        'two of every three calls of small cost 10 more',
        shifts(3).map((shift) => ({
          small: (call) => SMALL + ((call + shift) % 3 === 0 ? 0 : LUMP),
          large: () => LARGE,
        })),
      ],
      [
        'one call of small in eight costs 0.6',
        shifts(8).map((shift) => ({
          small: (call) => ((call + shift) % 8 === 0 ? FAST_SMALL : SMALL),
          large: () => LARGE,
        })),
      ],
      [
        'three consecutive recorded calls of small cost 10 more',
        shifts(PAIRS - 2).map((first) => ({
          small: (call) => {
            const pair = call - FIRST_RECORDED_SMALL_CALL;
            return pair >= first && pair < first + 3 ? SMALL + LUMP : SMALL;
          },
          large: () => LARGE,
        })),
      ],
      [
        'the calls of small cost 0.6 through 26 recorded pairs and one call of large inside costs 2.4',
        shifts(PAIRS - 25).flatMap((first) =>
          shifts(26).map((offset) => ({
            small: (call) => {
              const pair = call - FIRST_RECORDED_SMALL_CALL;
              return pair >= first && pair < first + 26 ? FAST_SMALL : SMALL;
            },
            large: (call) =>
              call - FIRST_RECORDED_LARGE_CALL === first + offset ? FAST_LARGE : LARGE,
          })),
        ),
      ],
      [
        'one call of small among the middle recorded pairs costs 0.6 and four of every five calls of large cost 10 more',
        shifts(21).flatMap((middle) =>
          shifts(5).map((shift) => ({
            small: (call) =>
              call - FIRST_RECORDED_SMALL_CALL === 10 + middle ? FAST_SMALL : SMALL,
            large: (call) => LARGE + ((call + shift) % 5 === 0 ? 0 : LUMP),
          })),
        ),
      ],
    ];

    function recordedSmallBatches(stub: StubClock): number[] {
      return stub
        .batches()
        .slice(-2 * PAIRS)
        .filter(({ input }) => input === 'small')
        .map(({ ms }) => ms);
    }

    it.each(ratioCases)('reads exactly 4 when %s, in every phase', (_, phases) => {
      const readings = phases.map((costs) => {
        const stub = stubClock(costs);
        return interleavedRatio({ small: stub.small, large: stub.large, clock: stub.clock });
      });

      expect(new Set(readings)).toEqual(new Set([4]));
    });

    it('reads the process CPU clock when no clock is given', () => {
      const stub = stubClock({ small: () => SMALL, large: () => LARGE });
      processClock.read = stub.clock;

      expect(interleavedRatio({ small: stub.small, large: stub.large })).toBe(4);
    });

    it('calibrates again after the warm-up pairs', () => {
      // The first calibration doubles repeat to 4 over calls 1 to 21 of small, and the warm-up pairs
      // run calls 22 to 41 of small and 1 to 20 of large. After them each call costs a tenth, as
      // code the warm-up sped up would.
      const stub = stubClock({
        small: (call) => (call < 42 ? 0.03 : 0.003),
        large: (call) => (call < 21 ? 0.12 : 0.012),
      });
      interleavedRatio({ small: stub.small, large: stub.large, clock: stub.clock });
      const batches = recordedSmallBatches(stub);

      expect(batches).toHaveLength(PAIRS);
      expect(Math.min(...batches)).toBeGreaterThanOrEqual(MIN_SAMPLE_MS);
    });

    it('calibrates on the fastest of three small batches', () => {
      // The helper calibrates over calls 1 to 21 and 42 to 53 of small, and there every third call
      // costs minSampleMs more, as a batch that carries a collector's work on a helper thread does.
      const calibrating = (call: number): boolean =>
        (call >= 1 && call <= 21) || (call >= 42 && call <= 53);
      const leastPerPhase = shifts(3).map((shift) => {
        const stub = stubClock({
          small: (call) =>
            0.03 + (calibrating(call) && (call + shift) % 3 === 0 ? MIN_SAMPLE_MS : 0),
          large: () => 0.12,
        });
        interleavedRatio({ small: stub.small, large: stub.large, clock: stub.clock });
        const batches = recordedSmallBatches(stub);
        expect(batches).toHaveLength(PAIRS);
        return Math.min(...batches);
      });

      expect(Math.min(...leastPerPhase)).toBeGreaterThanOrEqual(MIN_SAMPLE_MS);
    });
  });
});
