import { describe, expect, it } from 'vitest';
import { memFs } from '../testing/mem-fs.js';
import { loadConfig } from './load.js';

describe('shared storage configuration', () => {
  it.each([
    {
      homedir: '/home/u',
      cwd: '/work/project',
      exportDir: '/home/u/.lassi/export',
      indexDir: '/home/u/.lassi/index',
    },
    {
      homedir: 'C:\\Users\\u',
      cwd: 'D:\\work\\project',
      exportDir: 'C:\\Users\\u\\.lassi\\export',
      indexDir: 'C:\\Users\\u\\.lassi\\index',
    },
  ])(
    'uses the injected home directory from $cwd',
    async ({ homedir, cwd, exportDir, indexDir }) => {
      const loaded = await loadConfig({ env: {}, cwd, homedir, fs: memFs() });
      expect(loaded.config.storage).toEqual({ exportDir, indexDir });
      expect(loaded.sources['storage.exportDir']).toEqual({ source: 'default' });
    }
  );

  it('resolves file paths against their config file and env paths against home', async () => {
    const fs = memFs({
      '/settings/profile.json': JSON.stringify({
        storage: { exportDir: './archives', indexDir: '~/indexes' },
      }),
    });
    for (const cwd of ['/work/a', '/work/b']) {
      const loaded = await loadConfig({
        env: {},
        cwd,
        homedir: '/home/u',
        explicitPath: '/settings/profile.json',
        fs,
      });
      expect(loaded.config.storage).toEqual({
        exportDir: '/settings/archives',
        indexDir: '/home/u/indexes',
      });
      expect(loaded.sources['storage.exportDir']).toEqual({
        source: 'global',
        from: '/settings/profile.json',
      });
      const overridden = await loadConfig({
        env: { LASSI_EXPORT_DIR: 'archives', LASSI_INDEX_DIR: '/data/indexes' },
        cwd,
        homedir: '/home/u',
        explicitPath: '/settings/profile.json',
        fs,
      });
      expect(overridden.config.storage).toEqual({
        exportDir: '/home/u/archives',
        indexDir: '/data/indexes',
      });
      expect(overridden.sources['storage.indexDir']).toEqual({
        source: 'env',
        from: 'LASSI_INDEX_DIR',
      });
    }
  });

  it('rejects workspace overrides of shared storage', async () => {
    const fs = memFs({
      '/work/.lassi.json': JSON.stringify({
        storage: { exportDir: '../other-project', indexDir: '../shared-index' },
      }),
    });
    await expect(
      loadConfig({ env: {}, cwd: '/work/project', homedir: '/home/u', fs })
    ).rejects.toMatchObject({
      code: 'usage',
      message: expect.stringContaining('storage.exportDir, storage.indexDir'),
    });
  });

  it.each(['exportDir', 'indexDir'])('rejects a blank %s instead of scanning home', async (key) => {
    const fs = memFs({ '/home/u/.lassi.json': JSON.stringify({ storage: { [key]: '  ' } }) });
    await expect(
      loadConfig({ env: {}, cwd: '/work', homedir: '/home/u', fs })
    ).rejects.toMatchObject({ code: 'usage' });
  });
});
