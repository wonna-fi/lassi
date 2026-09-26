import type { Route } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import { BOTH_PRODUCTS_ENV, makeTestProgram } from '../../test/program.js';
import { exportRenderHash } from './export-manifest.js';

const issue = (key: string) => ({
  id: key === 'PROJ-1' ? '1' : '2',
  key,
  fields: {
    summary: 'Login fails',
    description: 'Steps',
    updated: '2026-09-01',
    customfield_10001: 'Platform',
    comment: {
      total: 1,
      startAt: 0,
      maxResults: 1,
      comments: [{ id: '1', body: 'Discussion', created: '2026-09-01' }],
    },
  },
});
const dir = '/home/u/.lassi/export/jira';
function setup() {
  let selected = ['PROJ-1', 'PROJ-2'];
  let fail = false;
  const routes: Route[] = [
    {
      path: '/rest/api/2/search',
      handler: () =>
        fail
          ? // A server that echoes the credential back in its error text.
            { status: 503, json: { errorMessages: ['unavailable for token jira-secret-token'] } }
          : {
              json: {
                issues: selected.map(issue),
                startAt: 0,
                maxResults: 100,
                total: selected.length,
              },
            },
    },
  ];
  const p = makeTestProgram({ env: { ...BOTH_PRODUCTS_ENV }, routes });
  return {
    p,
    select: (keys: string[]) => {
      selected = keys;
    },
    fail: () => {
      fail = true;
    },
    manifest: async () => JSON.parse(await p.fs.readFile(`${dir}/manifest.json`)),
  };
}
const args = ['jira', 'issue', 'export', 'project = PROJ'];

describe('export archive coverage', () => {
  it('refreshes unchanged remote issues when comments or aliases change', async () => {
    const { p, manifest } = setup();
    expect(await p.run(args)).toBe(0);
    expect(await p.fs.readFile(`${dir}/PROJ-1.md`)).not.toContain('## Comments');
    expect(await p.run([...args, '--comments'])).toBe(0);
    expect(await p.fs.readFile(`${dir}/PROJ-1.md`)).toContain('## Comments');
    const first = (await manifest()).items['PROJ-1'].renderHash;
    await p.fs.writeFile(
      '/home/u/proj/.lassi.json',
      JSON.stringify({ jira: { fields: { team: 'customfield_10001' } } })
    );
    expect(await p.run([...args, '--comments'])).toBe(0);
    expect(await p.fs.readFile(`${dir}/PROJ-1.md`)).toContain('team: Platform');
    expect((await manifest()).items['PROJ-1'].renderHash).not.toBe(first);
  });

  it('retains an archive without relabeling it as the narrower query snapshot', async () => {
    const s = setup();
    await s.p.run(args);
    s.select(['PROJ-1']);
    await s.p.run(['jira', 'issue', 'export', 'key = PROJ-1']);
    expect(await s.manifest()).toMatchObject({
      mode: 'archive',
      query: 'project = PROJ',
      queries: ['project = PROJ', 'key = PROJ-1'],
      lastRun: { query: 'key = PROJ-1', keys: ['PROJ-1'], complete: true },
    });
    expect(Object.keys((await s.manifest()).items)).toEqual(['PROJ-1', 'PROJ-2']);
    expect((await s.manifest()).runs[0]).toMatchObject({
      complete: true,
      keys: ['PROJ-1', 'PROJ-2'],
    });
  });

  it('refuses a different server before searching and adopts verified legacy sources', async () => {
    const s = setup();
    await s.p.run(args);
    const m = await s.manifest();
    delete m.source;
    delete m.items['PROJ-1'].renderHash;
    await s.p.fs.writeFile(`${dir}/manifest.json`, JSON.stringify(m));
    expect(await s.p.run(args)).toBe(0);
    const calls = s.p.fetch.calls.length;
    s.p.deps.env['LASSI_JIRA_URL'] = 'https://other.example.internal';
    expect(await s.p.run(args)).toBe(2);
    expect(s.p.fetch.calls).toHaveLength(calls);
  });

  it('records a failed attempt without calling it complete or losing earlier files', async () => {
    const s = setup();
    await s.p.run(args);
    s.fail();
    expect(await s.p.run(args)).toBe(1);
    expect(await s.manifest()).toMatchObject({
      lastRun: { complete: false, failed: { pagination: 'unavailable for token ***' } },
    });
    expect(await s.p.fs.readFile(`${dir}/manifest.json`)).not.toContain('jira-secret-token');
    expect(await s.p.fs.exists(`${dir}/PROJ-1.md`)).toBe(true);
  });

  it('does not replace local edits when the render options change', async () => {
    const s = setup();
    await s.p.run(args);
    const content = `${await s.p.fs.readFile(`${dir}/PROJ-1.md`)}\nLocal note`;
    await s.p.fs.writeFile(`${dir}/PROJ-1.md`, content);
    expect(await s.p.run([...args, '--comments'])).toBe(6);
    expect(await s.p.fs.readFile(`${dir}/PROJ-1.md`)).toBe(content);
    expect((await s.manifest()).lastRun.complete).toBe(false);
  });

  it('fingerprints aliases independently of property insertion order', () => {
    expect(exportRenderHash('jira', false, { a: 'x', b: 'y' })).toBe(
      exportRenderHash('jira', false, { b: 'y', a: 'x' })
    );
  });
});
