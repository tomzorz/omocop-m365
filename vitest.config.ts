import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Tests reach into the real filesystem for attachment round-trips, so they
    // must not share a working directory.
    pool: 'forks',
  },
});
