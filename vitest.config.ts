import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./tests/setup.ts'],
    hookTimeout: 20000,
    testTimeout: 20000,
    // Defensive: dist/ is gitignored build output, but if anyone runs plain `tsc`
    // (without --noEmit) it mirrors tests/**/*.test.ts as compiled .js, which Vitest
    // would otherwise also pick up and fail on (CJS/ESM mismatch), duplicating every test.
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
