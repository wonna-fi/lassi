import { describe, expect, it } from 'vitest';
import { memFs } from '../testing/mem-fs.js';
import { loadConfig } from './load.js';

const base = { cwd: '/home/u/proj', homedir: '/home/u' };

describe('embeddings config', () => {
  it('has safe defaults and maps its environment variables', async () => {
    const loaded = await loadConfig({ ...base, env: {}, fs: memFs() });
    expect(loaded.config.embeddings).toEqual({
      auth: 'bearer',
      azureScope: 'https://cognitiveservices.azure.com/.default',
      batchSize: 64,
      chunkChars: 1500,
      chunkOverlap: 200,
      minScore: 0.33,
    });
    const env = await loadConfig({
      ...base,
      env: {
        LASSI_EMBEDDINGS_URL: 'https://embeddings.example.internal/v1/',
        LASSI_EMBEDDINGS_API_KEY: 'sk-secret-key',
        LASSI_EMBEDDINGS_API_KEY_FILE: '~/keys/emb.txt',
      },
      fs: memFs(),
    });
    expect(env.config.embeddings.url).toBe('https://embeddings.example.internal/v1');
    expect(env.config.embeddings.apiKey).toBe('sk-secret-key');
    expect(env.config.embeddings.apiKeyFile).toBe('/home/u/keys/emb.txt');
    expect(env.secrets).toContain('sk-secret-key');
    expect(env.sources['embeddings.apiKey']).toEqual({
      source: 'env',
      from: 'LASSI_EMBEDDINGS_API_KEY',
    });
  });

  it('reads the file section, validates the auth header and the chunk geometry', async () => {
    const good = await loadConfig({
      ...base,
      env: {},
      fs: memFs({
        '/home/u/.lassi.json': JSON.stringify({
          embeddings: {
            url: 'https://embeddings.example.internal/openai',
            model: 'text-embedding-3-small',
            auth: 'api-key',
            apiVersion: '2024-02-01',
            dimensions: 256,
            batchSize: 16,
          },
        }),
      }),
    });
    expect(good.config.embeddings).toMatchObject({
      model: 'text-embedding-3-small',
      auth: 'api-key',
      apiVersion: '2024-02-01',
      dimensions: 256,
      batchSize: 16,
      chunkChars: 1500,
    });
    await expect(
      loadConfig({
        ...base,
        env: {},
        fs: memFs({ '/home/u/.lassi.json': JSON.stringify({ embeddings: { auth: 'basic' } }) }),
      })
    ).rejects.toMatchObject({ code: 'usage' });
    await expect(
      loadConfig({
        ...base,
        env: {},
        fs: memFs({
          '/home/u/.lassi.json': JSON.stringify({
            embeddings: { chunkChars: 500, chunkOverlap: 500 },
          }),
        }),
      })
    ).rejects.toMatchObject({ code: 'usage', message: expect.stringContaining('chunkOverlap') });
  });
});

describe('embeddings config guards', () => {
  const base = { cwd: '/home/u/proj', homedir: '/home/u' };
  const load = (embeddings: Record<string, unknown>, env: Record<string, string> = {}) =>
    loadConfig({
      ...base,
      env,
      fs: memFs({ '/home/u/.lassi.json': JSON.stringify({ embeddings }) }),
    });

  it('takes a similarity floor in range and refuses one outside it', async () => {
    expect((await load({ minScore: 0.5 })).config.embeddings.minScore).toBe(0.5);
    expect((await load({ minScore: 0 })).config.embeddings.minScore).toBe(0);
    // 1 is unreachable in float32, so it would silence every query rather than tighten it.
    await expect(load({ minScore: 1 })).rejects.toMatchObject({ code: 'usage' });
    await expect(load({ minScore: 1.5 })).rejects.toMatchObject({ code: 'usage' });
    await expect(load({ minScore: -0.1 })).rejects.toMatchObject({ code: 'usage' });
  });

  it('names the replacement for the renamed authHeader key', async () => {
    await expect(load({ authHeader: 'api-key' })).rejects.toMatchObject({
      code: 'usage',
      message: 'invalid configuration (/home/u/.lassi.json): "embeddings.authHeader" was renamed',
      hint: 'use "embeddings.auth" instead of "embeddings.authHeader"',
    });
  });

  it('validates azure-ad: a well-formed scope, no key beside it, no scope without it', async () => {
    const ok = await load({
      auth: 'azure-ad',
      azureScope: 'https://cognitiveservices.azure.com/.default',
    });
    expect(ok.config.embeddings.auth).toBe('azure-ad');
    await expect(load({ auth: 'azure-ad', azureScope: '' })).rejects.toMatchObject({
      code: 'usage',
      message: expect.stringContaining('azureScope'),
    });
    await expect(load({ auth: 'azure-ad', azureScope: 'not a scope' })).rejects.toMatchObject({
      code: 'usage',
    });
    await expect(load({ auth: 'azure-ad', apiKeyFile: '~/k.txt' })).rejects.toMatchObject({
      code: 'usage',
      message: expect.stringContaining('would be ignored'),
    });
    await expect(
      load({ auth: 'azure-ad' }, { LASSI_EMBEDDINGS_API_KEY: 'sk-x' })
    ).rejects.toMatchObject({ code: 'usage' });
    await expect(
      load({ azureScope: 'https://cognitiveservices.azure.com/.default' })
    ).rejects.toMatchObject({
      code: 'usage',
      message: expect.stringContaining('only applies to embeddings.auth "azure-ad"'),
    });
  });
});
