import { createHash } from 'node:crypto';
import type { Route } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import { BOTH_PRODUCTS_ENV, lastJsonLine, makeTestProgram } from '../../test/program.js';
import type { ExportManifest } from './export-manifest.js';

const CWD = '/home/u/proj';
const hash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function setup(product: 'jira' | 'confluence', count = 1) {
  let version = 1;
  let repeatOnNextPage = false;
  let failLaterSearch = false;
  let onPageFetch: (() => Promise<void>) | undefined;
  const keys = Array.from({ length: count }, (_, i) =>
    product === 'jira' ? `PROJ-${i + 1}` : String(123456 + i)
  );
  const key = keys[0]!;
  const updated = () => `2026-09-0${version}T12:00:00.000Z`;
  const issue = (key: string) => ({
    key,
    fields: {
      summary: 'Example issue',
      description: `Remote content ${version}`,
      updated: updated(),
      issuetype: { name: 'Task' },
      status: { name: 'Open' },
    },
  });
  const page = (key: string) => ({
    id: key,
    title: 'Example page',
    space: { key: 'DEV' },
    version: { number: version },
    body: { storage: { value: `<p>Remote content ${version}</p>` } },
    ancestors: [],
  });
  const routes: Route[] =
    product === 'jira'
      ? [
          {
            method: 'POST',
            path: '/rest/api/2/search',
            handler: (call) => {
              const { startAt } = JSON.parse(call.bodyText ?? '{}') as { startAt: number };
              if (failLaterSearch && startAt > 0)
                return { status: 503, text: 'Search unavailable' };
              return {
                json: {
                  issues: keys.map(issue),
                  total: repeatOnNextPage ? 2 : count,
                  startAt,
                  maxResults: 100,
                },
              };
            },
          },
          ...keys.map((key) => ({
            path: `/rest/api/2/issue/${key}`,
            handler: () => ({ json: issue(key) }),
          })),
        ]
      : [
          {
            path: '/rest/api/content/search',
            handler: (call) => {
              const start = Number(call.url.searchParams.get('start'));
              if (failLaterSearch && start > 0) return { status: 503, text: 'Search unavailable' };
              return {
                json: {
                  results: keys.map(page),
                  size: count,
                  start,
                  limit: 50,
                  _links:
                    repeatOnNextPage && start === 0
                      ? { next: '/rest/api/content/search?start=1' }
                      : {},
                },
              };
            },
          },
          ...keys.flatMap((key) => [
            {
              path: `/rest/api/content/${key}`,
              handler: async () => {
                await onPageFetch?.();
                return { json: page(key) };
              },
            },
            { path: `/rest/api/content/${key}/child/attachment`, json: { results: [], size: 0 } },
          ]),
        ];
  const t = makeTestProgram({ routes, env: BOTH_PRODUCTS_ENV });
  const dir = `/home/u/.lassi/export/${product}`;
  const path = `${dir}/${key}.md`;
  const cachePath = `${CWD}/.lassi/cache/${product}/${key}.json`;
  const args =
    product === 'jira'
      ? ['jira', 'issue', 'export', 'project = PROJ']
      : ['confluence', 'page', 'export', '--space', 'DEV'];
  const getArgs =
    product === 'jira' ? ['jira', 'issue', 'get', key] : ['confluence', 'page', 'get', key];
  const manifest = async (): Promise<ExportManifest> =>
    JSON.parse(await t.fs.readFile(`${dir}/manifest.json`)) as ExportManifest;
  return {
    t,
    key,
    keys,
    path,
    cachePath,
    dir,
    args,
    getArgs,
    manifest,
    changeRemote: () => {
      version += 1;
    },
    repeatSearchResult: () => {
      repeatOnNextPage = true;
    },
    failLaterSearch: (fail: boolean) => {
      failLaterSearch = fail;
    },
    duringPageFetch: (fn: () => Promise<void>) => {
      onPageFetch = fn;
    },
  };
}

