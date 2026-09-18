import type { Route } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import { BOTH_PRODUCTS_ENV, lastJsonLine, makeTestProgram } from '../../test/program.js';

const ISSUES = [
  {
    id: '1',
    key: 'PROJ-1',
    fields: {
      summary: 'Login page throws 500 on empty password',
      description: 'h2. Steps\n# open the login page\n# submit an empty password',
      issuetype: { name: 'Bug' },
      status: { name: 'Open' },
      priority: { name: 'High' },
      assignee: { name: 'jsmith' },
      labels: ['auth'],
      created: '2026-08-30T09:12:44.000+0300',
      updated: '2026-09-03T14:02:10.000+0300',
      customfield_10005: 3,
      comment: { comments: [], total: 0, startAt: 0, maxResults: 0 },
      attachment: [],
      issuelinks: [],
    },
  },
  {
    id: '2',
    key: 'PROJ-2',
    fields: {
      summary: 'Payment retries double-charge the card',
      description: 'The payment service retries a timed-out charge.',
      issuetype: { name: 'Bug' },
      status: { name: 'In Progress' },
      priority: { name: 'High' },
      assignee: null,
      labels: [],
      created: '2026-08-30T09:12:44.000+0300',
      updated: '2026-09-04T08:00:00.000+0300',
      comment: { comments: [], total: 0, startAt: 0, maxResults: 0 },
      attachment: [],
      issuelinks: [],
    },
  },
];

const PAGE = {
  id: '123456',
  type: 'page',
  title: 'Payment service runbook',
  space: { key: 'DEV' },
  version: { number: 12, when: '2026-09-01T12:00:00.000+0300', by: { username: 'jdoe' } },
  ancestors: [{ id: '100' }],
  body: { storage: { value: '<h2>Restart</h2><p>Restart the payment service.</p>' } },
  history: { lastUpdated: { when: '2026-09-01T12:00:00.000+0300', by: { username: 'jdoe' } } },
  children: {
    page: { results: [], size: 0, limit: 25 },
    comment: { results: [], size: 0, limit: 25 },
    attachment: { results: [], size: 0, limit: 25 },
  },
};

const count = (text: string, word: string): number => text.toLowerCase().split(word).length - 1;

/** Deterministic 4-dim "embeddings": keyword counts plus a constant, zero for "nothing". */
function vectorFor(text: string): number[] {
  return [
    count(text, 'login'),
    count(text, 'payment'),
    count(text, 'runbook'),
    text.includes('nothing') ? 0 : 1,
  ];
}

function routes(): { list: Route[]; embeddingCalls: string[][] } {
  const embeddingCalls: string[][] = [];
  const list: Route[] = [
    {
      method: 'POST',
      path: '/rest/api/2/search',
      handler: (call) => {
        const body = JSON.parse(call.bodyText ?? '{}') as { startAt: number; maxResults: number };
        return {
          json: {
            startAt: body.startAt,
            maxResults: body.maxResults,
            total: ISSUES.length,
            issues: ISSUES.slice(body.startAt, body.startAt + body.maxResults),
            names: { customfield_10005: 'Story Points' },
            schema: { customfield_10005: { type: 'number' } },
          },
        };
      },
    },
    {
      path: '/rest/api/content/search',
      json: {
        results: [{ id: '123456', type: 'page', title: PAGE.title, version: { number: 12 } }],
        start: 0,
        limit: 50,
        size: 1,
      },
    },
    { path: '/rest/api/content/123456', json: PAGE },
    { path: '/rest/api/content/123456/child/attachment', json: { results: [], size: 0 } },
    {
      method: 'POST',
      path: '/v1/embeddings',
      handler: (call) => {
        const { input } = JSON.parse(call.bodyText ?? '{}') as { input: string[] };
        embeddingCalls.push(input);
        return {
          json: { data: input.map((text, index) => ({ index, embedding: vectorFor(text) })) },
        };
      },
    },
  ];
  return { list, embeddingCalls };
}

const ENV = {
  ...BOTH_PRODUCTS_ENV,
  LASSI_EMBEDDINGS_URL: 'https://embeddings.example.internal/v1',
  LASSI_EMBEDDINGS_API_KEY: 'sk-test-key',
};
const HOME_CONFIG = {
  '/home/u/.lassi.json': JSON.stringify({ embeddings: { model: 'text-embedding-3-small' } }),
};

function program(
  list: Route[],
  extra: { env?: Record<string, string>; files?: Record<string, string> } = {}
) {
  return makeTestProgram({
    env: extra.env ?? ENV,
    routes: list,
    files: extra.files ?? HOME_CONFIG,
  });
}

/** Runs several argv on one in-memory workspace so exports, indexes and queries build on each other. */
async function session(
  list: Route[],
  runs: string[][],
  extra?: { env?: Record<string, string>; files?: Record<string, string> }
) {
  const t = program(list, extra);
  const results: Array<{ code: number; stdout: string; stderr: string }> = [];
  let seenOut = 0;
  let seenErr = 0;
  for (const argv of runs) {
    const code = await t.run(argv);
    results.push({ code, stdout: t.stdout().slice(seenOut), stderr: t.stderr().slice(seenErr) });
    seenOut = t.stdout().length;
    seenErr = t.stderr().length;
  }
  return { t, results };
}

