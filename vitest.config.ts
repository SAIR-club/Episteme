import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    // Core must stay runnable without a frontend, an LLM or a database, so the
    // default node environment is the contract rather than a convenience.
    environment: 'node',
    passWithNoTests: false,
    // Tests that open a real graph take about 1.5s, but reached 6.75s on a slow Windows runner and failed main's CI at
    // the default 5s. This only moves where a hung test gets cut off.
    testTimeout: 20_000,
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 4,
      },
    },
  },
})
