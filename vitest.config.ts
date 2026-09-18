import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests resolve workspace packages to their sources so they run without a build and every package
// sees the same module instance (structural checks like `isLassiError` do not depend on this, but
// `instanceof` in tests does). `tsc -b` still validates the real `exports` graph.
const src = (p: string): string => fileURLToPath(new URL(`./packages/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@wonna\/lassi-core\/testing$/, replacement: src('core/src/testing/index.ts') },
      { find: /^@wonna\/lassi-core$/, replacement: src('core/src/index.ts') },
      { find: /^@wonna\/lassi-jira$/, replacement: src('jira/src/index.ts') },
      { find: /^@wonna\/lassi-confluence$/, replacement: src('confluence/src/index.ts') },
      { find: /^@wonna\/lassi-search$/, replacement: src('search/src/index.ts') },
    ],
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    environment: 'node',
    // `jira digest` prints its window in local time on purpose, so the expected strings only hold
    // in a fixed zone. CI happens to run in UTC; a developer machine does not.
    env: { TZ: 'UTC' },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/src/testing/**', '**/src/test/**'],
      // The converters are the risk (AGENTS.md): the dialect code must stay above 90 % lines.
      thresholds: {
        'packages/jira/src/wiki/**/*.ts': { lines: 90, statements: 90, branches: 80 },
        'packages/confluence/src/convert/**/*.ts': { lines: 90, statements: 90, branches: 80 },
      },
    },
  },
});
