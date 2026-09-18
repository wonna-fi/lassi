import { describe, expect, it } from 'vitest';
import { decode } from '@toon-format/toon';
import { BOTH_PRODUCTS_ENV, makeTestProgram } from '../../test/program.js';

const ROOT = '/home/u/proj';
const indexPath = '/home/u/.lassi/index/specs';
function setup() {
  return makeTestProgram({
    env: {
      ...BOTH_PRODUCTS_ENV,
      LASSI_EMBEDDINGS_URL: 'https://embeddings.example.internal/v1',
      LASSI_EMBEDDINGS_API_KEY: 'fixture',
    },
    files: {
      '/home/u/.lassi.json': JSON.stringify({
        embeddings: { model: 'fixture', chunkChars: 1500, chunkOverlap: 20 },
      }),
    },
    routes: [
      {
        path: '/rest/api/2/search',
        json: {
          issues: [
            {
              id: '1',
              key: 'PROJ-1',
              fields: {
                summary: 'Login failure',
                description: 'Check token expiry. '.repeat(100),
                updated: '2026-09-01',
                comment: { comments: [], total: 0, startAt: 0, maxResults: 0 },
              },
            },
          ],
          startAt: 0,
          maxResults: 100,
          total: 1,
        },
      },
      {
        method: 'POST',
        path: '/v1/embeddings',
        handler: (c) => ({
          json: {
            data: (JSON.parse(c.bodyText ?? '{}').input as string[]).map((_, index) => ({
              index,
              embedding: [1, 0],
            })),
          },
        }),
      },
    ],
  });
}
async function seed(p: ReturnType<typeof setup>) {
  expect(await p.run(['jira', 'issue', 'export', 'project = PROJ', '--out-dir', 'archive'])).toBe(
    0
  );
  expect(await p.run(['search', 'index', 'archive', '--name', 'specs'])).toBe(0);
}
async function json(p: ReturnType<typeof setup>, args: string[]) {
  const before = p.stdout().length;
  expect(await p.run([...args, '--json'])).toBe(0);
  return JSON.parse(p.stdout().slice(before));
}