describe('lassi jira issue export', () => {
  it('writes every issue as a working file with cache and manifest, skipping unchanged ones next time', async () => {
    const { list } = routes();
    const { t, results } = await session(list, [
      ['jira', 'issue', 'export', 'project = PROJ', '--out-dir', 'exp/jira'],
      ['jira', 'issue', 'export', 'project = PROJ', '--out-dir', 'exp/jira'],
    ]);
    expect(results[0]?.code).toBe(0);
    expect(results[0]?.stdout).toBe('exported 2 issues to exp/jira (0 unchanged, 2 written)\n');
    const file = await t.fs.readFile('/home/u/proj/exp/jira/PROJ-1.md');
    expect(file).toContain('key: PROJ-1\n');
    expect(file).toContain('customfield_10005: 3 # Story Points\n');
    expect(file).toContain('\n## Steps\n\n1. open the login page\n2. submit an empty password\n');
    expect(await t.fs.exists('/home/u/proj/exp/jira/PROJ-2.md')).toBe(true);
    expect(await t.fs.exists('/home/u/proj/.lassi/cache/jira/PROJ-1.json')).toBe(true);
    const manifest = JSON.parse(await t.fs.readFile('/home/u/proj/exp/jira/manifest.json')) as {
      product: string;
      query: string;
      items: Record<string, { marker: string; path: string }>;
    };
    expect(manifest).toMatchObject({ product: 'jira', query: 'project = PROJ' });
    expect(manifest.items['PROJ-2']).toMatchObject({
      marker: '2026-09-04T08:00:00.000+0300',
      path: '/home/u/proj/exp/jira/PROJ-2.md',
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const body = JSON.parse(t.fetch.calls[0]?.bodyText ?? '{}') as Record<string, unknown>;
    expect(body).toMatchObject({ fields: ['*all'], expand: ['names', 'schema'], maxResults: 100 });
    expect(results[1]?.stdout).toBe('exported 2 issues to exp/jira (2 unchanged, 0 written)\n');
  });

  it('honours --limit, reports truncation and defaults to ~/.lassi/export/jira', async () => {
    const { list } = routes();
    const t = program(list);
    expect(
      await t.run(['jira', 'issue', 'export', 'project = PROJ', '--limit', '1', '--json'])
    ).toBe(0);
    expect(JSON.parse(t.stdout())).toMatchObject({
      dir: '/home/u/.lassi/export/jira',
      total: 1,
      written: 1,
      truncated: true,
      files: ['../.lassi/export/jira/PROJ-1.md'],
    });
    expect(t.stderr()).toContain('stopped at 1 issues; raise --limit');
  });
});

describe('a damaged export manifest', () => {
  it('stops rather than rewriting every working file', async () => {
    const { list } = routes();
    const t = program(list);
    expect(await t.run(['jira', 'issue', 'export', 'project = PROJ', '--out-dir', 'exp'])).toBe(0);
    const edited = `${await t.fs.readFile('/home/u/proj/exp/PROJ-1.md')}\n\nMy local note.\n`;
    await t.fs.writeFile('/home/u/proj/exp/PROJ-1.md', edited);
    await t.fs.writeFile('/home/u/proj/exp/manifest.json', '{"schema": 1, "items":');
    // Report the damaged manifest itself, keeping the evidence needed to repair its baselines.
    expect(await t.run(['jira', 'issue', 'export', 'project = PROJ', '--out-dir', 'exp'])).toBe(2);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'usage',
      message: expect.stringContaining('is not valid JSON'),
      hint: expect.stringContaining('restore the manifest'),
    });
    expect(await t.fs.readFile('/home/u/proj/exp/PROJ-1.md')).toBe(edited);

    // Damage that stays valid JSON still needs the same repair path.
    // A matching schema number cannot make malformed item baselines usable.
    for (const body of [
      '{"schema": 2, "items": {}}',
      '{"schema": 1, "product": "jira", "query": "q", "exportedAt": "t", "items": "damaged"}',
      '{"schema": 1, "product": "jira", "query": "q", "exportedAt": "t", "items": []}',
      '{"schema": 1, "product": "jira", "query": "q", "exportedAt": "t", "items": {"PROJ-1": {}}}',
      '{"schema": 1, "items": {}}',
    ]) {
      await t.fs.writeFile('/home/u/proj/exp/manifest.json', body);
      expect(await t.run(['jira', 'issue', 'export', 'project = PROJ', '--out-dir', 'exp'])).toBe(
        2
      );
      expect(lastJsonLine(t.stderr())).toMatchObject({
        code: 'usage',
        message: expect.stringContaining('not a schema-1 export manifest'),
      });
      expect(await t.fs.readFile('/home/u/proj/exp/PROJ-1.md')).toBe(edited);
    }
  });
});

describe('CQL built from --space', () => {
  it('escapes a backslash in the space key, so the literal still closes', async () => {
    const { list } = routes();
    const t = program(list);
    await t.run(['confluence', 'page', 'export', '--space', 'DEV\\', '--out-dir', 'exp/conf']);
    const search = t.fetch.calls.find((c) => c.url.pathname === '/rest/api/content/search');
    const cql = search?.url.searchParams.get('cql');
    expect(cql).toBe('space = "DEV\\\\" and type = page order by lastmodified desc');
  });
});

