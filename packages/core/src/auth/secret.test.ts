import { describe, expect, it } from 'vitest';
import { resolveSecret } from './secret.js';

const messages = {
  missing:
    'no embeddings API key configured: set embeddings.apiKeyFile or LASSI_EMBEDDINGS_API_KEY',
  unreadable: (p: string) => `API key file not readable: ${p}`,
  empty: (p: string) => `API key file is empty: ${p}`,
  malformed: (p?: string) =>
    p === undefined ? 'API key has a line break' : `API key file has a line break: ${p}`,
};
const files: Record<string, string> = {
  '/k/key.txt': '﻿  sk-secret-1234 \n',
  '/k/empty.txt': ' \n',
  '/k/commented.txt': 'sk-secret-1234\n# created 2026-01-01\n',
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

  it.each([
    'sk-secret-1234\r\n# note',
    'sk-secret\u00001234',
    'sk-secret\t1234',
    'sk-secret\u00851234',
  ])('refuses a control character inside the value without quoting it (%j)', async (envValue) => {
    const failure = await resolveSecret({ envValue, readFile, messages }).catch((e: unknown) => e);
    expect(failure).toMatchObject({ code: 'auth', message: 'API key has a line break' });
    expect(JSON.stringify(failure)).not.toContain('sk-secret');
  });

  it('refuses a file that holds more than the secret, naming the file', async () => {
    await expect(
      resolveSecret({ file: '/k/commented.txt', readFile, messages })
    ).rejects.toMatchObject({
      code: 'auth',
      message: 'API key file has a line break: /k/commented.txt',
      hint: 'keep only the secret in /k/commented.txt, on a single line',
      context: { tokenFile: '/k/commented.txt' },
    });
  });
});
