import { describe, expect, it } from 'vitest';
import { makeTestProgram } from './test/program.js';

describe('storage and write protection', () => {
  it.each(['1', 'true', 'yes'])(
    'blocks writes before network access when read-only is %s',
    async (value) => {
      const t = makeTestProgram({ env: { LASSI_READ_ONLY: value } });
      expect(await t.run(['jira', 'comment', 'add', 'PROJ-1', '--body', 'hello'])).toBe(7);
      expect(t.fetch.calls).toHaveLength(0);
      expect(t.stderr()).toContain('LASSI_READ_ONLY is set');
    }
  );

  it('permits a local dry-run while read-only is enabled', async () => {
    const t = makeTestProgram({
      env: { LASSI_READ_ONLY: '1' },
      files: { '/repo/skills/jira/SKILL.md': '---\nname: jira\n---\n# Jira\n' },
    });
    expect(await t.run(['skills', 'install', '--only', 'jira', '--dry-run'])).toBe(0);
    expect(t.fetch.calls).toHaveLength(0);
  });

  it('refuses indexing before embedding when the index is locked', async () => {
    const t = makeTestProgram({
      env: {
        LASSI_EMBEDDINGS_URL: 'https://embeddings.example.internal/v1',
        LASSI_EMBEDDINGS_API_KEY: 'test-key',
      },
      files: {
        '/home/u/.lassi.json': JSON.stringify({ embeddings: { model: 'test-model' } }),
        '/home/u/.lassi/export/jira/PROJ-1.md':
          '---\nkey: PROJ-1\nsummary: Example\nlassi: { product: jira, schema: 1 }\n---\nExample content.',
        '/home/u/.lassi/index/default/.lassi-write.lock': '{}',
      },
    });
    expect(await t.run(['search', 'index'])).toBe(6);
    expect(t.fetch.calls).toHaveLength(0);
    expect(t.stderr()).toContain('.lassi-write.lock');
  });
});
