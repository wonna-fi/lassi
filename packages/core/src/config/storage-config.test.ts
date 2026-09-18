import { describe, expect, it } from 'vitest';
import { memFs } from '../testing/mem-fs.js';
import { loadConfig } from './load.js';

const base = { cwd: '/work/app', homedir: '/home/u', env: {} };
const json = JSON.stringify;

describe('configuration and storage locations', () => {
  it('combines home and closest workspace config without changing files', async () => {
    const fs = memFs({
      '/home/u/.lassi.json': json({ jira: { url: 'https://jira.example.internal' } }),
      '/work/.lassi.json': json({ jira: { defaultProject: 'DEV' } }),
      '/work/app/.lassi.json': json({ jira: { defaultProject: 'PROJ' } }),
      '/home/u/.lassi/export/jira/PROJ-1.md': 'existing export',
    });
    const before = [...fs.files];
    const result = await loadConfig({ ...base, fs });
    expect(result.files).toEqual({
      global: '/home/u/.lassi.json',
      workspace: '/work/app/.lassi.json',
    });
    expect(result.config.jira.url).toBe('https://jira.example.internal');
    expect(result.config.jira.defaultProject).toBe('PROJ');
    expect(result.config.storage).toEqual({
      exportDir: '/home/u/.lassi/export',
      indexDir: '/home/u/.lassi/index',
    });
    expect(result.workspaceStateDir).toBe('/work/app/.lassi');
    expect([...fs.files]).toEqual(before);
  });

  it('keeps shared defaults independent of the working directory', async () => {
    const fs = memFs({});
    const a = await loadConfig({ ...base, fs });
    const b = await loadConfig({ ...base, cwd: '/another/project', fs });
    expect(a.config.storage).toEqual(b.config.storage);
    expect(b.workspaceStateDir).toBe('/another/project/.lassi');
  });

  it('resolves relative shared paths against the global config directory', async () => {
    const fs = memFs({
      '/profiles/config.json': json({ storage: { exportDir: './archive', indexDir: './vectors' } }),
    });
    const result = await loadConfig({ ...base, explicitPath: '/profiles/config.json', fs });
    expect(result.config.storage).toEqual({
      exportDir: '/profiles/archive',
      indexDir: '/profiles/vectors',
    });
  });

  it('ignores an empty environment override and records a nonempty override', async () => {
    const fs = memFs({
      '/home/u/.lassi.json': json({ storage: { indexDir: '/configured/index' } }),
    });
    const empty = await loadConfig({ ...base, fs, env: { LASSI_INDEX_DIR: '' } });
    expect(empty.config.storage.indexDir).toBe('/configured/index');
    const explicit = await loadConfig({ ...base, fs, env: { LASSI_INDEX_DIR: '/override/index' } });
    expect(explicit.config.storage.indexDir).toBe('/override/index');
    expect(explicit.sources['storage.indexDir']?.from).toBe('LASSI_INDEX_DIR');
  });

  it('does not let a workspace redirect shared storage', async () => {
    const fs = memFs({ '/work/.lassi.json': json({ storage: { indexDir: '/untrusted/index' } }) });
    await expect(loadConfig({ ...base, fs })).rejects.toMatchObject({ code: 'usage' });
  });

  it('uses native Windows home and workspace paths', async () => {
    const fs = memFs({ 'C:\\Users\\u\\.lassi.json': '{}' });
    const result = await loadConfig({ cwd: 'D:\\work', homedir: 'C:\\Users\\u', env: {}, fs });
    expect(result.files.global).toBe('C:\\Users\\u\\.lassi.json');
    expect(result.config.storage.indexDir).toBe('C:\\Users\\u\\.lassi\\index');
    expect(result.workspaceStateDir).toBe('D:\\work\\.lassi');
  });
});