describe.each(['jira', 'confluence'] as const)('%s export preservation', (product) => {
  it.each([false, true])(
    'retains successful baselines after pagination fails when refreshing = %s',
    async (refresh) => {
      const s = setup(product);
      const initialExit = refresh ? await s.t.run(s.args) : 0;
      expect(initialExit).toBe(0);
      if (refresh) s.changeRemote();
      s.repeatSearchResult();
      s.failLaterSearch(true);

      expect(await s.t.run(s.args)).toBe(1);
      expect(lastJsonLine(s.t.stderr())).toMatchObject({ code: 'http', http: 503 });
      const file = await s.t.fs.readFile(s.path);
      expect(file).toContain(`Remote content ${refresh ? 2 : 1}`);
      expect(await s.t.fs.exists(`${s.dir}/manifest.json`)).toBe(true);
      expect((await s.manifest()).items[s.key]?.sha256).toBe(hash(file));

      s.failLaterSearch(false);
      const outputStart = s.t.stdout().length;
      expect(await s.t.run([...s.args, '--json'])).toBe(0);
      expect(JSON.parse(s.t.stdout().slice(outputStart))).toMatchObject({
        written: 0,
        unchanged: 2,
        failed: 0,
      });
      expect(await s.t.fs.readFile(s.path)).toBe(file);
    }
  );

  it.each([false, true])(
    'accepts repeated search results when refreshing = %s',
    async (refresh) => {
      const s = setup(product);
      const initialExit = refresh ? await s.t.run(s.args) : 0;
      expect(initialExit).toBe(0);
      if (refresh) s.changeRemote();
      s.repeatSearchResult();
      const outputStart = s.t.stdout().length;
      const callsStart = s.t.fetch.calls.length;

      expect(await s.t.run([...s.args, '--json'])).toBe(0);
      expect(JSON.parse(s.t.stdout().slice(outputStart))).toMatchObject({
        total: 2,
        written: 1,
        unchanged: 1,
        failed: 0,
      });
      expect(
        s.t.fetch.calls.slice(callsStart).filter((call) => call.url.pathname.endsWith('/search'))
      ).toHaveLength(2);
      const file = await s.t.fs.readFile(s.path);
      expect(file).toContain(`Remote content ${refresh ? 2 : 1}`);
      expect((await s.manifest()).items[s.key]?.sha256).toBe(hash(file));
    }
  );

  it('refreshes an untouched export and leaves a separate working copy and baseline alone', async () => {
    const s = setup(product);
    const work = `.lassi/work/${s.key}.md`;
    expect(await s.t.run([...s.getArgs, '--out', work])).toBe(0);
    const edit = `${await s.t.fs.readFile(`${CWD}/${work}`)}\nMy working edit.\n`;
    await s.t.fs.writeFile(`${CWD}/${work}`, edit);
    const cache = JSON.parse(await s.t.fs.readFile(s.cachePath));
    const baseline = cache.files[work];

    expect(await s.t.run(s.args)).toBe(0);
    const first = await s.t.fs.readFile(s.path);
    expect((await s.manifest()).items[s.key]?.sha256).toBe(hash(first));
    s.changeRemote();
    expect(await s.t.run(s.args)).toBe(0);
    expect(await s.t.fs.readFile(s.path)).toContain('Remote content 2');
    expect(await s.t.fs.readFile(`${CWD}/${work}`)).toBe(edit);
    expect(JSON.parse(await s.t.fs.readFile(s.cachePath)).files[work]).toEqual(baseline);
    expect((await s.manifest()).items[s.key]?.sha256).toBe(hash(await s.t.fs.readFile(s.path)));
  });

  it('reports one preserved file when an edited result repeats across search pages', async () => {
    const s = setup(product);
    expect(await s.t.run(s.args)).toBe(0);
    const edited = `${await s.t.fs.readFile(s.path)}\nLocal edit.\n`;
    await s.t.fs.writeFile(s.path, edited);
    s.repeatSearchResult();

    expect(await s.t.run(s.args)).toBe(6);
    expect(lastJsonLine(s.t.stderr())).toMatchObject({
      message: expect.stringContaining('; 1 local file preserved'),
      errorMessages: [`${s.path} has local edits; preserved`],
    });
    expect(await s.t.fs.readFile(s.path)).toBe(edited);
  });

  it.each([false, true])(
    'preserves an edited export and its baseline when remote changes = %s',
    async (remoteChanged) => {
      const s = setup(product);
      expect(await s.t.run(s.args)).toBe(0);
      const original = await s.t.fs.readFile(s.path);
      const entry = (await s.manifest()).items[s.key];
      const baseline = await s.t.fs.readFile(s.cachePath);
      const edited = `${original}\nUnpublished local edit.\n`;
      await s.t.fs.writeFile(s.path, edited);
      if (remoteChanged) s.changeRemote();

      expect(await s.t.run([...s.args, '--json'])).toBe(6);
      expect(lastJsonLine(s.t.stderr())).toMatchObject({
        code: 'conflict',
        errorMessages: [expect.stringContaining('has local edits; preserved')],
        hint: expect.stringContaining('back up'),
      });
      expect(await s.t.fs.readFile(s.path)).toBe(edited);
      expect(await s.t.fs.readFile(s.cachePath)).toBe(baseline);
      expect((await s.manifest()).items[s.key]).toEqual(entry);
      // A failed refresh must not bless the edited content as the next baseline.
      expect(await s.t.run(s.args)).toBe(6);
      await s.t.fs.writeFile(s.path, original);
      expect(await s.t.run(s.args)).toBe(0);
    }
  );

  it.each(['legacy', 'missing manifest', 'untracked'] as const)(
    'preserves existing content with a %s baseline',
    async (state) => {
      const s = setup(product);
      expect(await s.t.run(s.args)).toBe(0);
      const before = await s.manifest();
      if (state === 'legacy') delete before.items[s.key]?.sha256;
      if (state === 'untracked') delete before.items[s.key];
      await s.t.fs.writeFile(`${s.dir}/manifest.json`, JSON.stringify(before));
      if (state === 'missing manifest') await s.t.fs.unlink(`${s.dir}/manifest.json`);
      const edited = `${await s.t.fs.readFile(s.path)}\nPreserve this note.\n`;
      await s.t.fs.writeFile(s.path, edited);
      s.changeRemote();

      expect(await s.t.run(s.args)).toBe(6);
      expect(lastJsonLine(s.t.stderr())).toMatchObject({
        code: 'conflict',
        errorMessages: [expect.stringContaining('has no recorded content hash; preserved')],
      });
      expect(await s.t.fs.readFile(s.path)).toBe(edited);
      await s.t.fs.unlink(s.path);
      expect(await s.t.run(s.args)).toBe(0);
      expect(await s.t.fs.readFile(s.path)).toContain('Remote content 2');
    }
  );

  it('recreates a missing export even when the remote marker has not changed', async () => {
    const s = setup(product);
    expect(await s.t.run(s.args)).toBe(0);
    await s.t.fs.unlink(s.path);
    expect(await s.t.run(s.args)).toBe(0);
    expect(await s.t.fs.readFile(s.path)).toContain('Remote content 1');
  });

  it('finishes other files and retains their new baselines when one export conflicts', async () => {
    const s = setup(product, 2);
    expect(await s.t.run(s.args)).toBe(0);
    const edited = `${await s.t.fs.readFile(s.path)}\nLocal edit.\n`;
    await s.t.fs.writeFile(s.path, edited);
    s.changeRemote();
    expect(await s.t.run(s.args)).toBe(6);
    const otherPath = `${s.dir}/${s.keys[1]}.md`;
    const other = await s.t.fs.readFile(otherPath);
    expect(other).toContain('Remote content 2');
    expect((await s.manifest()).items[s.keys[1]!]!.sha256).toBe(hash(other));
    expect(await s.t.fs.readFile(s.path)).toBe(edited);
    expect(await s.t.run(s.args)).toBe(6);
    expect(lastJsonLine(s.t.stderr())).toMatchObject({
      message: expect.stringContaining('1 unchanged, 0 written, 1 failed'),
    });
  });

  it('rejects an invalid recorded hash without changing local files', async () => {
    const s = setup(product);
    expect(await s.t.run(s.args)).toBe(0);
    const before = await s.manifest();
    before.items[s.key]!.sha256 = 'invalid';
    await s.t.fs.writeFile(`${s.dir}/manifest.json`, JSON.stringify(before));
    const original = await s.t.fs.readFile(s.path);
    s.changeRemote();
    expect(await s.t.run(s.args)).toBe(2);
    expect(await s.t.fs.readFile(s.path)).toBe(original);
  });
});

it('preserves a Confluence export edited while its replacement is being fetched', async () => {
  const s = setup('confluence');
  expect(await s.t.run(s.args)).toBe(0);
  const edited = `${await s.t.fs.readFile(s.path)}\nConcurrent edit.\n`;
  s.changeRemote();
  s.duringPageFetch(() => s.t.fs.writeFile(s.path, edited));
  expect(await s.t.run(s.args)).toBe(6);
  expect(await s.t.fs.readFile(s.path)).toBe(edited);
});
