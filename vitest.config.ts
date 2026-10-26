import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
    include: ['{apps,packages}/*/src/**/*.test.{ts,tsx}'],
    env: {
      TEST_DATABASE_ADMIN_URL:
        process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres',
    },
  },
});
