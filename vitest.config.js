import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    // Pure-logic tests run in node; DOM tests opt into jsdom per-file
    // via `// @vitest-environment jsdom`.
    environment: 'node',
    // vi.waitFor's deadline (tests/setup.js). Time in the DOM tests is the
    // fake clock's; the machine's clock only bounds a hang, so these limits
    // are generous enough that a loaded machine never trips them.
    setupFiles: ['tests/setup.js'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
