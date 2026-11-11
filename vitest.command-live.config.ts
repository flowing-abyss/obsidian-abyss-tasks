import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['test/command-live/live.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 3_600_000,
    hookTimeout: 30_000,
  },
});
