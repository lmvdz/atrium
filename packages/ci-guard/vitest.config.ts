import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'ci-guard',
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
