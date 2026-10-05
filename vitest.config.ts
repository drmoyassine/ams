import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ['{apps,packages}/*/src/**/*.test.{ts,tsx}'],
    env: {
      TEST_DATABASE_ADMIN_URL:
        process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres',
    },
  },
});
