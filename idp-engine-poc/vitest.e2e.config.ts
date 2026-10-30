import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Needs Postgres (docker compose up -d). Runs with ENGINES_ENABLED=fake, so no vendor calls.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