describe('identifiers that came back from the server', () => {
  it('refuses a Jira key that would name a file outside the export directory', async () => {
    const hostile: Route[] = [
      {
        method: 'POST',
        path: '/rest/api/2/search',
        json: {
          startAt: 0,
          maxResults: 100,
          total: 1,
          issues: [{ ...ISSUES[0], key: '../../../../home/u/.bashrc' }],
        },
      },
    ];
    const t = program(hostile);
    expect(
      await t.run(['jira', 'issue', 'export', 'project = PROJ', '--out-dir', 'exp/jira'])
    ).toBe(5);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'validation',
      message: '1 items could not be exported',
    });
    expect(t.stderr()).toContain('an issue key that is not one');
    const written = [...t.fs.files.keys(), ...t.fs.bytes.keys()];
    expect(written.some((path) => path.includes('.bashrc'))).toBe(false);
  });

  it('refuses a Confluence content id that would escape the export and cache directories', async () => {
    const hostile: Route[] = [
      {
        path: '/rest/api/content/search',
        json: {
          results: [{ id: '../../../../home/u/.bashrc', type: 'page', title: 'x' }],
          start: 0,
          limit: 50,
          size: 1,
        },
      },
    ];
    const t = program(hostile);
    expect(
      await t.run(['confluence', 'page', 'export', '--space', 'DEV', '--out-dir', 'exp/conf'])
    ).toBe(5);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'validation',
      message: '1 items could not be exported',
    });
    expect(t.stderr()).toContain('a content id that is not one');
    const written = [...t.fs.files.keys(), ...t.fs.bytes.keys()];
    expect(written.some((path) => path.includes('.bashrc'))).toBe(false);
  });

  it('refuses a hostile key on the single-issue path, where the cache is named after it', async () => {
    const hostile: Route[] = [
      {
        path: '/rest/api/2/issue/PROJ-1',
        json: { ...ISSUES[0], key: '../../../../home/u/.bashrc' },
      },
    ];
    const t = program(hostile);
    expect(await t.run(['jira', 'issue', 'get', 'PROJ-1', '--out', 'work.md'])).toBe(1);
    expect(lastJsonLine(t.stderr())).toMatchObject({ code: 'internal' });
    const written = [...t.fs.files.keys(), ...t.fs.bytes.keys()];
    expect(written.some((path) => path.includes('.bashrc'))).toBe(false);
  });
});

describe('lassi confluence page export', () => {
  it('writes pages from a space with storage cache and manifest, skipping unchanged versions', async () => {
    const { list } = routes();
    const { t, results } = await session(list, [
      ['confluence', 'page', 'export', '--space', 'DEV', '--out-dir', 'exp/conf'],
      ['confluence', 'page', 'export', '--space', 'DEV', '--out-dir', 'exp/conf'],
    ]);
    expect(results[0]?.code).toBe(0);
    expect(results[0]?.stdout).toBe('exported 1 pages to exp/conf (0 unchanged, 1 written)\n');
    expect(await t.fs.readFile('/home/u/proj/exp/conf/123456.md')).toContain(
      'title: Payment service runbook\n'
    );
    expect(await t.fs.exists('/home/u/proj/.lassi/cache/confluence/123456.v12.xml')).toBe(true);
    expect(t.fetch.calls[0]?.url.searchParams.get('cql')).toBe(
      'space = "DEV" and type = page order by lastmodified desc'
    );
    expect(results[1]?.stdout).toBe('exported 1 pages to exp/conf (1 unchanged, 0 written)\n');
    const both = program(list);
    expect(await both.run(['confluence', 'page', 'export', 'type = page', '--space', 'DEV'])).toBe(
      2
    );
  });
});

