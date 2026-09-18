import { describe, expect, it } from 'vitest';
import { memFs } from '../testing/mem-fs.js';
import { loadConfig } from './load.js';

const HOME = JSON.stringify({
  jira: { url: 'https://jira-prod.example.internal', tokenFile: '/home/u/prod-token' },
});
const EXPLICIT = JSON.stringify({
  jira: { url: 'https://jira-sandbox.example.internal', tokenFile: '/tmp/ci-token' },
});

describe('an explicit --config outranks the home file', () => {
  it('does not let the home file come back as the workspace layer from a cwd under $HOME', async () => {
    const fs = memFs({ '/home/u/.lassi.json': HOME, '/tmp/ci.json': EXPLICIT });
    const loaded = await loadConfig({
      env: {},
      cwd: '/home/u/projects/app',
      homedir: '/home/u',
      explicitPath: '/tmp/ci.json',
      fs,
    });
    expect(loaded.config.jira.url).toBe('https://jira-sandbox.example.internal');
    expect(loaded.config.jira.tokenFile).toBe('/tmp/ci-token');
    expect(loaded.files).toEqual({ global: '/tmp/ci.json' });
  });

  it('still applies a real workspace file beside the explicit one', async () => {
    const fs = memFs({
      '/home/u/.lassi.json': HOME,
      '/tmp/ci.json': EXPLICIT,
      '/home/u/projects/app/.lassi.json': JSON.stringify({ jira: { defaultProject: 'PROJ' } }),
    });
    const loaded = await loadConfig({
      env: {},
      cwd: '/home/u/projects/app',
      homedir: '/home/u',
      explicitPath: '/tmp/ci.json',
      fs,
    });
    expect(loaded.config.jira.url).toBe('https://jira-sandbox.example.internal');
    expect(loaded.config.jira.defaultProject).toBe('PROJ');
    expect(loaded.files.workspace).toBe('/home/u/projects/app/.lassi.json');
  });

  it('uses the home file as the global layer when no --config is given', async () => {
    const fs = memFs({ '/home/u/.lassi.json': HOME });
    const loaded = await loadConfig({
      env: {},
      cwd: '/home/u/projects/app',
      homedir: '/home/u',
      fs,
    });
    expect(loaded.config.jira.url).toBe('https://jira-prod.example.internal');
    expect(loaded.files).toEqual({ global: '/home/u/.lassi.json' });
  });
});

describe('a config file cannot reach Object.prototype', () => {
  it('drops a __proto__ path instead of writing through it', async () => {
    const fs = memFs({
      '/home/u/.lassi.json':
        '{"jira":{"url":"https://jira.example.internal"},"__proto__":{"polluted":true}}',
    });
    const loaded = await loadConfig({ env: {}, cwd: '/home/u', homedir: '/home/u', fs });
    expect(loaded.config.jira.url).toBe('https://jira.example.internal');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});
