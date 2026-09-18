import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeFs } from '@wonna/lassi-core';
import { describe, expect, it } from 'vitest';
import { buildContext } from '../../context.js';
import { BOTH_PRODUCTS_ENV, makeTestProgram } from '../../test/program.js';
import { assertIndexTarget, STORAGE_LOCK, withStorageLock } from './storage.js';

function exporter(key: string) {
  return makeTestProgram({
    env: { ...BOTH_PRODUCTS_ENV },
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
              id: key.slice(-1),
              key,
              fields: { summary: key, description: 'Description', updated: '2026-09-01' },
            },
          ],
        },
      },
    ],
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('shared storage writers', () => {
  it('refuses a concurrent export, then retains both queries when it is retried', async () => {
    const a = exporter('PROJ-1');
    const b = exporter('PROJ-2');
    b.deps.fs = a.fs;
    b.deps.cwd = '/another/project';
    const started = deferred();
    const release = deferred();
    const fetch = a.deps.fetch;
    a.deps.fetch = async (...args) => {
      started.resolve();
      await release.promise;
      return fetch(...args);
    };
    const run = a.run(['jira', 'issue', 'export', 'key = PROJ-1']);
    await started.promise;
    try {
      expect(await b.run(['jira', 'issue', 'export', 'key = PROJ-2'])).toBe(6);
      expect(b.stderr()).toContain('another lassi operation holds');
      expect(b.fetch.calls).toHaveLength(0);
    } finally {
      release.resolve();
    }
    expect(await run).toBe(0);
    expect(await b.run(['jira', 'issue', 'export', 'key = PROJ-2'])).toBe(0);
    const manifest = JSON.parse(await a.fs.readFile('/home/u/.lassi/export/jira/manifest.json'));
    expect(Object.keys(manifest.items).sort()).toEqual(['PROJ-1', 'PROJ-2']);
    expect(manifest.queries).toEqual(['key = PROJ-1', 'key = PROJ-2']);
    expect(await a.fs.exists(`/home/u/.lassi/export/jira/${STORAGE_LOCK}`)).toBe(false);
  });

  it('releases a failed writer and keeps dry-run free of lock writes', async () => {
    const p = exporter('PROJ-1');
    const ctx = await buildContext(p.deps, {});
    const action = async () => {
      throw new Error('disk error');
    };
    await expect(withStorageLock(ctx, '/archive', action)).rejects.toThrow('disk error');
    expect(await p.fs.exists(`/archive/${STORAGE_LOCK}`)).toBe(false);
    expect(await withStorageLock(ctx, '/dry-run', async () => 7, { dryRun: true })).toBe(7);
    expect(await p.fs.exists('/dry-run')).toBe(false);
  });

  it('detects aliases and nested index targets through real directory symlinks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lassi-storage-'));
    try {
      const archive = join(dir, 'archive');
      const alias = join(dir, 'alias');
      await mkdir(archive);
      await symlink(archive, alias, 'junction');
      for (const target of [alias, join(alias, 'new-index'), dir]) {
        await expect(assertIndexTarget(nodeFs(), target, [archive])).rejects.toMatchObject({
          code: 'usage',
          message: expect.stringContaining('overlaps'),
        });
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
