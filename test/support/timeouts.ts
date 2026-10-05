/**
 * The time limits of rows and hooks whose work is heavy by kind. A row or hook that reaches one of
 * these kinds names the limit of its largest kind from this module: as its last argument after the
 * body, as the `timeout` of its options, or as a hook's second argument. Light work names no limit
 * and runs on the configs' `testTimeout` and `hookTimeout`. test/test-timeouts.test.ts holds every
 * row and hook to its kind.
 *
 * Every limit, the configs' included, is twice the slowest time its kind of work took, rounded up
 * to 5 s. The original four kinds cover heavy files at 30 busy loops on the gate's forks pool
 * (with coverage, lint:store without), sizing rounds under the same load, CI's Node 22 and 24
 * runners, and SP1o's gate durations at load 38 for stopped rows (lower bounds). The lifecycle
 * audit kind follows the same formula with its separate measurement documented below. When a
 * sizing round puts a row or hook above half its limit, its kind re-sizes
 * once: to two and a half times the kind's slowest time with every sizing round so far included,
 * rounded up to 5 s, so that the next round does not depend on no row beating its own record. The
 * time limit check's own rows neither start a re-size nor count toward one. Every limit here stays
 * above the configs' limit: a kind that the light limit reaches merges into light work.
 */

/**
 * A type-aware ESLint instance: its first lint in a worker loads eslint.config.mts and starts the
 * project service, and lint:store lints the whole repository in one row. Twice the project policy
 * row's 59.7 s at SP1o's load 38 (the architecture row took 51.1 s there, lint:store's code row
 * 46.1 s at 30 busy loops).
 */
export const LINTER_TIMEOUT_MS = 120_000;

/**
 * A TypeScript program over the source tree or a fixture, and the first checker queries, which
 * bind and check lazily. Twice the storage inventory row's 38.8 s at SP1o's load 38 (the settings
 * rows took 33.8 s there, the mangling row 31.7 s).
 */
export const TYPESCRIPT_PROGRAM_TIMEOUT_MS = 80_000;

/**
 * A source walk: listing a directory and parsing the TypeScript files in it. Two and a half times
 * the task consumer contract row's 30.46 s in the plan's round under 30 busy loops, re-sized from
 * twice its 27.75 s at 30 busy loops (the allowlist walk took 21.8 s at SP1o's load 38). It ties
 * with the program limit, so work of both kinds names either.
 */
export const SOURCE_WALK_TIMEOUT_MS = 80_000;

/**
 * A child process: a cold Node or shell start. Twice the release stylesheet row's 7.6 s at SP1o's
 * load 38 (the CSS policy CLI row took 7.33 s at 30 busy loops).
 */
export const CHILD_PROCESS_TIMEOUT_MS = 20_000;

/**
 * A paired 1000/10000-row lifecycle audit with twenty full-range outward/return cycles per
 * scale, retaining real DOM, Components and native resource recording. Twice Table's 108.461 s
 * in the 2026-10-04 diagnostic coverage run on Node 26 with 30 busy loops and concurrent shared
 * machine test workers, rounded up to 5 s. The other five cases completed in 8.080–47.113 s;
 * quiet covering coverage took 1.325–8.090 s. Only the exact full-cycle helper owns this kind.
 */
export const VIRTUAL_SURFACE_AUDIT_TIMEOUT_MS = 220_000;