describe('lassi search', () => {
  it('refuses to index nothing, previews under --dry-run, and blocks under read-only', async () => {
    const { list, embeddingCalls } = routes();
    const nothing = program(list);
    expect(await nothing.run(['search', 'index'])).toBe(2);
    expect(lastJsonLine(nothing.stderr())).toMatchObject({
      code: 'usage',
      hint: expect.stringContaining('lassi jira issue export'),
    });
    const { results, t } = await session(list, [
      ['jira', 'issue', 'export', 'project = PROJ'],
      ['search', 'index', '--dry-run'],
    ]);
    expect(results[1]?.code).toBe(0);
    expect(results[1]?.stdout).toContain('DRY RUN — nothing sent');
    expect(results[1]?.stdout).toContain('POST https://embeddings.example.internal/v1/embeddings');
    expect(results[1]?.stdout).toContain('2 documents from ../.lassi/export/jira');
    expect(results[1]?.stdout).toContain('2 to embed (');
    expect(results[1]?.stdout).toContain('nothing leaves this machine under --dry-run');
    expect(embeddingCalls).toHaveLength(0);
    expect(await t.fs.exists('/home/u/.lassi/index/default/manifest.json')).toBe(false);

    const ro = program(list, { env: { ...ENV, LASSI_READ_ONLY: '1' } });
    expect(await ro.run(['search', 'index', 'exp'])).toBe(7);
    expect(ro.fetch.calls).toHaveLength(0);

    const unconfigured = program(list, { env: BOTH_PRODUCTS_ENV, files: {} });
    await unconfigured.run(['jira', 'issue', 'export', 'project = PROJ']);
    expect(await unconfigured.run(['search', 'index'])).toBe(2);
    expect(lastJsonLine(unconfigured.stderr())).toMatchObject({
      code: 'usage',
      message: expect.stringContaining('embeddings are not configured'),
    });
  });

  it('indexes exports incrementally, answers queries by meaning and shows the index', async () => {
    const { list, embeddingCalls } = routes();
    const { t, results } = await session(list, [
      ['jira', 'issue', 'export', 'project = PROJ'],
      ['confluence', 'page', 'export', '--space', 'DEV'],
      ['search', 'index'],
      ['search', 'index'],
      ['search', 'query', 'login fails with an empty password'],
      ['search', 'query', 'payment', '--product', 'confluence', '--json'],
      ['search', 'query', 'nothing at all', '--axi'],
      ['search', 'show'],
    ]);
    expect(results[2]?.code).toBe(0);
    expect(results[2]?.stdout).toMatch(
      /^indexed 3 documents \(3 embedded, 0 reused, 0 dropped; \d+ chunks\) into \/home\/u\/\.lassi\/index\/default\n$/
    );
    for (const name of ['manifest.json', 'chunks.jsonl', 'vectors.f32']) {
      expect(await t.fs.exists(`/home/u/.lassi/index/default/${name}`)).toBe(true);
    }
    const embedRequests = t.fetch.calls.filter((c) => c.url.pathname === '/v1/embeddings');
    expect(embedRequests.length).toBeGreaterThan(0);
    expect(embedRequests[0]?.headers['authorization']).toBe('Bearer sk-test-key');
    expect(JSON.parse(embedRequests[0]?.bodyText ?? '{}')).toMatchObject({
      model: 'text-embedding-3-small',
    });
    const afterFirst = embeddingCalls.length;

    expect(results[3]?.stdout).toMatch(/^indexed 3 documents \(0 embedded, 3 reused, 0 dropped/);
    expect(embeddingCalls).toHaveLength(afterFirst);

    expect(results[4]?.code).toBe(0);
    expect(results[4]?.stdout).toContain('| Score | Source | Title | Where | Path | Snippet |');
    const firstRow = results[4]?.stdout.split('\n')[2] ?? '';
    expect(firstRow).toContain('| jira PROJ-1 | Login page throws 500 on empty password |');
    expect(firstRow).toContain('.lassi/export/jira/PROJ-1.md');

    const json = JSON.parse(results[5]?.stdout ?? '{}') as {
      hits: Array<{ product: string; ref: string }>;
    };
    expect(json.hits.map((h) => `${h.product} ${h.ref}`)).toEqual(['confluence 123456']);

    expect(results[6]?.stdout).toContain('shown: 0\n');
    expect(results[6]?.stdout).toContain('no matches scoring at least 0.33');

    expect(results[7]?.stdout).toContain('# index default\n');
    expect(results[7]?.stdout).toContain('- documents: 3 (confluence: 1, jira: 2)');
    expect(results[7]?.stdout).toContain('- model: text-embedding-3-small (4 dimensions)');
  });

  it('authenticates with an Entra ID token when embeddings.auth is azure-ad', async () => {
    const { list } = routes();
    const env = {
      ...BOTH_PRODUCTS_ENV,
      LASSI_EMBEDDINGS_URL: 'https://embeddings.example.internal/v1',
    };
    const files = {
      '/home/u/.lassi.json': JSON.stringify({
        embeddings: { model: 'text-embedding-3-small', auth: 'azure-ad' },
      }),
    };
    const scopes: string[] = [];
    const timeouts: number[] = [];
    const t = makeTestProgram({
      env,
      routes: list,
      files,
      azureToken: async (scope, opts) => {
        scopes.push(scope);
        timeouts.push(opts.timeoutMs);
        return 'eyJ-fake-entra-token';
      },
    });
    await t.run(['jira', 'issue', 'export', 'project = PROJ']);
    expect(await t.run(['search', 'index'])).toBe(0);
    const embed = t.fetch.calls.find((c) => c.url.pathname === '/v1/embeddings');
    expect(embed?.headers['authorization']).toBe('Bearer eyJ-fake-entra-token');
    expect(embed?.headers['api-key']).toBeUndefined();
    expect(scopes[0]).toBe('https://cognitiveservices.azure.com/.default');
    expect(timeouts[0]).toBe(30_000);
  });

  it('redacts an Entra token the endpoint echoes back and hints at tenant, scope and role on 401', async () => {
    const { list } = routes();
    const env = {
      ...BOTH_PRODUCTS_ENV,
      LASSI_EMBEDDINGS_URL: 'https://embeddings.example.internal/v1',
    };
    const files = {
      '/home/u/.lassi.json': JSON.stringify({
        embeddings: { model: 'text-embedding-3-small', auth: 'azure-ad' },
      }),
    };
    const echoing = makeTestProgram({
      env,
      routes: [
        ...list.filter((r) => r.path !== '/v1/embeddings'),
        {
          method: 'POST',
          path: '/v1/embeddings',
          handler: (call) => ({
            status: 401,
            json: {
              error: { message: `token ${call.headers['authorization']} refused for tenant` },
            },
          }),
        },
      ],
      files,
      azureToken: async () => 'eyJ-fake-entra-token',
    });
    await echoing.run(['jira', 'issue', 'export', 'project = PROJ']);
    expect(await echoing.run(['search', 'index'])).toBe(3);
    expect(echoing.stderr()).not.toContain('eyJ-fake-entra-token');
    expect(echoing.stderr()).toContain('Bearer ***');
    expect(lastJsonLine(echoing.stderr())).toMatchObject({
      code: 'auth',
      http: 401,
      hint: expect.stringContaining('az login --tenant'),
    });
  });

  it('turns a multi-line credential failure into one human line plus errorMessages', async () => {
    const { list } = routes();
    const failing = makeTestProgram({
      env: { ...BOTH_PRODUCTS_ENV, LASSI_EMBEDDINGS_URL: 'https://embeddings.example.internal/v1' },
      routes: list,
      files: {
        '/home/u/.lassi.json': JSON.stringify({
          embeddings: { model: 'text-embedding-3-small', auth: 'azure-ad' },
        }),
      },
      azureToken: async () => {
        throw new Error(
          'ChainedTokenCredential authentication failed.\nCredentialUnavailableError: IMDS unavailable\nCredentialUnavailableError: Please run az login'
        );
      },
    });
    await failing.run(['jira', 'issue', 'export', 'project = PROJ']);
    const before = failing.stderr().length;
    expect(await failing.run(['search', 'index'])).toBe(3);
    const stderr = failing.stderr().slice(before);
    expect(stderr.split('\n').filter((l) => l.length > 0)).toHaveLength(2);
    expect(
      stderr.startsWith(
        'error: Azure credential failed for https://cognitiveservices.azure.com/.default: ChainedTokenCredential authentication failed.\n'
      )
    ).toBe(true);
    expect(lastJsonLine(stderr)).toMatchObject({
      code: 'auth',
      errorMessages: [
        'CredentialUnavailableError: IMDS unavailable',
        'CredentialUnavailableError: Please run az login',
      ],
      hint: expect.stringContaining('az login'),
    });
    expect(failing.fetch.calls.some((c) => c.url.pathname === '/v1/embeddings')).toBe(false);
  });

  it('honours a configured embeddings.minScore in both directions', async () => {
    // The shared fake endpoint scores everything far above the default, so this one answers with
    // vectors chosen to sit at exactly 0.25: below the 0.33 default, above a configured 0.20.
    const quarter: Route = {
      method: 'POST',
      path: '/v1/embeddings',
      handler: (call) => {
        const { input } = JSON.parse(call.bodyText ?? '{}') as { input: string[] };
        return {
          json: {
            data: input.map((text, index) => ({
              index,
              embedding: text === 'ZZQUERY' ? [1, 0] : [0.25, Math.sqrt(1 - 0.0625)],
            })),
          },
        };
      },
    };
    const withFloor = async (minScore: number) => {
      const { list } = routes();
      const t = program([...list.filter((r) => r.path !== '/v1/embeddings'), quarter], {
        files: {
          '/home/u/.lassi.json': JSON.stringify({
            embeddings: { model: 'text-embedding-3-small', minScore },
          }),
        },
      });
      await t.run(['jira', 'issue', 'export', 'project = PROJ']);
      await t.run(['search', 'index']);
      const mark = t.stdout().length;
      expect(await t.run(['search', 'query', 'ZZQUERY'])).toBe(0);
      return t.stdout().slice(mark);
    };
    // The default would drop a 0.25 hit; a lower floor must admit it, or the setting does nothing.
    expect(await withFloor(0.33)).toContain('no matches scoring at least 0.33');
    const admitted = await withFloor(0.2);
    expect(admitted).toContain('| Score | Source |');
    expect(admitted).toContain('| 0.25 | jira PROJ-1 |');
  });

  it('never calls a zero similarity a match, even with the floor turned all the way down', async () => {
    const zero: Route = {
      method: 'POST',
      path: '/v1/embeddings',
      handler: (call) => {
        const { input } = JSON.parse(call.bodyText ?? '{}') as { input: string[] };
        return {
          json: {
            data: input.map((text, index) => ({
              index,
              embedding: text === 'ZZQUERY' ? [0, 0] : [1, 0],
            })),
          },
        };
      },
    };
    const { list } = routes();
    const t = program([...list.filter((r) => r.path !== '/v1/embeddings'), zero], {
      files: {
        '/home/u/.lassi.json': JSON.stringify({
          embeddings: { model: 'text-embedding-3-small', minScore: 0 },
        }),
      },
    });
    await t.run(['jira', 'issue', 'export', 'project = PROJ']);
    await t.run(['search', 'index']);
    const mark = t.stdout().length;
    expect(await t.run(['search', 'query', 'ZZQUERY'])).toBe(0);
    expect(t.stdout().slice(mark)).toContain('no matches scoring at least 0');
  });

  it('carries the floor in machine output, where the prose never appears', async () => {
    const { list } = routes();
    const t = program(list);
    await t.run(['jira', 'issue', 'export', 'project = PROJ']);
    await t.run(['search', 'index']);
    const mark = t.stdout().length;
    expect(await t.run(['search', 'query', 'nothing at all', '--json'])).toBe(0);
    expect(JSON.parse(t.stdout().slice(mark))).toMatchObject({
      index: 'default',
      query: 'nothing at all',
      minScore: 0.33,
      hits: [],
    });
  });

  it('--rebuild embeds everything again, including after a model change', async () => {
    const { list, embeddingCalls } = routes();
    const cfg = (model: string) => ({
      '/home/u/.lassi.json': JSON.stringify({ embeddings: { model } }),
    });
    const t = program(list, { files: cfg('text-embedding-3-small') });
    await t.run(['jira', 'issue', 'export', 'project = PROJ']);
    await t.run(['search', 'index']);
    const afterFirst = embeddingCalls.length;

    // Without the flag an unchanged corpus embeds nothing.
    let mark = t.stdout().length;
    await t.run(['search', 'index']);
    expect(t.stdout().slice(mark)).toContain('0 embedded, 2 reused');
    expect(embeddingCalls).toHaveLength(afterFirst);

    // With it, everything goes again even though nothing changed.
    mark = t.stdout().length;
    expect(await t.run(['search', 'index', '--rebuild'])).toBe(0);
    expect(t.stdout().slice(mark)).toMatch(/2 embedded, 0 reused, 0 dropped/);
    expect(embeddingCalls.length).toBeGreaterThan(afterFirst);

    // A model change is refused without the flag and is exactly what the flag is for.
    const other = program(list, { files: cfg('text-embedding-3-small') });
    await other.run(['jira', 'issue', 'export', 'project = PROJ']);
    await other.run(['search', 'index']);
    mark = other.stdout().length;
    await other.fs.writeFile(
      '/home/u/.lassi/index/default/manifest.json',
      (await other.fs.readFile('/home/u/.lassi/index/default/manifest.json')).replace(
        'text-embedding-3-small',
        'text-embedding-3-large'
      )
    );
    expect(await other.run(['search', 'index'])).toBe(5);
    expect(lastJsonLine(other.stderr())).toMatchObject({
      code: 'validation',
      hint: expect.stringContaining('--rebuild'),
    });
    expect(await other.run(['search', 'index', '--rebuild'])).toBe(0);
    expect(other.stdout().slice(mark)).toMatch(/2 embedded/);
    const manifest = JSON.parse(
      await other.fs.readFile('/home/u/.lassi/index/default/manifest.json')
    ) as { model: string };
    expect(manifest.model).toBe('text-embedding-3-small');
    expect(await other.run(['search', 'query', 'login'])).toBe(0);
  });

  it('--rebuild repairs an index that can no longer be read, and every command says so', async () => {
    const { list } = routes();
    const t = program(list);
    await t.run(['jira', 'issue', 'export', 'project = PROJ']);
    await t.run(['search', 'index']);
    // A truncated chunk file makes the three files disagree: readable manifest, missing rows.
    const chunks = '/home/u/.lassi/index/default/chunks.jsonl';
    const first = (await t.fs.readFile(chunks)).split('\n')[0] as string;
    await t.fs.writeFile(chunks, `${first}\n`);

    for (const argv of [
      ['search', 'query', 'login'],
      ['search', 'show'],
      ['search', 'index'],
    ]) {
      const before = t.stderr().length;
      expect(await t.run(argv)).toBe(5);
      expect(lastJsonLine(t.stderr().slice(before))).toMatchObject({
        code: 'validation',
        message: expect.stringContaining('cannot be read'),
        hint: expect.stringContaining('--rebuild'),
      });
    }

    const mark = t.stdout().length;
    expect(await t.run(['search', 'index', '--rebuild'])).toBe(0);
    expect(t.stdout().slice(mark)).toMatch(/2 embedded/);
    expect(await t.run(['search', 'query', 'login'])).toBe(0);
  });

  it('refuses a manifest that outlived the rows it describes, and --rebuild replaces it', async () => {
    const { list } = routes();
    const t = program(list);
    await t.run(['jira', 'issue', 'export', 'project = PROJ']);
    await t.run(['search', 'index']);
    // The manifest is written last: this is the shape a write interrupted just before it leaves
    // behind. Chunks and vectors still agree with each other, so only the manifest reveals it.
    const dir = '/home/u/.lassi/index/default';
    const first = (await t.fs.readFile(`${dir}/chunks.jsonl`)).split('\n')[0] as string;
    await t.fs.writeFile(`${dir}/chunks.jsonl`, `${first}\n`);
    await t.fs.writeBytes(
      `${dir}/vectors.f32`,
      (await t.fs.readBytes(`${dir}/vectors.f32`)).slice(0, 4 * 4)
    );

    for (const argv of [
      ['search', 'query', 'login'],
      ['search', 'index'],
    ]) {
      const before = t.stderr().length;
      expect(await t.run(argv)).toBe(5);
      expect(lastJsonLine(t.stderr().slice(before))).toMatchObject({
        code: 'validation',
        message: expect.stringContaining('inconsistent'),
        hint: expect.stringContaining('--rebuild'),
      });
    }

    expect(await t.run(['search', 'index', '--rebuild'])).toBe(0);
    expect(await t.run(['search', 'query', 'login'])).toBe(0);
  });

  it('leaves an endpoint failure its own hint instead of blaming the index', async () => {
    const { list } = routes();
    const t = program([
      ...list.filter((r) => r.path !== '/v1/embeddings'),
      { method: 'POST', path: '/v1/embeddings', json: { data: [] } },
    ]);
    await t.run(['jira', 'issue', 'export', 'project = PROJ']);
    expect(await t.run(['search', 'index'])).toBe(5);
    const err = lastJsonLine(t.stderr()) as { message: string; hint?: string };
    expect(err.message).toContain('0 vectors');
    expect(err.hint).toContain('embeddings.url');
    expect(err.hint ?? '').not.toContain('--rebuild');
  });

  it('--rebuild says in the dry run that the whole index is replaced', async () => {
    const { list, embeddingCalls } = routes();
    const t = program(list);
    await t.run(['jira', 'issue', 'export', 'project = PROJ']);
    await t.run(['search', 'index']);
    const calls = embeddingCalls.length;
    const mark = t.stdout().length;
    expect(await t.run(['search', 'index', '--rebuild', '--dry-run'])).toBe(0);
    const out = t.stdout().slice(mark);
    expect(out).toContain('DRY RUN — nothing sent');
    expect(out).toContain('rebuilding: every document is embedded again');
    expect(out).toContain('2 to embed');
    expect(embeddingCalls).toHaveLength(calls);
  });

  it('keeps what a rebuild is not meant to change, and reports what it drops', async () => {
    const { list } = routes();
    const t = program(list);
    await t.run(['jira', 'issue', 'export', 'project = PROJ']);
    await t.run(['search', 'index']);
    const path = '/home/u/.lassi/index/default/manifest.json';
    const before = JSON.parse(await t.fs.readFile(path)) as { createdAt: string };

    // A document disappears from the export and the clock moves on.
    await t.fs.unlink('/home/u/.lassi/export/jira/PROJ-2.md');
    t.deps.now = () => new Date('2027-01-01T00:00:00.000Z');
    const mark = t.stdout().length;
    expect(await t.run(['search', 'index', '--rebuild'])).toBe(0);
    expect(t.stdout().slice(mark)).toMatch(/1 embedded, 0 reused, 1 dropped/);
    const after = JSON.parse(await t.fs.readFile(path)) as {
      createdAt: string;
      updatedAt: string;
      docs: Record<string, unknown>;
    };
    // The index keeps its age; only its contents are replaced.
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt).toBe('2027-01-01T00:00:00.000Z');
    expect(Object.keys(after.docs)).toEqual(['/home/u/.lassi/export/jira/PROJ-1.md']);
  });

  it('previews the documents a rebuild would drop', async () => {
    const { list, embeddingCalls } = routes();
    const t = program(list);
    await t.run(['jira', 'issue', 'export', 'project = PROJ']);
    await t.run(['search', 'index']);
    await t.fs.unlink('/home/u/.lassi/export/jira/PROJ-2.md');
    const calls = embeddingCalls.length;
    const mark = t.stdout().length;
    expect(await t.run(['search', 'index', '--rebuild', '--dry-run'])).toBe(0);
    expect(t.stdout().slice(mark)).toContain('1 to embed');
    expect(t.stdout().slice(mark)).toContain('1 to drop');
    expect(embeddingCalls).toHaveLength(calls);
  });

  it('refuses a dimension change and points at the flag naming the right index', async () => {
    const { list } = routes();
    const cfg = (dimensions: number) => ({
      '/home/u/.lassi.json': JSON.stringify({
        embeddings: { model: 'text-embedding-3-small', dimensions },
      }),
    });
    const t = program(list, { files: cfg(4) });
    await t.run(['jira', 'issue', 'export', 'project = PROJ']);
    expect(await t.run(['search', 'index', '--name', 'specs'])).toBe(0);
    // The endpoint's width did not change, only what the configuration asks for. The index and the
    // export come across; the config must not, or the change under test would be copied away.
    const wider = program(list, { files: cfg(8) });
    for (const [k, v] of t.fs.files) if (k !== '/home/u/.lassi.json') wider.fs.files.set(k, v);
    for (const [k, v] of t.fs.bytes) wider.fs.bytes.set(k, v);
    expect(await wider.run(['search', 'index', '--name', 'specs'])).toBe(5);
    expect(lastJsonLine(wider.stderr())).toMatchObject({
      code: 'validation',
      message: expect.stringContaining('4-dimensional'),
      hint: expect.stringContaining('--rebuild --name specs'),
    });
    expect(await wider.run(['search', 'query', 'login', '--index', 'specs'])).toBe(5);
    expect(lastJsonLine(wider.stderr())).toMatchObject({
      hint: expect.stringContaining('--rebuild --name specs'),
    });
  });

  it('names the index when the endpoint width drifts with no dimensions pinned', async () => {
    const { list } = routes();
    const t = program(list);
    await t.run(['jira', 'issue', 'export', 'project = PROJ']);
    expect(await t.run(['search', 'index', '--name', 'specs'])).toBe(0);
    // Nothing is pinned, so the drift is only visible once the endpoint has answered the query:
    // the pre-flight check above cannot see it, and queryIndex is what throws.
    const drifted = list.map((route) =>
      route.path === '/v1/embeddings'
        ? {
            ...route,
            handler: (call: { bodyText?: string }) => {
              const { input } = JSON.parse(call.bodyText ?? '{}') as { input: string[] };
              return {
                json: {
                  data: input.map((_text, index) => ({ index, embedding: [1, 0, 0, 0, 0] })),
                },
              };
            },
          }
        : route
    );
    const wider = program(drifted);
    for (const [k, v] of t.fs.files) wider.fs.files.set(k, v);
    for (const [k, v] of t.fs.bytes) wider.fs.bytes.set(k, v);
    expect(await wider.run(['search', 'query', 'login', '--index', 'specs'])).toBe(5);
    expect(lastJsonLine(wider.stderr())).toMatchObject({
      code: 'validation',
      hint: expect.stringContaining('--rebuild --name specs'),
    });
  });

  it('leaves the existing index untouched when a rebuild fails partway', async () => {
    const { list } = routes();
    const t = program(list);
    await t.run(['jira', 'issue', 'export', 'project = PROJ']);
    await t.run(['search', 'index']);
    const path = '/home/u/.lassi/index/default/manifest.json';
    const before = await t.fs.readFile(path);
    const vectorsBefore = await t.fs.readBytes('/home/u/.lassi/index/default/vectors.f32');

    const broken = program(
      [
        ...list.filter((r) => r.path !== '/v1/embeddings'),
        { method: 'POST', path: '/v1/embeddings', status: 500, text: 'upstream is down' },
      ],
      {}
    );
    for (const [k, v] of t.fs.files) broken.fs.files.set(k, v);
    for (const [k, v] of t.fs.bytes) broken.fs.bytes.set(k, v);
    expect(await broken.run(['search', 'index', '--rebuild'])).not.toBe(0);
    // The invariant that makes --rebuild safe to recommend: a failed one costs nothing.
    expect(await broken.fs.readFile(path)).toBe(before);
    expect(await broken.fs.readBytes('/home/u/.lassi/index/default/vectors.f32')).toEqual(
      vectorsBefore
    );
  });

  it('does not call an unreadable file corruption when the filesystem is at fault', async () => {
    const { list } = routes();
    const t = program(list);
    await t.run(['jira', 'issue', 'export', 'project = PROJ']);
    await t.run(['search', 'index']);
    const real = t.fs.readFile.bind(t.fs);
    t.fs.readFile = async (p: string) => {
      if (p.endsWith('chunks.jsonl'))
        throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), {
          code: 'EACCES',
        });
      return real(p);
    };
    expect(await t.run(['search', 'query', 'login'])).toBe(1);
    const err = lastJsonLine(t.stderr()) as { code: string; hint?: string };
    expect(err.code).toBe('internal');
    expect(err.hint ?? '').not.toContain('--rebuild');
  });

  it('treats a data file that never arrived as damage, not as a filesystem fault', async () => {
    const { list } = routes();
    const t = program(list);
    await t.run(['jira', 'issue', 'export', 'project = PROJ']);
    await t.run(['search', 'index']);
    // The canonical interrupted write: the manifest landed, one of the files it points at did not.
    await t.fs.unlink('/home/u/.lassi/index/default/chunks.jsonl');

    expect(await t.run(['search', 'query', 'login'])).toBe(5);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'validation',
      message: expect.stringContaining('missing chunks.jsonl'),
      hint: expect.stringContaining('--rebuild'),
    });
    expect(await t.run(['search', 'index', '--rebuild'])).toBe(0);
    expect(await t.run(['search', 'query', 'login'])).toBe(0);
  });

  it('refuses to rebuild over an index the filesystem would not hand over', async () => {
    const { list } = routes();
    const t = program(list);
    await t.run(['jira', 'issue', 'export', 'project = PROJ']);
    await t.run(['search', 'index']);
    const manifest = '/home/u/.lassi/index/default/manifest.json';
    const before = await t.fs.readFile(manifest);
    const real = t.fs.readFile.bind(t.fs);
    t.fs.readFile = async (p: string) => {
      if (p.endsWith('chunks.jsonl'))
        throw Object.assign(new Error(`EACCES: permission denied, open '${p}'`), {
          code: 'EACCES',
        });
      return real(p);
    };
    // Silently replacing it would destroy an index that is intact behind a temporary permission
    // problem, and would reset what it drops and how old it is.
    expect(await t.run(['search', 'index', '--rebuild'])).toBe(1);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'internal',
      hint: expect.stringContaining('filesystem failure'),
    });
    expect(await t.fs.readFile(manifest)).toBe(before);
  });

  it('rejects an index name that would leave the index directory', async () => {
    const { list } = routes();
    const t = program(list);
    for (const argv of [
      ['search', 'index', '--name', '../escape'],
      ['search', 'query', 'login', '--index', '../escape'],
      ['search', 'show', '--index', 'a;b'],
    ]) {
      expect(await t.run(argv)).toBe(2);
      expect(lastJsonLine(t.stderr())).toMatchObject({
        code: 'usage',
        message: expect.stringMatching(/must be letters, digits/),
      });
    }
  });

  it('refuses a configuration the index cannot take before costing out the write', async () => {
    const { list } = routes();
    const cfg = (model: string) => ({
      '/home/u/.lassi.json': JSON.stringify({ embeddings: { model } }),
    });
    const t = program(list, { files: cfg('text-embedding-3-small') });
    await t.run(['jira', 'issue', 'export', 'project = PROJ']);
    await t.run(['search', 'index']);

    const changed = program(list, { files: cfg('text-embedding-3-large') });
    for (const [k, v] of t.fs.files) if (k !== '/home/u/.lassi.json') changed.fs.files.set(k, v);
    for (const [k, v] of t.fs.bytes) changed.fs.bytes.set(k, v);
    // A dry run that prices a write the command would then refuse is worse than the refusal.
    const mark = changed.stdout().length;
    expect(await changed.run(['search', 'index', '--dry-run'])).toBe(5);
    expect(changed.stdout().slice(mark)).toBe('');
    expect(lastJsonLine(changed.stderr())).toMatchObject({
      code: 'validation',
      message: expect.stringContaining('cannot take this configuration'),
      hint: expect.stringContaining('--rebuild'),
    });
  });

  it('names the flag for a width only the endpoint could reveal', async () => {
    const { list } = routes();
    const t = program(list);
    await t.run(['jira', 'issue', 'export', 'project = PROJ']);
    await t.run(['search', 'index']);
    // Same model name, same configuration (no `dimensions` pinned), wider vectors: nothing can
    // catch this before the endpoint has answered and the embeddings have been paid for.
    const wider = program([
      ...list.filter((r) => r.path !== '/v1/embeddings'),
      {
        method: 'POST',
        path: '/v1/embeddings',
        handler: (call: { bodyText?: string }) => {
          const { input } = JSON.parse(call.bodyText ?? '{}') as { input: string[] };
          return {
            json: {
              data: input.map((text, index) => ({ index, embedding: [...vectorFor(text), 1, 0] })),
            },
          };
        },
      },
    ]);
    for (const [k, v] of t.fs.files) wider.fs.files.set(k, v);
    for (const [k, v] of t.fs.bytes) wider.fs.bytes.set(k, v);
    const path = '/home/u/.lassi/export/jira/PROJ-2.md';
    await wider.fs.writeFile(
      path,
      (await wider.fs.readFile(path)).replace('double-charge', 'triple-charge')
    );
    expect(await wider.run(['search', 'index'])).toBe(5);
    expect(lastJsonLine(wider.stderr())).toMatchObject({
      code: 'validation',
      message: expect.stringContaining('the endpoint now returns 6'),
      hint: expect.stringContaining('--rebuild'),
    });
  });

  it('re-embeds only changed documents and points at export when the index is missing', async () => {
    const { list, embeddingCalls } = routes();
    const t = program(list);
    await t.run(['jira', 'issue', 'export', 'project = PROJ']);
    await t.run(['search', 'index']);
    const before = embeddingCalls.length;
    const path = '/home/u/.lassi/export/jira/PROJ-2.md';
    await t.fs.writeFile(
      path,
      (await t.fs.readFile(path)).replace('double-charge', 'triple-charge')
    );
    await t.fs.unlink('/home/u/.lassi/export/jira/PROJ-1.md');
    const out = t.stdout().length;
    expect(await t.run(['search', 'index'])).toBe(0);
    expect(t.stdout().slice(out)).toMatch(/^indexed 1 documents \(1 embedded, 0 reused, 1 dropped/);
    expect(embeddingCalls.length).toBe(before + 1);
    expect(embeddingCalls[before]?.every((text) => !text.includes('Login'))).toBe(true);

    const missing = program(list);
    expect(await missing.run(['search', 'query', 'x'])).toBe(2);
    expect(lastJsonLine(missing.stderr())).toMatchObject({
      code: 'usage',
      message: 'no index "default" at ../.lassi/index/default',
      hint: expect.stringContaining('lassi search index'),
    });
    expect(await missing.run(['search', 'show', '--index', 'other'])).toBe(2);
  });
});
