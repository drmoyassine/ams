import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { fileParallelism: false, include: ['{apps,packages}/*/src/**/*.test.ts'] },
});
