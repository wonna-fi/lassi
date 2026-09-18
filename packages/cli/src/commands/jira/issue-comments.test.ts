import type { Route } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import { BOTH_PRODUCTS_ENV, makeTestProgram } from '../../test/program.js';

const comment = (n: number) => ({
  id: String(n),
  body: `discussion ${n}`,
  created: `2026-09-0${n}T12:00:00Z`,
});
const issue = {
  id: '1',
  key: 'PROJ-1',
  fields: {
    summary: 'Login fails',
    description: 'Steps',
    updated: '2026-09-01',
    comment: { comments: [comment(1), comment(2)], total: 7, startAt: 0, maxResults: 2 },
  },
};
function setup(incomplete = false) {
  const routes: Route[] = [
    { path: '/rest/api/2/issue/PROJ-1', method: 'GET', json: issue },
    { path: '/rest/api/2/issue/PROJ-1', method: 'PUT', status: 204 },
    {
      path: '/rest/api/2/issue/PROJ-1/editmeta',
      json: {
        fields: { summary: { name: 'Summary', schema: { type: 'string' }, operations: ['set'] } },
      },
    },
    {
      path: '/rest/api/2/search',
      json: { issues: [issue], startAt: 0, maxResults: 100, total: 1 },
    },
    {
      path: '/rest/api/2/issue/PROJ-1/comment',
      handler: (call) => {
        const startAt = Number(call.url.searchParams.get('startAt'));
        const maxResults = Math.min(2, Number(call.url.searchParams.get('maxResults')));
        const all = [1, 2, 3, 4, 5, 6, 7].map(comment);
        if (call.url.searchParams.get('orderBy') === '-created') all.reverse();
        return {
          json: {
            total: 7,
            startAt,
            maxResults,
            comments: incomplete && startAt > 0 ? [] : all.slice(startAt, startAt + maxResults),
          },
        };
      },
    },
  ];
  return makeTestProgram({ env: BOTH_PRODUCTS_ENV, routes });
}

describe('issue discussion coverage', () => {
  it('expands all comments instead of trusting an embedded page', async () => {
    const p = setup();
    expect(await p.run(['jira', 'issue', 'get', 'PROJ-1', '--all', '--json'])).toBe(0);
    expect(JSON.parse(p.stdout())).toMatchObject({
      commentCoverage: { total: 7, shown: 7, complete: true, incomplete: false },
    });
    expect(JSON.parse(p.stdout()).body).toContain('discussion 7');
    expect(p.fetch.unmatched).toEqual([]);
  });
  it('counts intentionally hidden comments in AXI and fetches the newest one', async () => {
    const p = setup();
    expect(await p.run(['jira', 'issue', 'get', 'PROJ-1', '--comments', '1', '--axi'])).toBe(0);
    expect(p.stdout()).toContain('discussion 7');
    expect(p.stdout()).not.toContain('discussion 2');
    expect(p.stdout()).toContain('hidden: 6');
  });
  it('reports incomplete retrieval in markdown and machine-readable output', async () => {
    for (const format of [[], ['--json'], ['--axi']]) {
      const p = setup(true);
      expect(await p.run(['jira', 'issue', 'get', 'PROJ-1', '--all', ...format])).toBe(0);
      expect(p.stdout()).toContain(format.length ? 'incomplete' : 'incomplete retrieval');
    }
  });
  it('exposes exact partial coverage in JSON and AXI', async () => {
    const json = setup(true);
    await json.run(['jira', 'issue', 'get', 'PROJ-1', '--all', '--json']);
    expect(JSON.parse(json.stdout()).commentCoverage).toMatchObject({
      shown: 2,
      complete: false,
      incomplete: true,
    });
    const axi = setup(true);
    await axi.run(['jira', 'issue', 'get', 'PROJ-1', '--all', '--axi']);
    expect(axi.stdout()).toContain('hidden: 5');
  });
  it('upgrades old comment exports once even when the remote marker is unchanged', async () => {
    const p = setup();
    const args = ['jira', 'issue', 'export', 'project = PROJ', '--comments'];
    expect(await p.run(args)).toBe(0);
    const path = '/home/u/.lassi/export/jira/manifest.json';
    const manifest = JSON.parse(await p.fs.readFile(path));
    delete manifest.items['PROJ-1'].commentsComplete;
    await p.fs.writeFile(path, JSON.stringify(manifest));
    const before = p.fetch.calls.length;
    expect(await p.run(args)).toBe(0);
    expect(
      p.fetch.calls.slice(before).filter((c) => c.url.pathname.endsWith('/comment'))
    ).toHaveLength(4);
    const next = p.fetch.calls.length;
    expect(await p.run(args)).toBe(0);
    expect(
      p.fetch.calls.slice(next).filter((c) => c.url.pathname.endsWith('/comment'))
    ).toHaveLength(0);
  });
  it('keeps the complete discussion when rewriting a working file after update', async () => {
    const p = setup();
    expect(await p.run(['jira', 'issue', 'get', 'PROJ-1', '--all', '--out', 'issue.md'])).toBe(0);
    const path = '/home/u/proj/issue.md';
    await p.fs.writeFile(
      path,
      (await p.fs.readFile(path)).replace('summary: Login fails', 'summary: Login fixed')
    );
    expect(await p.run(['jira', 'issue', 'update', 'PROJ-1', '--file', 'issue.md'])).toBe(0);
    expect(await p.fs.readFile(path)).toContain('discussion 7');
    expect(p.fetch.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
    expect(p.fetch.calls.filter((c) => c.url.pathname.endsWith('/comment'))).toHaveLength(8);
  });
  it('exports the discussion from every page and keeps description-only reads cheap', async () => {
    const p = setup();
    expect(await p.run(['jira', 'issue', 'export', 'project = PROJ', '--comments'])).toBe(0);
    expect(await p.fs.readFile('/home/u/.lassi/export/jira/PROJ-1.md')).toContain('discussion 7');
    const lean = setup();
    await lean.run(['jira', 'issue', 'get', 'PROJ-1']);
    expect(lean.fetch.calls).toHaveLength(1);
  });
});
