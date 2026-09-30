import { defineConfig } from 'vitest/config';

// `pnpm lint:store`: the community directory's review lint, a type-aware pass over the whole
// repository, kept out of the unit suite and its coverage.
export default defineConfig({
  test: {
    include: ['test/store/**/*.test.ts'],
    setupFiles: ['obsidian-test-mocks/vitest-setup'],
    environment: 'jsdom',
    // Written out, though it is the default, so that Vitest stops advising `isolate: false`.
    isolate: true,
    // Light work runs on these limits and heavy work names its kind's limit from
    // test/support/timeouts.ts, all sized on this pool; test/test-timeouts.test.ts holds them.
    pool: 'forks',
    testTimeout: 10_000,
    hookTimeout: 10_000,
    alias: {
      obsidian: 'obsidian-test-mocks/obsidian',
    },
    server: {
      deps: {
        inline: ['@obsidian-typings', 'obsidian-dev-utils'],
      },
    },
  },
});
