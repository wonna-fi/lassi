import { describe, expect, it } from 'vitest';
import { resolveSecret } from './secret.js';

const messages = {
  missing:
    'no embeddings API key configured: set embeddings.apiKeyFile or LASSI_EMBEDDINGS_API_KEY',
  unreadable: (p: string) => `API key file not readable: ${p}`,
  empty: (p: string) => `API key file is empty: ${p}`,
};
const files: Record<string, string> = {
  '/k/key.txt': '﻿  sk-secret-1234 \n',
  '/k/empty.txt': ' \n',
};
const readFile = async (p: string): Promise<string> => {
  const content = files[p];
  if (content === undefined) throw new Error('ENOENT');
  return content;
};

describe('resolveSecret', () => {
  it('prefers the environment value, trimmed', async () => {
    expect(
      await resolveSecret({ envValue: ' env-key \n', file: '/k/key.txt', readFile, messages })
    ).toEqual({
      value: 'env-key',
      source: 'env',
    });
  });

  it('reads the file, strips the BOM and whitespace, and reports the path', async () => {
    expect(await resolveSecret({ file: '/k/key.txt', readFile, messages })).toEqual({
      value: 'sk-secret-1234',
      source: 'file',
      path: '/k/key.txt',
    });
  });

  it("fails with auth and the caller's messages when missing, unreadable or empty", async () => {
    await expect(resolveSecret({ readFile, messages })).rejects.toMatchObject({
      code: 'auth',
      message: messages.missing,
    });
    await expect(resolveSecret({ file: '/k/nope.txt', readFile, messages })).rejects.toMatchObject({
      code: 'auth',
      message: 'API key file not readable: /k/nope.txt',
      context: { tokenFile: '/k/nope.txt' },
    });
    await expect(
      resolveSecret({ envValue: '  ', file: '/k/empty.txt', readFile, messages })
    ).rejects.toMatchObject({
      code: 'auth',
      message: 'API key file is empty: /k/empty.txt',
    });
  });
});
