import { createHash } from 'node:crypto';
import type { Route } from '@wonna/lassi-core/testing';
import { fieldPolicy } from '@wonna/lassi-jira';
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
    expect(await p.fs.readFile(`${dir}/PROJ-1.md`)).toContain('\n  team: Platform\n');
    const second = (await manifest()).items['PROJ-1'].renderHash;
    expect(second).not.toBe(first);

    // Making the field editable moves it out of `readonly`, so the archive must render again.
    await p.fs.writeFile(
      '/home/u/proj/.lassi.json',
      JSON.stringify({ jira: { fields: { team: { id: 'customfield_10001', editable: true } } } })
    );
    expect(await p.run([...args, '--comments'])).toBe(0);
    expect(await p.fs.readFile(`${dir}/PROJ-1.md`)).toContain('\nteam: Platform\n');
    expect((await manifest()).items['PROJ-1'].renderHash).not.toBe(second);
  });

  it('keeps an excluded volatile field out of re-rendered archives', async () => {
    let reads = 0;
    let summary = 'Login fails';
    const routes: Route[] = [
      {
        path: '/rest/api/2/search',
        handler: () => {
          reads += 1;
          const one = issue('PROJ-1');
          return {
            json: {
              issues: [
                {
                  ...one,
                  fields: {
                    ...one.fields,
                    summary,
                    updated: summary === 'Login fails' ? '2026-09-01' : '2026-09-02',
                    // Fabricated: a plugin value whose object hash differs on every read.
                    customfield_10040: `{summaryBean=example.SummaryBean@${reads.toString(16)}a1}`,
                  },
                },
              ],
              startAt: 0,
              maxResults: 100,
              total: 1,
            },
          };
        },
      },
    ];
    const p = makeTestProgram({ env: { ...BOTH_PRODUCTS_ENV }, routes });
    await p.fs.writeFile(
      '/home/u/proj/.lassi.json',
      JSON.stringify({
        jira: { fields: { development: { id: 'customfield_10040', exclude: true } } },
      })
    );
    expect(await p.run(args)).toBe(0);
    const before = await p.fs.readFile(`${dir}/PROJ-1.md`);
    expect(before).not.toContain('summaryBean');
    summary = 'Login fails on empty password';
    expect(await p.run(args)).toBe(0);
    const after = await p.fs.readFile(`${dir}/PROJ-1.md`);
    const changed = after.split('\n').filter((line, i) => line !== before.split('\n')[i]);
    expect(changed).toEqual(['summary: Login fails on empty password', '  updated: 2026-09-02']);
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

  it('fingerprints the field policy independently of property insertion order', () => {
    expect(
      exportRenderHash(
        'jira',
        false,
        fieldPolicy({
          a: { id: 'customfield_1', editable: true, format: 'wiki' },
          b: { id: 'customfield_2', exclude: true },
        })
      )
    ).toBe(
      exportRenderHash(
        'jira',
        false,
        fieldPolicy({
          b: { exclude: true, id: 'customfield_2' },
          a: { format: 'wiki', id: 'customfield_1', editable: true },
        })
      )
    );
    expect(exportRenderHash('jira', false, fieldPolicy({ a: 'customfield_1' }))).not.toBe(
      exportRenderHash('jira', false, fieldPolicy({ a: { id: 'customfield_1', editable: true } }))
    );
  });

  it('leaves the Confluence fingerprint as it was, so its archives do not render again', () => {
    const legacy = createHash('sha256')
      .update(JSON.stringify({ renderer: 1, product: 'confluence', comments: false, aliases: [] }))
      .digest('hex');
    expect(exportRenderHash('confluence', false)).toBe(legacy);
  });
});
