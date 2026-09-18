import { describe, expect, it } from 'vitest';
import { BOTH_PRODUCTS_ENV, makeTestProgram } from './test/program.js';

describe('embeddings settings in config show', () => {
  it('masks the API key and shows its env source', async () => {
    const t = makeTestProgram({
      env: { ...BOTH_PRODUCTS_ENV, LASSI_EMBEDDINGS_API_KEY: 'sk-super-secret-value-1234' },
    });
    expect(await t.run(['config', 'show'])).toBe(0);
    expect(t.stdout()).toContain(
      '| embeddings.apiKey | ***set*** | env (LASSI_EMBEDDINGS_API_KEY) |'
    );
    expect(t.stdout()).not.toContain('sk-super-secret-value-1234');
    const json = makeTestProgram({
      env: { ...BOTH_PRODUCTS_ENV, LASSI_EMBEDDINGS_API_KEY: 'sk-super-secret-value-1234' },
    });
    await json.run(['config', 'show', '--json']);
    expect(json.stdout()).not.toContain('sk-super-secret-value-1234');
    expect(json.stdout()).toContain('"embeddings.apiKey": "***set***"');
  });
});
