import { describe, expect, it } from 'vitest';
import { classifyMode } from './permissions.js';
import { normalizeToken, resolveToken } from './token.js';

describe('resolveToken', () => {
  const readFile = async (path: string): Promise<string> => {
    if (path === '/t/ok.txt') return '﻿  pat-value-123\n';
    if (path === '/t/empty.txt') return '\n\n';
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };

  it('prefers the environment token over the file', async () => {
    expect(
      await resolveToken({
        product: 'jira',
        envToken: ' env-pat \n',
        tokenFile: '/t/ok.txt',
        readFile,
      })
    ).toEqual({
      token: 'env-pat',
      source: 'env',
    });
  });

  it('reads the file, strips BOM and whitespace', async () => {
    expect(await resolveToken({ product: 'jira', tokenFile: '/t/ok.txt', readFile })).toEqual({
      token: 'pat-value-123',
      source: 'file',
      path: '/t/ok.txt',
    });
    expect(normalizeToken('﻿abc\r\n')).toBe('abc');
  });

  it('refuses empty and unreadable files with auth errors carrying the path', async () => {
    await expect(
      resolveToken({ product: 'jira', tokenFile: '/t/empty.txt', readFile })
    ).rejects.toMatchObject({
      code: 'auth',
      message: 'token file is empty: /t/empty.txt',
      context: { product: 'jira', tokenFile: '/t/empty.txt' },
    });
    await expect(
      resolveToken({ product: 'confluence', tokenFile: '/t/nope.txt', readFile })
    ).rejects.toMatchObject({
      code: 'auth',
      message: 'token file not readable: /t/nope.txt',
    });
  });

  it('explains how to configure a token when nothing is set', async () => {
    await expect(resolveToken({ product: 'jira', envToken: '', readFile })).rejects.toMatchObject({
      code: 'auth',
      message:
        'no token configured for jira: set jira.tokenFile in ~/.lassi.json or LASSI_JIRA_TOKEN',
    });
  });
});

describe('classifyMode', () => {
  it.each([
    [0o100600, 'linux', 'ok'],
    [0o100640, 'linux', 'group-readable'],
    [0o100644, 'linux', 'world-readable'],
    [0o100777, 'linux', 'world-readable'],
    [0o100777, 'win32', 'not-applicable'],
  ] as const)('mode %o on %s → %s', (mode, platform, expected) => {
    expect(classifyMode(mode, platform)).toBe(expected);
  });
});
