import { describe, expect, it } from 'vitest';
import { nodeFs, pathApi, toPosix } from '@wonna/lassi-core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readIndex, writeIndex } from '@wonna/lassi-search';
import { BOTH_PRODUCTS_ENV, makeTestProgram, type TestProgram } from '../../test/program.js';

function setup(home = '/home/u', cwd = '/projects/a', storage?: Record<string, string>) {
  return makeTestProgram({
    homedir: home,
    cwd,
    env: {
      ...BOTH_PRODUCTS_ENV,
      LASSI_EMBEDDINGS_URL: 'https://embeddings.example.internal/v1',
      LASSI_EMBEDDINGS_API_KEY: 'fixture',
    },
    files: {
      [pathApi(home).join(home, '.lassi.json')]: JSON.stringify({
        embeddings: { model: 'fixture' },
        ...(storage ? { storage } : {}),
      }),
    },
    routes: [
      {
        method: 'POST',
        path: '/rest/api/2/search',
        json: {
          startAt: 0,
          maxResults: 100,
          total: 1,
          issues: [
            {
              id: '1',
              key: 'PROJ-1',
              fields: {
                summary: 'Token renewal fails',
                description: 'Check token expiry.',
                updated: '2026-09-01',
                comment: { comments: [], total: 0, startAt: 0, maxResults: 0 },
              },
            },
          ],
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

async function json(p: TestProgram, args: string[]) {
  const start = p.stdout().length;
  expect(await p.run([...args, '--json'])).toBe(0);
  return JSON.parse(p.stdout().slice(start));
}

const exportArgs = ['jira', 'issue', 'export', 'project = PROJ', '--comments'];
const indexReaders = [
  { command: ['query', 'token'], result: { coverage: { localState: 'current' } }, requests: 1 },
  { command: ['show'], result: { coverage: { localState: 'current' } }, requests: 0 },
  {
    command: ['index', '--dry-run'],
    result: { dryRun: true, payload: expect.stringContaining('0 to embed') },
    requests: 0,
  },
  {
    command: ['index', '--dry-run', '--rebuild'],
    result: { dryRun: true, payload: expect.stringContaining('1 to embed') },
    requests: 0,
  },
];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('exports and search shared between working directories', () => {
  it.each(['/home/u/.lassi/export/jira', '/home/u/.lassi/export'])(
    'spends nothing indexing %s during an export, then succeeds after it',
    async (source) => {
      const p = setup();
      await json(p, exportArgs);
      await json(p, ['search', 'index', source]);
      const before = await readIndex(p.fs, '/home/u/.lassi/index/default');
      const writer = setup();
      writer.deps.fs = p.fs;
      const entered = deferred();
      const release = deferred();
      const fetch = writer.deps.fetch;
      writer.deps.fetch = async (...args) => {
        entered.resolve();
        await release.promise;
        return fetch(...args);
      };
      const writing = writer.run(exportArgs);
      await entered.promise;
      const calls = p.fetch.calls.length;
      try {
        for (const flags of [[], ['--dry-run']])
          expect(await p.run(['search', 'index', ...flags])).toBe(6);
        expect(p.stderr()).toContain('another lassi operation holds');
        expect(p.fetch.calls).toHaveLength(calls);
        expect(await readIndex(p.fs, '/home/u/.lassi/index/default')).toEqual(before);
      } finally {
        release.resolve();
      }
      expect(await writing).toBe(0);
      expect(await json(p, ['search', 'index'])).toMatchObject({ documents: 1 });
    }
  );

  it.each([false, true])(
    'rejects an export completed inside collection (existing manifest: %s)',
    async (existing) => {
      const p = setup();
      const archive = '/home/u/archive';
      const notes = `${archive}/notes.md`;
      await p.fs.writeFile(notes, '# Local notes');
      if (existing) await json(p, [...exportArgs, '--out-dir', archive]);
      await json(p, ['search', 'index', archive]);
      const before = await readIndex(p.fs, '/home/u/.lassi/index/default');
      const writer = setup();
      writer.deps.fs = p.fs;
      writer.deps.now = () => new Date('2027-01-01T00:00:00Z');
      const read = p.fs.readFile.bind(p.fs);
      let triggered = false;
      let writeExit: number | undefined;
      p.fs.readFile = async (path) => {
        const old = await read(path);
        if (!triggered && path === notes) {
          triggered = true;
          writeExit = await writer.run([...exportArgs, '--out-dir', archive]);
        }
        return old;
      };
      const calls = p.fetch.calls.length;
      expect(await p.run(['search', 'index'])).toBe(6);
      expect(triggered).toBe(true);
      expect(writeExit).toBe(0);
      expect(p.stderr()).toContain('index source changed while being read');
      expect(p.fetch.calls).toHaveLength(calls);
      expect(await readIndex(p.fs, '/home/u/.lassi/index/default')).toEqual(before);
      expect(await p.fs.exists('/home/u/.lassi/index/default/.lassi-write.lock')).toBe(false);
      expect(await json(p, ['search', 'index'])).toMatchObject({ documents: 2 });
      expect((await json(p, ['search', 'show'])).coverage.localState).toBe('current');
    }
  );

  it.skipIf(process.platform === 'win32')(
    'uses double-slash POSIX export, source and configured paths on disk',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'lassi-double-slash-'));
      try {
        const p = setup(join(dir, 'home'), join(dir, 'project'), {
          exportDir: '/' + join(dir, 'exports'),
          indexDir: '/' + join(dir, 'indexes'),
        });
        const fs = nodeFs();
        for (const [path, content] of p.fs.files) await fs.writeFile(path, content);
        p.deps.fs = fs;
        expect(await json(p, exportArgs)).toMatchObject({ dir: join(dir, 'exports', 'jira') });
        const archive = join(dir, 'archive');
        await json(p, [...exportArgs, '--out-dir', '/' + archive]);
        expect(await fs.exists(join(archive, 'PROJ-1.md'))).toBe(true);
        expect(await json(p, ['search', 'index', '/' + archive])).toMatchObject({
          sources: [archive],
          dir: join(dir, 'indexes', 'default'),
        });
        p.deps.cwd = join(dir, 'another-project');
        expect(await json(p, ['search', 'index'])).toMatchObject({ embedded: 0, reused: 1 });
        const result = await json(p, ['search', 'query', 'token']);
        expect(result.coverage.localState).toBe('current');
        expect(result.hits[0].doc).toBe(join(archive, 'PROJ-1.md'));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );

  it('preserves recognizable damaged export manifests outside the selected sources', async () => {
    const p = setup('/home/u', '/projects/a', { indexDir: '~/indexes' });
    await json(p, [...exportArgs, '--out-dir', '/home/u/indexes/archive']);
    await p.fs.writeFile('/projects/a/notes.md', '# A different source');
    const path = '/home/u/indexes/archive/manifest.json';
    const original = JSON.parse(await p.fs.readFile(path));
    const variants = [
      { ...original, items: [] },
      ...['schema', 'product', 'query', 'exportedAt', 'items'].map((key) => {
        const partial = { ...original };
        delete partial[key];
        return partial;
      }),
    ];
    const calls = p.fetch.calls.length;
    for (const variant of variants) {
      const text = JSON.stringify(variant);
      await p.fs.writeFile(path, text);
      expect(
        await p.run(['search', 'index', '/projects/a', '--name', 'archive', '--rebuild'])
      ).toBe(2);
      expect(await p.fs.readFile(path)).toBe(text);
    }
    expect(p.fetch.calls).toHaveLength(calls);
    expect(await p.fs.exists('/home/u/indexes/archive/.lassi-write.lock')).toBe(false);
  });

  it.each(indexReaders)(
    'refuses $command during an index publication and succeeds after it',
    async ({ command, result: expected, requests }) => {
      const p = setup();
      await json(p, exportArgs);
      await json(p, ['search', 'index']);
      const source = '/home/u/.lassi/export/jira/PROJ-1.md';
      await p.fs.writeFile(source, (await p.fs.readFile(source)) + '\n## Follow-up\nNew evidence.');
      const writer = setup();
      writer.deps.fs = p.fs;
      const entered = deferred();
      const release = deferred();
      const rename = p.fs.rename.bind(p.fs);
      p.fs.rename = async (from, to) => {
        await rename(from, to);
        if (to.endsWith('/vectors.f32')) {
          entered.resolve();
          await release.promise;
        }
      };
      const writing = writer.run(['search', 'index']);
      await entered.promise;
      const calls = p.fetch.calls.length;
      const files = new Map(p.fs.files);
      const bytes = new Map(p.fs.bytes);
      try {
        expect(await p.run(['search', ...command])).toBe(6);
        expect(p.stderr()).toContain('another lassi operation holds');
        expect(p.stderr()).not.toContain('--rebuild');
        expect(p.fetch.calls).toHaveLength(calls);
        expect(p.fs.files).toEqual(files);
        expect(p.fs.bytes).toEqual(bytes);
      } finally {
        release.resolve();
      }
      expect(await writing).toBe(0);
      const result = await json(p, ['search', ...command]);
      expect(result).toMatchObject(expected);
      expect(p.fetch.calls).toHaveLength(calls + requests);
    }
  );

  it.each(indexReaders)(
    'retries $command when a writer finishes entirely inside its read',
    async ({ command, result: expected, requests }) => {
      const p = setup();
      await json(p, exportArgs);
      await json(p, ['search', 'index']);
      const source = '/home/u/.lassi/export/jira/PROJ-1.md';
      await p.fs.writeFile(source, (await p.fs.readFile(source)) + '\n## Follow-up\nNew evidence.');
      const writer = setup();
      writer.deps.fs = p.fs;
      const read = p.fs.readFile.bind(p.fs);
      const writeFileExclusive = p.fs.writeFileExclusive.bind(p.fs);
      let publishing = false;
      let readerLocks = 0;
      p.fs.writeFileExclusive = async (path, data) => {
        if (!publishing) readerLocks++;
        return writeFileExclusive(path, data);
      };
      let triggered = false;
      let manifestReads = 0;
      let writeExit: number | undefined;
      p.fs.readFile = async (path) => {
        const old = await read(path);
        if (!triggered && path === '/home/u/.lassi/index/default/manifest.json') {
          // Dry runs inspect the target for foreign manifests before loading index data.
          if (++manifestReads > (command[0] === 'index' ? 1 : 0)) {
            triggered = true;
            publishing = true;
            try {
              writeExit = await writer.run(['search', 'index']);
            } finally {
              publishing = false;
            }
          }
        }
        return old;
      };
      const calls = p.fetch.calls.length;
      const result = await json(p, ['search', ...command]);
      expect(result).toMatchObject(expected);
      expect(p.fetch.calls).toHaveLength(calls + requests);
      expect(triggered).toBe(true);
      expect(writeExit).toBe(0);
      expect(readerLocks).toBe(0);
      expect(p.stderr()).toBe('');
    }
  );

  it('preserves an archive when its configured root aliases an index target', async () => {
    const p = setup('/home/u', '/projects/a', { exportDir: '~/data', indexDir: '~/data' });
    await json(p, exportArgs);
    const path = '/home/u/data/jira/manifest.json';
    const before = await p.fs.readFile(path);
    const calls = p.fetch.calls.length;
    for (const sources of [[], ['/home/u/data/jira']]) {
      expect(await p.run(['search', 'index', ...sources, '--name', 'jira', '--rebuild'])).toBe(2);
    }
    expect(p.stderr()).toContain('overlaps');
    expect(await p.fs.readFile(path)).toBe(before);
    expect(p.fetch.calls).toHaveLength(calls);
    expect(await p.fs.exists('/home/u/data/jira/.lassi-write.lock')).toBe(false);
  });

  it('rejects an explicit source containing the index and an unrelated existing archive target', async () => {
    const p = setup('/home/u', '/projects/a', { indexDir: '~/indexes' });
    await json(p, [...exportArgs, '--out-dir', '/home/u/indexes/archive']);
    const before = await p.fs.readFile('/home/u/indexes/archive/manifest.json');
    expect(await p.run(['search', 'index', '/home/u/indexes', '--name', 'other'])).toBe(2);
    expect(await p.run(['search', 'index', '/projects/a', '--name', 'archive', '--rebuild'])).toBe(
      2
    );
    expect(p.stderr()).toContain('contains an export manifest');
    expect(await p.fs.readFile('/home/u/indexes/archive/manifest.json')).toBe(before);
  });

  it('refuses concurrent index and Confluence writers before network calls', async () => {
    const p = setup();
    await json(p, exportArgs);
    await json(p, ['search', 'index']);
    const path = '/home/u/.lassi/index/default/manifest.json';
    const before = await p.fs.readFile(path);
    await p.fs.writeFile('/home/u/.lassi/index/default/.lassi-write.lock', 'another writer');
    await p.fs.writeFile('/home/u/.lassi/export/confluence/.lassi-write.lock', 'another writer');
    const calls = p.fetch.calls.length;
    expect(await p.run(['search', 'index'])).toBe(6);
    expect(await p.run(['confluence', 'page', 'export', '--space', 'DEV'])).toBe(6);
    expect(await p.fs.readFile(path)).toBe(before);
    expect(p.fetch.calls).toHaveLength(calls);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps distinct POSIX backslash filenames readable in query results',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'lassi-paths-'));
      try {
        const home = join(dir, 'home');
        const p = setup(home, join(dir, 'project'));
        const fs = nodeFs();
        for (const [path, content] of p.fs.files) await fs.writeFile(path, content);
        p.deps.fs = fs;
        const archive = join(dir, 'archive');
        const files = [join(archive, 'a\\b.md'), join(archive, 'a', 'b.md')];
        await fs.writeFile(files[0]!, '# Literal backslash');
        await fs.writeFile(files[1]!, '# Nested path');
        expect(await json(p, ['search', 'index', archive])).toMatchObject({ documents: 2 });
        expect(await json(p, ['search', 'index'])).toMatchObject({ reused: 2, embedded: 0 });
        const result = await json(p, ['search', 'query', 'paths']);
        expect(result.coverage.localState).toBe('current');
        expect(result.hits.map((h: { doc: string }) => h.doc).sort()).toEqual(files.sort());
        const contents = await Promise.all(
          result.hits.map((hit: { doc: string }) => fs.readFile(hit.doc))
        );
        expect(contents.sort()).toEqual(['# Literal backslash', '# Nested path']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  );

  it.each([
    { home: '/home/u', first: '/projects/a', second: '/projects/b' },
    { home: 'C:\\Users\\u', first: 'D:\\projects\\a', second: 'E:\\projects\\b' },
    {
      home: '\\\\files.example.internal\\users\\u',
      first: 'D:\\projects\\a',
      second: 'E:\\projects\\b',
    },
  ])(
    'exports, searches and repairs the same global index from $first and $second',
    async ({ home, first, second }) => {
      const p = setup(home, first);
      const api = pathApi(home);
      const exportDir = api.join(home, '.lassi', 'export', 'jira');
      const indexDir = api.join(home, '.lassi', 'index', 'default');
      const doc = toPosix(api.join(exportDir, 'PROJ-1.md'));
      expect(await json(p, exportArgs)).toMatchObject({ dir: exportDir, written: 1 });
      expect(await p.fs.exists(pathApi(first).join(first, '.lassi', 'export', 'jira'))).toBe(false);
      const working = pathApi(first).join(first, '.lassi', 'work', 'PROJ-1.md');
      await p.fs.writeFile(working, '# My editing copy');

      p.deps.cwd = second;
      expect(await json(p, exportArgs)).toMatchObject({ written: 0, unchanged: 1 });
      const manifest = JSON.parse(await p.fs.readFile(api.join(exportDir, 'manifest.json')));
      expect(manifest.items['PROJ-1'].path).toBe(doc);
      expect(await json(p, ['search', 'index'])).toMatchObject({
        dir: indexDir,
        sources: [toPosix(exportDir)],
        documents: 1,
      });

      p.deps.cwd = first;
      expect(await json(p, ['search', 'index'])).toMatchObject({ embedded: 0, reused: 1 });
      p.deps.env['LASSI_READ_ONLY'] = '1';
      const result = await json(p, ['search', 'query', 'token renewal']);
      expect(result.hits[0]).toMatchObject({
        doc,
        origin: { manifest: toPosix(api.join(exportDir, 'manifest.json')) },
      });
      expect(result.coverage.localState).toBe('current');
      expect(await p.fs.exists(result.hits[0].doc)).toBe(true);
      expect(await json(p, ['search', 'show'])).toMatchObject({
        dir: indexDir,
        coverage: { localState: 'current' },
      });

      delete p.deps.env['LASSI_READ_ONLY'];
      await p.fs.unlink(api.join(indexDir, 'chunks.jsonl'));
      p.deps.cwd = second;
      expect(await json(p, ['search', 'index', '--rebuild'])).toMatchObject({
        documents: 1,
        sources: [toPosix(exportDir)],
      });
      expect(await p.fs.readFile(working)).toBe('# My editing copy');
    }
  );

  it('uses configured roots and remembers explicit relative sources across directories', async () => {
    const p = setup('/home/u', '/projects/a', { exportDir: './archives', indexDir: '~/indexes' });
    expect(await json(p, exportArgs)).toMatchObject({ dir: '/home/u/archives/jira' });
    expect(await json(p, [...exportArgs, '--out-dir', 'pilot'])).toMatchObject({ dir: 'pilot' });
    expect(await json(p, ['search', 'index', 'pilot', '--name', 'pilot'])).toMatchObject({
      dir: '/home/u/indexes/pilot',
      sources: ['/projects/a/pilot'],
    });
    p.deps.cwd = '/projects/b';
    expect(await json(p, ['search', 'index', '--name', 'pilot'])).toMatchObject({
      embedded: 0,
      reused: 1,
    });
    expect((await json(p, ['search', 'query', 'token', '--index', 'pilot'])).hits[0].doc).toBe(
      '/projects/a/pilot/PROJ-1.md'
    );
    expect(await p.fs.exists('/home/u/.lassi/index')).toBe(false);
    expect(await p.fs.exists('/home/u/.lassi/export')).toBe(false);
  });

  it('keeps workspace archives untouched and accepts a quoted home path', async () => {
    const p = setup();
    await p.fs.writeFile('/projects/a/.lassi/export/jira/PROJ-1.md', '# Local edits');
    await json(p, exportArgs);
    expect(await p.fs.readFile('/projects/a/.lassi/export/jira/PROJ-1.md')).toBe('# Local edits');
    await json(p, [...exportArgs, '--out-dir', '~/pilot']);
    expect(await p.fs.exists('/home/u/pilot/PROJ-1.md')).toBe(true);
    expect(await json(p, ['search', 'index', '~/pilot'])).toMatchObject({
      sources: ['/home/u/pilot'],
    });
  });

  it('requires explicit sources and rebuild for old workspace-relative records', async () => {
    const p = setup();
    await json(p, [...exportArgs, '--out-dir', 'archive']);
    await json(p, ['search', 'index', 'archive']);
    const dir = '/home/u/.lassi/index/default';
    const index = (await readIndex(p.fs, dir))!;
    index.manifest.docs = {
      'archive/PROJ-1.md': {
        ...index.manifest.docs['/projects/a/archive/PROJ-1.md']!,
        origin: undefined,
      },
    };
    index.manifest.corpus = { sources: ['archive'], exports: [] };
    index.chunks = index.chunks.map((c) => ({ ...c, doc: 'archive/PROJ-1.md' }));
    await writeIndex(p.fs, dir, index);
    const before = await p.fs.readFile(`${dir}/manifest.json`);
    const calls = p.fetch.calls.length;
    p.deps.cwd = '/projects/b';
    for (const args of [
      ['search', 'query', 'token'],
      ['search', 'show'],
      ['search', 'index'],
      ['search', 'index', '--rebuild'],
    ])
      expect(await p.run(args)).toBe(2);
    expect(p.stderr()).toContain('legacy workspace-relative paths');
    expect(p.fetch.calls).toHaveLength(calls);
    expect(await p.fs.readFile(`${dir}/manifest.json`)).toBe(before);
    expect(await json(p, ['search', 'index', '/projects/a/archive', '--rebuild'])).toMatchObject({
      documents: 1,
    });
    expect((await json(p, ['search', 'query', 'token'])).hits[0].doc).toBe(
      '/projects/a/archive/PROJ-1.md'
    );
  });

  it('preserves the shared export when another Jira instance uses the same directory', async () => {
    const p = setup();
    await json(p, exportArgs);
    const path = '/home/u/.lassi/export/jira/manifest.json';
    const before = await p.fs.readFile(path);
    p.deps.cwd = '/projects/b';
    p.deps.env['LASSI_JIRA_URL'] = 'https://other-jira.example.internal';
    const calls = p.fetch.calls.length;
    expect(await p.run(exportArgs)).toBe(2);
    expect(await p.fs.readFile(path)).toBe(before);
    expect(p.fetch.calls).toHaveLength(calls);
  });

  it.each(['.', '..'])('rejects %s as a shared index name', async (name) => {
    const p = setup();
    expect(await p.run(['search', 'index', '--name', name])).toBe(2);
    expect(await p.run(['search', 'show', '--index', name])).toBe(2);
    expect(p.fetch.calls).toHaveLength(0);
  });
});
