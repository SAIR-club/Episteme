import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    // Core must stay runnable without a frontend, an LLM or a database, so the
    // default node environment is the contract rather than a convenience.
    environment: 'node',
    passWithNoTests: false,
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 4,
      },
    },
  },
})
