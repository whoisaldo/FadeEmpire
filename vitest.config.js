import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    // Pure-logic tests run in node; DOM tests opt into jsdom per-file
    // via `// @vitest-environment jsdom`.
    environment: 'node',
  },
});
