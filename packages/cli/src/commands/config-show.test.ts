import { describe, expect, it } from 'vitest';
import { makeTestProgram } from '../test/program.js';

describe('config show', () => {
  it('lists every setting with its source and masks tokens', async () => {
    const t = makeTestProgram({
      env: { LASSI_JIRA_TOKEN: 'env-secret-token' },
      files: {
        '/home/u/.lassi.json': JSON.stringify({
          jira: { url: 'https://jira.example.internal', tokenFile: '~/t.txt' },
        }),
        '/home/u/proj/.lassi.json': JSON.stringify({
          jira: { fields: { team: 'customfield_10001' } },
        }),
      },
    });
    expect(await t.run(['config', 'show'])).toBe(0);
    const out = t.stdout();
    expect(out).toContain('global config: ~/.lassi.json');
    expect(out).toContain('workspace config: ~/proj/.lassi.json');
    expect(out).toContain('| jira.url | https://jira.example.internal | ~/.lassi.json |');
    expect(out).toContain('| jira.token | ***set*** | env (LASSI_JIRA_TOKEN) |');
    expect(out).toContain('| jira.tokenFile | /home/u/t.txt | ~/.lassi.json |');
    expect(out).toContain('| jira.fields.team | customfield_10001 | ~/proj/.lassi.json |');
    expect(out).toContain('| http.timeoutMs | 30000 | default |');
    expect(out).toContain('| storage.exportDir | /home/u/.lassi/export | default |');
    expect(out).toContain('| storage.indexDir | /home/u/.lassi/index | default |');
    expect(out).not.toContain('env-secret-token');
  });

  it('--json masks tokens too', async () => {
    const t = makeTestProgram({ env: { LASSI_CONFLUENCE_TOKEN: 'env-secret-token' } });
    await t.run(['config', 'show', '--json']);
    const doc = JSON.parse(t.stdout()) as {
      config: Record<string, unknown>;
      sources: Record<string, unknown>;
    };
    expect(doc.config['confluence.token']).toBe('***set***');
    expect(doc.sources['confluence.token']).toEqual({
      source: 'env',
      from: 'LASSI_CONFLUENCE_TOKEN',
    });
    expect(t.stdout()).not.toContain('env-secret-token');
  });
});
