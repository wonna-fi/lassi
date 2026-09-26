import { describe, expect, it } from 'vitest';
import { BOTH_PRODUCTS_ENV, makeTestProgram } from '../../test/program.js';
import { staleBuildStatus } from './checks/stale-build.js';

interface Row {
  name: string;
  status: string;
  detail: string;
  hint?: string;
}

async function doctor(
  opts: Parameters<typeof makeTestProgram>[0]
): Promise<{ code: number; rows: Row[]; text: string }> {
  const t = makeTestProgram(opts);
  const code = await t.run(['doctor', '--json']);
  const rows = JSON.parse(t.stdout()) as Row[];
  return { code, rows, text: t.stdout() };
}

const HAPPY_ROUTES = [
  { path: '/status', text: 'RUNNING' },
  { path: '/rest/api/2/myself', json: { name: 'jsmith' } },
  { path: '/rest/api/user/current', json: { username: 'jsmith', type: 'known' } },
  { path: '/rest/api/2/serverInfo', json: { version: '9.12.4', deploymentType: 'Server' } },
  { path: '/rest/api/settings/systemInfo', json: { version: '8.5.10' } },
  { path: '/rest/api/2/field', json: [{ id: 'customfield_10001', name: 'Team' }] },
];

describe('doctor', () => {
  it('passes with both products configured through the environment', async () => {
    const { code, rows } = await doctor({
      env: BOTH_PRODUCTS_ENV,
      routes: HAPPY_ROUTES,
      builtAt: '2026-09-04T09:00:00.000Z',
    });
    expect(code).toBe(0);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName['Jira config']?.status).toBe('PASS');
    expect(byName['Jira credentials']).toMatchObject({
      status: 'PASS',
      detail: 'authenticated as jsmith',
    });
    expect(byName['Confluence credentials']?.status).toBe('PASS');
    expect(byName['Jira version']).toMatchObject({ status: 'PASS', detail: '9.12.4 (Server)' });
    expect(byName['Confluence version']).toMatchObject({ status: 'PASS', detail: '8.5.10' });
    expect(byName['Jira token file permissions']?.status).toBe('SKIP');
    expect(byName['Proxy']?.status).toBe('PASS');
    expect(byName['Build freshness']?.status).toBe('PASS');
    expect(byName['Workspace config secrets']?.status).toBe('SKIP');
    expect(byName['Jira field aliases']?.status).toBe('SKIP');
  });

  it('renders a markdown table by default', async () => {
    const t = makeTestProgram({ env: BOTH_PRODUCTS_ENV, routes: HAPPY_ROUTES });
    await t.run(['doctor']);
    expect(t.stdout()).toContain('| Check | Status | Detail |');
    expect(t.stdout()).toContain('| Jira credentials | PASS | authenticated as jsmith |');
  });

  it('warns for unconfigured products and never fails on them', async () => {
    const { code, rows } = await doctor({
      env: { LASSI_JIRA_URL: 'https://jira.example.internal', LASSI_JIRA_TOKEN: 'x-token' },
      routes: HAPPY_ROUTES,
    });
    expect(code).toBe(0);
    expect(rows.find((r) => r.name === 'Confluence config')).toMatchObject({
      status: 'WARN',
      detail: 'not configured',
    });
    expect(rows.find((r) => r.name === 'Confluence credentials')?.status).toBe('SKIP');
  });

  it('fails config when the token file is missing and skips the network checks for that product', async () => {
    const { code, rows } = await doctor({
      env: {
        LASSI_JIRA_URL: 'https://jira.example.internal',
        LASSI_JIRA_TOKEN_FILE: '/t/missing.txt',
      },
      routes: HAPPY_ROUTES,
    });
    expect(code).toBe(1);
    expect(rows.find((r) => r.name === 'Jira config')).toMatchObject({
      status: 'FAIL',
      detail: 'token file not readable: /t/missing.txt',
    });
    expect(rows.find((r) => r.name === 'Jira credentials')?.status).toBe('SKIP');
  });

  it('warns on group/world-readable token files unless suppressed', async () => {
    const files = {
      '/t/jira.txt': 'tok-1234\n',
      '/home/u/.lassi.json': JSON.stringify({
        jira: { url: 'https://jira.example.internal', tokenFile: '/t/jira.txt' },
      }),
    };
    const t = makeTestProgram({ files, routes: HAPPY_ROUTES });
    t.fs.modes.set('/t/jira.txt', 0o100644);
    await t.run(['doctor', '--json']);
    const rows = JSON.parse(t.stdout()) as Row[];
    expect(rows.find((r) => r.name === 'Jira token file permissions')).toMatchObject({
      status: 'WARN',
      detail: '/t/jira.txt is world-readable',
    });

    const suppressed = makeTestProgram({
      files: {
        ...files,
        '/home/u/.lassi.json': JSON.stringify({
          jira: { url: 'https://jira.example.internal', tokenFile: '/t/jira.txt' },
          tokenPermissionWarning: false,
        }),
      },
      routes: HAPPY_ROUTES,
    });
    suppressed.fs.modes.set('/t/jira.txt', 0o100644);
    await suppressed.run(['doctor', '--json']);
    expect(
      (JSON.parse(suppressed.stdout()) as Row[]).find(
        (r) => r.name === 'Jira token file permissions'
      )?.status
    ).toBe('SKIP');
  });

  it('turns a TLS failure into FAIL with the NODE_EXTRA_CA_CERTS hint', async () => {
    const t = makeTestProgram({
      env: { LASSI_JIRA_URL: 'https://jira.example.internal', LASSI_JIRA_TOKEN: 'x-token' },
      routes: [
        {
          path: '/status',
          handler: () => {
            throw new TypeError('fetch failed', {
              cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
            });
          },
        },
        { path: '/rest/api/2/myself', json: { name: 'jsmith' } },
        { path: '/rest/api/2/serverInfo', json: { version: '9.4.0' } },
      ],
    });
    expect(await t.run(['doctor', '--json'])).toBe(1);
    const row = (JSON.parse(t.stdout()) as Row[]).find((r) => r.name === 'Jira connectivity');
    expect(row).toMatchObject({
      status: 'FAIL',
      detail: 'TLS certificate not trusted (UNABLE_TO_VERIFY_LEAF_SIGNATURE)',
    });
    expect(row?.hint).toContain('NODE_EXTRA_CA_CERTS');
    const rows = JSON.parse(t.stdout()) as Row[];
    expect(rows.find((r) => r.name === 'Jira credentials')).toMatchObject({
      status: 'SKIP',
      detail: 'unreachable (see connectivity)',
    });
    expect(rows.find((r) => r.name === 'Jira version')?.status).toBe('SKIP');
    expect(t.fetch.calls.filter((c) => c.url.pathname === '/rest/api/2/myself')).toHaveLength(0);
  });

  it('reports 401 as a credentials FAIL with the token path', async () => {
    const { code, rows } = await doctor({
      env: { LASSI_JIRA_URL: 'https://jira.example.internal', LASSI_JIRA_TOKEN: 'x-token' },
      routes: [
        { path: '/status', text: 'ok' },
        { path: '/rest/api/2/myself', status: 401, json: { errorMessages: ['Unauthorized'] } },
        { path: '/rest/api/2/serverInfo', json: { version: '9.4.0' } },
      ],
    });
    expect(code).toBe(1);
    expect(rows.find((r) => r.name === 'Jira credentials')).toMatchObject({
      status: 'FAIL',
      detail: 'Unauthorized',
    });
  });

  it('flags a Confluence anonymous answer and falls back to the space probe for the version', async () => {
    const { code, rows } = await doctor({
      env: {
        LASSI_CONFLUENCE_URL: 'https://confluence.example.internal',
        LASSI_CONFLUENCE_TOKEN: 'x-token',
      },
      routes: [
        { path: '/status', text: 'ok' },
        { path: '/rest/api/user/current', json: { type: 'anonymous' } },
        { path: '/rest/api/settings/systemInfo', status: 404, text: 'nope' },
        { path: '/rest/api/space', json: { results: [] } },
      ],
    });
    expect(code).toBe(1);
    expect(rows.find((r) => r.name === 'Confluence credentials')?.status).toBe('FAIL');
    expect(rows.find((r) => r.name === 'Confluence version')).toMatchObject({
      status: 'WARN',
      detail: 'systemInfo endpoint unavailable; API reachable, version unknown',
    });
  });

  it('reads the Confluence version from the applinks manifest when systemInfo is admin-only', async () => {
    const { rows } = await doctor({
      env: {
        LASSI_CONFLUENCE_URL: 'https://confluence.example.internal',
        LASSI_CONFLUENCE_TOKEN: 'x-token',
      },
      routes: [
        { path: '/status', text: 'ok' },
        { path: '/rest/api/user/current', json: { type: 'known', username: 'jsmith' } },
        {
          path: '/rest/api/settings/systemInfo',
          status: 403,
          json: { statusCode: 403, message: 'admin only' },
        },
        {
          path: '/rest/applinks/1.0/manifest',
          text: '<manifest><version>8.5.10</version></manifest>',
          headers: { 'content-type': 'application/xml' },
        },
      ],
    });
    expect(rows.find((r) => r.name === 'Confluence version')).toMatchObject({
      status: 'PASS',
      detail: '8.5.10 (via applinks manifest)',
    });
  });

  it('warns outside the tested baseline, on proxy without NODE_USE_ENV_PROXY, on workspace secrets and unresolved aliases', async () => {
    const t = makeTestProgram({
      env: { ...BOTH_PRODUCTS_ENV, HTTPS_PROXY: 'http://proxy.example.internal:8080' },
      files: {
        '/home/u/proj/.lassi.json': JSON.stringify({
          jira: {
            fields: { team: 'customfield_10001', bogus: 'customfield_10009' },
            // A PAT pasted where a workspace file may put text; inline token keys fail to load.
            templates: { bug: { summary: 'lassi-test-not-a-real-token-0000000000000000' } },
          },
        }),
      },
      routes: [
        ...HAPPY_ROUTES.filter((r) => r.path !== '/rest/api/2/serverInfo'),
        { path: '/rest/api/2/serverInfo', json: { version: '8.20.0' } },
      ],
    });
    expect(await t.run(['doctor', '--json'])).toBe(0);
    const rows = JSON.parse(t.stdout()) as Row[];
    expect(rows.find((r) => r.name === 'Jira version')).toMatchObject({ status: 'WARN' });
    expect(rows.find((r) => r.name === 'Proxy')).toMatchObject({ status: 'WARN' });
    expect(rows.find((r) => r.name === 'Workspace config secrets')).toMatchObject({
      status: 'WARN',
      detail: expect.stringContaining('jira.templates.bug.summary'),
    });
    expect(rows.find((r) => r.name === 'alias team')?.status).toBe('PASS');
    expect(rows.find((r) => r.name === 'alias bogus')?.status).toBe('WARN');
  });

  it('checks build freshness from mtimes (pure)', () => {
    expect(staleBuildStatus(undefined, undefined)).toMatchObject({
      status: 'WARN',
      detail: 'no build-info.json',
    });
    expect(
      staleBuildStatus('2026-09-04T09:00:00.000Z', {
        path: '/repo/packages/core/src/x.ts',
        mtimeMs: Date.parse('2026-09-04T10:00:00Z'),
      })
    ).toMatchObject({ status: 'WARN' });
    expect(
      staleBuildStatus('2026-09-04T09:00:00.000Z', {
        path: '/repo/packages/core/src/x.ts',
        mtimeMs: Date.parse('2026-09-04T08:00:00Z'),
      })
    ).toMatchObject({ status: 'PASS' });
  });

  it('never sends a token to the unauthenticated connectivity probe', async () => {
    const t = makeTestProgram({ env: BOTH_PRODUCTS_ENV, routes: HAPPY_ROUTES });
    await t.run(['doctor']);
    const probe = t.fetch.calls.find((c) => c.url.pathname === '/status');
    expect(probe?.headers.authorization).toBeUndefined();
  });

  it('probes the createmeta shape from the issue-type list alone', async () => {
    const t = makeTestProgram({
      env: BOTH_PRODUCTS_ENV,
      files: { '/home/u/proj/.lassi.json': JSON.stringify({ jira: { defaultProject: 'PROJ' } }) },
      routes: [
        ...HAPPY_ROUTES,
        {
          path: '/rest/api/2/issue/createmeta/PROJ/issuetypes',
          json: {
            values: [
              { id: '1', name: 'Bug' },
              { id: '2', name: 'Task' },
            ],
            total: 2,
          },
        },
      ],
    });
    const code = await t.run(['doctor', '--json']);
    expect(code).toBe(0);
    const rows = JSON.parse(t.stdout()) as Row[];
    expect(rows.find((r) => r.name === 'Jira createmeta')).toMatchObject({
      status: 'PASS',
      detail: 'paginated (2 issue types in PROJ)',
    });
    const perType = t.fetch.calls.filter((c) => /\/issuetypes\/\d+/.test(c.url.pathname));
    expect(perType).toHaveLength(0);
    expect(t.fetch.unmatched).toHaveLength(0);
  });

  it('warns when a product or embeddings URL sends the credential in cleartext', async () => {
    const { rows } = await doctor({
      env: {
        LASSI_JIRA_URL: 'http://jira.example.internal',
        LASSI_JIRA_TOKEN: 'jira-secret-token',
        LASSI_EMBEDDINGS_URL: 'http://embeddings.example.internal/v1',
        LASSI_EMBEDDINGS_API_KEY: 'sk-test-key',
      },
      routes: HAPPY_ROUTES,
    });
    expect(rows.find((r) => r.name === 'Jira config')).toMatchObject({
      status: 'WARN',
      detail: expect.stringContaining('sent in cleartext'),
      hint: expect.stringContaining('use https'),
    });
    expect(rows.find((r) => r.name === 'Embeddings config')).toMatchObject({
      status: 'WARN',
      detail: expect.stringContaining('API key sent in cleartext'),
    });
    const secure = await doctor({ env: BOTH_PRODUCTS_ENV, routes: HAPPY_ROUTES });
    expect(secure.rows.find((r) => r.name === 'Jira config')).toMatchObject({ status: 'PASS' });
    expect(secure.rows.find((r) => r.name === 'Embeddings config')).toBeUndefined();
  });

  it('checks each issue template: file, field aliases and type in project', async () => {
    const { rows } = await doctor({
      env: BOTH_PRODUCTS_ENV,
      routes: [
        ...HAPPY_ROUTES,
        {
          path: '/rest/api/2/issue/createmeta/PROJ/issuetypes',
          json: { values: [{ id: '1', name: 'Bug' }], total: 1 },
        },
      ],
      files: {
        '/home/u/proj/.lassi.json': JSON.stringify({
          jira: {
            defaultProject: 'PROJ',
            fields: { team: 'customfield_10001' },
            templates: {
              bug: {
                type: 'Bug',
                fields: { team: 'Platform' },
                descriptionFile: 'templates/bug.md',
              },
              odd: {
                type: 'Story',
                fields: { nope: 1, type: 'Bug' },
                descriptionFile: 'missing.md',
              },
            },
          },
        }),
        // A directory also "exists", so the check must read the file. A workspace file may only
        // name a markdown file, so this case belongs in the global config.
        '/home/u/.lassi.json': JSON.stringify({
          jira: { templates: { dir: { type: 'Bug', descriptionFile: 'templates' } } },
        }),
        '/home/u/proj/templates/bug.md': '## Steps\n',
      },
    });
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName['template bug']).toMatchObject({
      status: 'PASS',
      detail: 'Bug in PROJ, 1 field(s)',
    });
    expect(byName['template dir']).toMatchObject({
      status: 'WARN',
      detail: expect.stringContaining('cannot read description file /home/u/templates'),
    });
    expect(byName['template odd']).toMatchObject({
      status: 'WARN',
      detail: expect.stringMatching(
        /^cannot read description file \/home\/u\/proj\/missing\.md: .*; unknown field "nope"; "type" belongs in the template's type\/project\/description, not in fields; type "Story" is not available in PROJ$/
      ),
    });
    const unverified = await doctor({
      env: BOTH_PRODUCTS_ENV,
      routes: HAPPY_ROUTES,
      files: {
        '/home/u/proj/.lassi.json': JSON.stringify({
          jira: { defaultProject: 'PROJ', templates: { bug: { type: 'Bug' } } },
        }),
      },
    });
    expect(unverified.rows.find((r) => r.name === 'template bug')).toMatchObject({
      status: 'WARN',
      detail: 'type "Bug" not verified (createmeta failed)',
    });

    // With Jira unconfigured the type was not checked, so the row claims nothing either way: SKIP,
    // not the WARN that made a Confluence-only setup noisy, and not a PASS the run cannot support.
    const unconfigured = await doctor({
      env: {
        LASSI_CONFLUENCE_URL: 'https://confluence.example.internal',
        LASSI_CONFLUENCE_TOKEN: 'x',
      },
      routes: HAPPY_ROUTES,
      files: {
        '/home/u/proj/.lassi.json': JSON.stringify({
          jira: { defaultProject: 'PROJ', templates: { bug: { type: 'Bug' } } },
        }),
      },
    });
    expect(unconfigured.rows.find((r) => r.name === 'template bug')).toMatchObject({
      status: 'SKIP',
      detail: expect.stringContaining('not verified (Jira is not configured)'),
    });

    // Unreachable is a SKIP like every sibling check, with the FAIL on the connectivity row, and
    // the detail still says which of the two causes it was; `client` is undefined for both.
    const down = await doctor({
      env: BOTH_PRODUCTS_ENV,
      routes: [
        {
          path: '/status',
          handler: () => {
            throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
          },
        },
      ],
      files: {
        '/home/u/proj/.lassi.json': JSON.stringify({
          jira: { defaultProject: 'PROJ', templates: { bug: { type: 'Bug' } } },
        }),
      },
    });
    expect(down.rows.find((r) => r.name === 'template bug')).toMatchObject({
      status: 'SKIP',
      detail: expect.stringContaining('not verified (unreachable (see connectivity))'),
    });

    // Configured but with credentials that never resolved: no createmeta was attempted, so the row
    // must not blame one. `productState` reports configured: true with no client for this.
    const noToken = await doctor({
      env: { LASSI_JIRA_URL: 'https://jira.example.internal' },
      routes: HAPPY_ROUTES,
      files: {
        '/home/u/proj/.lassi.json': JSON.stringify({
          jira: { defaultProject: 'PROJ', templates: { bug: { type: 'Bug' } } },
        }),
      },
    });
    expect(noToken.rows.find((r) => r.name === 'template bug')).toMatchObject({
      status: 'SKIP',
      detail: expect.stringContaining('credentials could not be resolved'),
    });

    // A type with nowhere to look it up is uncheckable too, and no request goes out for it.
    const noProject = await doctor({
      env: BOTH_PRODUCTS_ENV,
      routes: HAPPY_ROUTES,
      files: {
        '/home/u/proj/.lassi.json': JSON.stringify({
          jira: { templates: { bug: { type: 'Bug' } } },
        }),
      },
    });
    expect(noProject.rows.find((r) => r.name === 'template bug')).toMatchObject({
      status: 'SKIP',
      detail: expect.stringContaining('not verified (no project'),
    });
  });

  it('skips the createmeta probe without a default project', async () => {
    const { rows } = await doctor({ env: BOTH_PRODUCTS_ENV, routes: HAPPY_ROUTES });
    expect(rows.find((r) => r.name === 'Jira createmeta')).toMatchObject({ status: 'SKIP' });
  });
});
