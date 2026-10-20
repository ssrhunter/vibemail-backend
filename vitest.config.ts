import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
    hookTimeout: 20000,
    testTimeout: 20000,
  },
});