describe('search source identity and evidence', () => {
  it('remembers custom sources for refresh and repairs damaged chunks using the same sources', async () => {
    const p = setup();
    await seed(p);
    await p.fs.writeFile('/home/u/.lassi/export/jira/PROJ-2.md', '# Unrelated default export');
    expect((await json(p, ['search', 'index', '--name', 'specs'])).sources).toEqual([
      `${ROOT}/archive`,
    ]);
    await p.fs.unlink(`${indexPath}/chunks.jsonl`);
    p.deps.now = () => new Date('2027-01-01T00:00:00Z');
    expect((await json(p, ['search', 'index', '--name', 'specs', '--rebuild'])).sources).toEqual([
      `${ROOT}/archive`,
    ]);
    const manifest = JSON.parse(await p.fs.readFile(`${indexPath}/manifest.json`));
    expect(Object.keys(manifest.docs)).toEqual([`${ROOT}/archive/PROJ-1.md`]);
    expect(manifest).toMatchObject({
      createdAt: '2026-09-04T10:00:00.000Z',
      updatedAt: '2027-01-01T00:00:00.000Z',
    });
  });
  it('requires explicit sources if the damaged manifest cannot recover them', async () => {
    const p = setup();
    await seed(p);
    await p.fs.writeFile(`${indexPath}/manifest.json`, '{bad');
    expect(await p.run(['search', 'index', '--name', 'specs', '--rebuild'])).toBe(2);
    expect(p.stderr()).toContain('original directories');
    expect(await p.run(['search', 'index', 'archive', '--name', 'specs', '--rebuild'])).toBe(0);
  });
  it('preserves all index files and spends nothing when a subtree is unreadable', async () => {
    const p = setup();
    await seed(p);
    await p.fs.writeFile(`${ROOT}/archive/notes/extra.md`, '# Extra');
    expect(await p.run(['search', 'index', '--name', 'specs'])).toBe(0);
    const manifest = await p.fs.readFile(`${indexPath}/manifest.json`);
    const chunks = await p.fs.readFile(`${indexPath}/chunks.jsonl`);
    const vectors = await p.fs.readBytes(`${indexPath}/vectors.f32`);
    const calls = p.fetch.calls.length;
    const read = p.fs.readdir.bind(p.fs);
    p.fs.readdir = async (path) => {
      if (path.endsWith('/notes')) throw new Error('EACCES');
      return read(path);
    };
    expect(await p.run(['search', 'index', '--name', 'specs'])).toBe(1);
    expect(p.fetch.calls).toHaveLength(calls);
    expect(await p.fs.readFile(`${indexPath}/manifest.json`)).toBe(manifest);
    expect(await p.fs.readFile(`${indexPath}/chunks.jsonl`)).toBe(chunks);
    expect(await p.fs.readBytes(`${indexPath}/vectors.f32`)).toEqual(vectors);
    expect((await json(p, ['search', 'show', '--index', 'specs'])).coverage.localState).toBe(
      'unavailable'
    );
  });
  it('rejects a missing explicit source instead of indexing only the remaining directories', async () => {
    const p = setup();
    await seed(p);
    const before = await p.fs.readFile(`${indexPath}/manifest.json`);
    expect(await p.run(['search', 'index', 'archive', 'missing', '--name', 'specs'])).toBe(1);
    expect(await p.fs.readFile(`${indexPath}/manifest.json`)).toBe(before);
  });
  it('rechunks unchanged source text when chunk settings change', async () => {
    const p = setup();
    await seed(p);
    const before = JSON.parse(await p.fs.readFile(`${indexPath}/manifest.json`));
    await p.fs.writeFile(
      '/home/u/.lassi.json',
      JSON.stringify({ embeddings: { model: 'fixture', chunkChars: 200, chunkOverlap: 20 } })
    );
    const result = await json(p, ['search', 'index', '--name', 'specs']);
    expect(result).toMatchObject({ embedded: 1, reused: 0 });
    const after = JSON.parse(await p.fs.readFile(`${indexPath}/manifest.json`));
    expect(after.chunkCount).toBeGreaterThan(before.chunkCount);
    expect(after.chunkFingerprint).not.toBe(before.chunkFingerprint);
  });
  it('keeps source dates distinct from index dates and reports edited and new source files', async () => {
    const p = setup();
    await seed(p);
    p.deps.now = () => new Date('2027-01-01T00:00:00Z');
    await p.run(['search', 'index', '--name', 'specs', '--rebuild']);
    const result = await json(p, ['search', 'query', 'Login', '--index', 'specs']);
    expect(result.coverage).toMatchObject({
      localState: 'current',
      indexedAt: '2027-01-01T00:00:00.000Z',
    });
    expect(result.hits[0]).toMatchObject({
      url: 'https://jira.example.internal/browse/PROJ-1',
      origin: {
        checkedAt: '2026-09-04T10:00:00.000Z',
        fetchedAt: '2026-09-04T10:00:00.000Z',
        locallyModified: false,
      },
    });
    await p.fs.writeFile(
      `${ROOT}/archive/PROJ-1.md`,
      (await p.fs.readFile(`${ROOT}/archive/PROJ-1.md`)) + '\nLocal note'
    );
    expect((await json(p, ['search', 'show', '--index', 'specs'])).coverage.localState).toBe(
      'changed'
    );
    await p.run(['search', 'index', '--name', 'specs']);
    expect(
      (await json(p, ['search', 'query', 'Login', '--index', 'specs'])).hits[0].origin
        .locallyModified
    ).toBe(true);
    await p.fs.writeFile(`${ROOT}/archive/new.md`, '# New document');
    expect((await json(p, ['search', 'show', '--index', 'specs'])).coverage.localState).toBe(
      'changed'
    );
  });
  it('marks changed archive coverage stale, then updates provenance without re-embedding', async () => {
    const p = setup();
    await seed(p);
    const path = `${ROOT}/archive/manifest.json`;
    const manifest = JSON.parse(await p.fs.readFile(path));
    manifest.queries.push('key = PROJ-1');
    manifest.lastRun.complete = false;
    manifest.lastRun.truncated = true;
    await p.fs.writeFile(path, JSON.stringify(manifest));
    expect((await json(p, ['search', 'show', '--index', 'specs'])).coverage.localState).toBe(
      'changed'
    );
    expect(await json(p, ['search', 'index', '--name', 'specs'])).toMatchObject({
      embedded: 0,
      reused: 1,
    });
    const result = await json(p, ['search', 'query', 'Login', '--index', 'specs']);
    expect(result.coverage.exports[0]).toMatchObject({
      mode: 'archive',
      queries: ['project = PROJ', 'key = PROJ-1'],
      lastRun: { complete: false, truncated: true },
    });
  });
  it('reports legacy file baselines and remote coverage as unknown', async () => {
    const p = setup();
    await seed(p);
    const path = `${ROOT}/archive/manifest.json`;
    const manifest = JSON.parse(await p.fs.readFile(path));
    for (const key of ['mode', 'source', 'queries', 'lastRun']) delete manifest[key];
    for (const key of ['sha256', 'checkedAt', 'fetchedAt']) delete manifest.items['PROJ-1'][key];
    await p.fs.writeFile(path, JSON.stringify(manifest));
    expect(await p.run(['search', 'index', '--name', 'specs'])).toBe(0);
    const result = await json(p, ['search', 'query', 'Login', '--index', 'specs']);
    expect(result.hits[0].origin.locallyModified).toBeNull();
    expect(result.hits[0].origin.checkedAt).toBeUndefined();
    expect(result.coverage.exports[0].mode).toBe('legacy');
    expect(result.coverage.exports[0].lastRun).toBeUndefined();
  });

  it('exposes each source URL and all three dates in Markdown and AXI', async () => {
    const p = setup();
    await seed(p);
    const path = `${ROOT}/archive/manifest.json`;
    const manifest = JSON.parse(await p.fs.readFile(path));
    manifest.items['PROJ-1'].fetchedAt = '2025-01-01T00:00:00.000Z';
    await p.fs.writeFile(path, JSON.stringify(manifest));
    p.deps.now = () => new Date('2027-01-01T00:00:00Z');
    expect(await p.run(['search', 'index', '--name', 'specs', '--rebuild'])).toBe(0);
    const outputs: string[] = [];
    for (const flags of [[], ['--axi']]) {
      const start = p.stdout().length;
      expect(await p.run(['search', 'query', 'Login', '--index', 'specs', ...flags])).toBe(0);
      const output = p.stdout().slice(start);
      outputs.push(output);
      for (const value of [
        'https://jira.example.internal/browse/PROJ-1',
        '2025-01-01T00:00:00.000Z',
        '2026-09-04T10:00:00.000Z',
        '2027-01-01T00:00:00.000Z',
      ])
        expect(output).toContain(value);
    }
    expect(outputs[0]).toContain('Modified: no');
    expect(decode((outputs[1] as string).split('\nhelp[')[0] as string)).toMatchObject({
      hits: [{ origin: { locallyModified: false } }],
    });
  });
  it('ignores unrelated product manifests but validates recognized export metadata', async () => {
    const p = setup();
    await seed(p);
    await p.fs.writeFile(
      `${ROOT}/archive/notes/manifest.json`,
      JSON.stringify({ product: 'jira' })
    );
    await p.fs.writeFile(`${ROOT}/archive/notes/readme.md`, '# Local notes');
    expect(await json(p, ['search', 'index', '--name', 'specs'])).toMatchObject({ documents: 2 });
    const path = `${ROOT}/archive/manifest.json`;
    const manifest = JSON.parse(await p.fs.readFile(path));
    const variants = [
      { ...manifest, items: [] },
      ...['query', 'exportedAt', 'items', 'product', 'schema'].map((key) => {
        const partial = { ...manifest };
        delete partial[key];
        return partial;
      }),
    ];
    const before = await p.fs.readFile(`${indexPath}/manifest.json`);
    const requests = p.fetch.calls.length;
    for (const broken of variants) {
      await p.fs.writeFile(path, JSON.stringify(broken));
      expect(await p.run(['search', 'index', '--name', 'specs'])).toBe(5);
      expect(await p.fs.readFile(`${indexPath}/manifest.json`)).toBe(before);
      expect(p.fetch.calls).toHaveLength(requests);
    }
  });

  it('finds nested export metadata through overlapping roots without duplicating documents', async () => {
    const p = setup();
    await seed(p);
    const result = await json(p, ['search', 'index', 'archive', 'archive/..', '--name', 'wide']);
    expect(result.documents).toBe(1);
    expect(result.exports).toHaveLength(1);
  });
});
