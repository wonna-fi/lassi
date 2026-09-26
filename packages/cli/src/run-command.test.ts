import { describe, expect, it } from 'vitest';
import { BOTH_PRODUCTS_ENV, lastJsonLine, makeTestProgram } from './test/program.js';

describe('error contract through a real command', () => {
  it('renders an LassiError as human line + JSON, sets the exit code, keeps stdout empty with --json', async () => {
    const t = makeTestProgram({ env: { LASSI_CONFIG: '/nope.json' } });
    expect(await t.run(['config', 'show', '--json'])).toBe(2);
    expect(t.stdout()).toBe('');
    expect(t.stderr().startsWith('error: config file not found: /nope.json\n')).toBe(true);
    expect(lastJsonLine(t.stderr())).toEqual({
      code: 'usage',
      message: 'config file not found: /nope.json',
    });
  });

  it('adds the token file path and product to hints from HTTP failures', async () => {
    const t = makeTestProgram({
      env: {
        ...BOTH_PRODUCTS_ENV,
        LASSI_JIRA_TOKEN: undefined,
        LASSI_JIRA_TOKEN_FILE: '/t/jira.txt',
      },
      files: { '/t/jira.txt': 'file-token\n' },
      routes: [
        { path: '/status', status: 200, text: 'ok' },
        { path: '/rest/api/2/myself', status: 401, json: { errorMessages: ['Unauthorized'] } },
      ],
    });
    await t.run(['doctor', '--json']);
    const results = JSON.parse(t.stdout()) as Array<{
      name: string;
      status: string;
      hint?: string;
    }>;
    const cred = results.find((r) => r.name === 'Jira credentials');
    expect(cred?.status).toBe('FAIL');
    expect(cred?.hint).toContain('/t/jira.txt');
  });

  it('redacts tokens from stdout and stderr even when the server echoes them', async () => {
    const t = makeTestProgram({
      env: BOTH_PRODUCTS_ENV,
      routes: [
        {
          path: '/rest/api/2/myself',
          status: 401,
          json: { errorMessages: ['token jira-secret-token rejected'] },
        },
      ],
    });
    await t.run(['doctor', '--verbose']);
    expect(t.stdout()).not.toContain('jira-secret-token');
    expect(t.stderr()).not.toContain('jira-secret-token');
    expect(t.stdout()).toContain('token *** rejected');
  });

  it('refuses a token file with a second line before sending, and never prints the token', async () => {
    const env = {
      ...BOTH_PRODUCTS_ENV,
      LASSI_JIRA_TOKEN: undefined,
      LASSI_JIRA_TOKEN_FILE: '/t/jira.txt',
    };
    const files = { '/t/jira.txt': 'jira-file-pat-1234\n# created 2026-01-01\n' };
    const get = makeTestProgram({ env, files });
    expect(await get.run(['jira', 'issue', 'get', 'PROJ-1'])).toBe(3);
    expect(lastJsonLine(get.stderr())).toMatchObject({
      code: 'auth',
      message:
        'token file has a line break or another control character inside the token: /t/jira.txt',
    });
    expect(get.fetch.calls).toHaveLength(0);

    const doctor = makeTestProgram({ env, files, routes: [{ path: '/status', text: 'ok' }] });
    await doctor.run(['doctor', '--json']);
    for (const t of [get, doctor]) {
      expect(t.stdout()).not.toContain('jira-file-pat');
      expect(t.stderr()).not.toContain('jira-file-pat');
    }
  });
});
