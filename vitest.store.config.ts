import { defineConfig } from 'vitest/config';

// `pnpm lint:store`: the community directory's review lint, a type-aware pass over the whole
// repository, kept out of the unit suite and its coverage.
export default defineConfig({
  test: {
    include: ['test/store/**/*.test.ts'],
    setupFiles: ['obsidian-test-mocks/vitest-setup'],
    environment: 'jsdom',
    testTimeout: 120_000,
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
