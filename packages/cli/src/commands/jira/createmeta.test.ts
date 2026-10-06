import { describe, expect, it } from 'vitest';
import type { Route } from '@wonna/lassi-core/testing';
import { BOTH_PRODUCTS_ENV, lastJsonLine, makeTestProgram } from '../../test/program.js';

const CACHE = '/home/u/proj/.lassi/cache/jira/createmeta/PROJ.json';
const BASE = '/rest/api/2/issue/createmeta/PROJ/issuetypes';
const SUMMARY = { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } };
const TEAM = {
  fieldId: 'customfield_10001',
  name: 'Team',
  required: true,
  schema: { type: 'option' },
  allowedValues: [{ value: 'Platform' }],
};
const BUG = { id: '10001', name: 'Bug', subtask: false };
const TASK = { id: '10002', name: 'Task', subtask: false };
const CREATE = [
  'jira',
  'issue',
  'create',
  '--project',
  'PROJ',
  '--type',
  'Bug',
  '--summary',
  'Example',
  '--field',
  'team=Platform',
];

function program(routes: Route[] = []) {
  return makeTestProgram({
    env: { ...BOTH_PRODUCTS_ENV },
    files: {
      '/home/u/proj/.lassi.json': JSON.stringify({
        jira: { fields: { team: 'customfield_10001' } },
      }),
    },
    routes: [
      ...routes,
      { path: BASE, json: { values: [BUG, TASK], total: 2 } },
      { path: `${BASE}/10001`, json: { values: [SUMMARY, TEAM], total: 2 } },
      { path: `${BASE}/10002`, json: { values: [SUMMARY], total: 1 } },
      { method: 'POST', path: '/rest/api/2/issue', json: { id: '1', key: 'PROJ-1' } },
    ],
  });
}

const metadataCalls = (t: ReturnType<typeof program>) =>
  t.fetch.calls.filter((call) => call.url.pathname.includes('/createmeta'));
const writes = (t: ReturnType<typeof program>) =>
  t.fetch.calls.filter((call) => call.method !== 'GET');

interface CacheFixture {
  schema: number;
  baseUrl: string;
  project: { key: string };
  issueTypes: Array<{ fetchedAt: string; type: { id: string; name: string; fields: unknown } }>;
}

describe('persistent create metadata', () => {
  it('fetches on the first create and reuses fields across separate CLI invocations by name or id', async () => {
    const t = program();
    expect(await t.run(CREATE)).toBe(0);
    expect(await t.run(CREATE)).toBe(0);
    expect(await t.run(CREATE.map((arg) => (arg === 'Bug' ? 'bUg' : arg)))).toBe(0);
    expect(await t.run(CREATE.map((arg) => (arg === 'Bug' ? '10001' : arg)))).toBe(0);
    expect(metadataCalls(t)).toHaveLength(2);
    expect(writes(t)).toHaveLength(4);
    expect(JSON.parse(writes(t)[3]!.bodyText!).fields.customfield_10001).toEqual({
      value: 'Platform',
    });
    expect(t.stderr()).toContain('fetching create metadata for PROJ (Bug)');
  });

  it('explicit inspection warms every type and is allowed in read-only mode', async () => {
    const t = program();
    t.deps.env['LASSI_READ_ONLY'] = '1';
    expect(await t.run(['jira', 'issue', 'createmeta', 'PROJ', '--json'])).toBe(0);
    expect(JSON.parse(t.stdout()).issueTypes).toHaveLength(2);
    expect(await t.run([...CREATE, '--dry-run'])).toBe(0);
    expect(
      await t.run([
        'jira',
        'issue',
        'create',
        '--project',
        'PROJ',
        '--type',
        '10002',
        '--summary',
        'Task',
        '--dry-run',
      ])
    ).toBe(0);
    expect(metadataCalls(t)).toHaveLength(3);
    expect(writes(t)).toHaveLength(0);
    expect(await t.fs.exists('/home/u/proj/.lassi/cache/jira/createmeta/.lassi-write.lock')).toBe(
      false
    );
  });

  it('dry-run creation warms the cache without creating an issue', async () => {
    const t = program();
    expect(await t.run([...CREATE, '--dry-run'])).toBe(0);
    expect(writes(t)).toHaveLength(0);
    expect(await t.run(CREATE)).toBe(0);
    expect(metadataCalls(t)).toHaveLength(2);
    expect(writes(t)).toHaveLength(1);
  });

  it('forces a live refresh and uses the new allowed values on the next create', async () => {
    let allowed = 'Platform';
    const t = program([
      {
        path: `${BASE}/10001`,
        handler: () => ({
          json: {
            values: [SUMMARY, { ...TEAM, allowedValues: [{ value: allowed }] }],
            total: 2,
          },
        }),
      },
    ]);
    const refresh = ['jira', 'issue', 'createmeta', 'PROJ', '--type', 'Bug'];
    expect(await t.run(refresh)).toBe(0);
    allowed = 'Web';
    expect(await t.run(refresh)).toBe(0);
    expect(await t.run(CREATE)).toBe(5);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      hint: expect.stringContaining(
        'The create metadata was cached at 2026-09-04T10:00:00.000Z; run `lassi jira issue createmeta PROJ --type Bug` to refresh'
      ),
    });
    expect(await t.run(CREATE.map((arg) => (arg === 'team=Platform' ? 'team=Web' : arg)))).toBe(0);
    expect(metadataCalls(t)).toHaveLength(4);
    expect(writes(t)).toHaveLength(1);
  });

  it('reports cached required fields without a network request', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'createmeta', 'PROJ', '--type', 'Bug'])).toBe(0);
    expect(await t.run(CREATE.slice(0, -2))).toBe(5);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      message: 'missing required field: team',
      hint: expect.stringContaining('refresh required fields and allowed values'),
    });
    expect(metadataCalls(t)).toHaveLength(2);
    expect(writes(t)).toHaveLength(0);
  });

  it.each<[string, (cache: CacheFixture) => void]>([
    [
      'expired',
      (cache) => {
        cache.issueTypes[0]!.fetchedAt = '2026-09-03T10:00:00.000Z';
      },
    ],
    [
      'future timestamp',
      (cache) => {
        cache.issueTypes[0]!.fetchedAt = '2026-09-05T10:00:00.000Z';
      },
    ],
    [
      'invalid timestamp',
      (cache) => {
        cache.issueTypes[0]!.fetchedAt = 'invalid';
      },
    ],
    [
      'another server',
      (cache) => {
        cache.baseUrl = 'https://other.example.internal';
      },
    ],
    [
      'another project',
      (cache) => {
        cache.project.key = 'OTHER';
      },
    ],
    [
      'another type',
      (cache) => {
        cache.issueTypes[0]!.type = { ...cache.issueTypes[0]!.type, id: '10003', name: 'Epic' };
      },
    ],
    [
      'unknown schema',
      (cache) => {
        cache.schema = 2;
      },
    ],
    [
      'invalid fields',
      (cache) => {
        cache.issueTypes[0]!.type.fields = { summary: null };
      },
    ],
    [
      'empty fields',
      (cache) => {
        cache.issueTypes[0]!.type.fields = {};
      },
    ],
  ])('refetches %s metadata', async (_name, damage) => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'createmeta', 'PROJ', '--type', 'Bug'])).toBe(0);
    const cache = JSON.parse(await t.fs.readFile(CACHE));
    damage(cache);
    await t.fs.writeFile(CACHE, JSON.stringify(cache));
    expect(await t.run(CREATE)).toBe(0);
    expect(metadataCalls(t)).toHaveLength(4);
  });

  it('merges type refreshes without extending the lifetime of other types', async () => {
    const t = program();
    expect(await t.run(['jira', 'issue', 'createmeta', 'PROJ'])).toBe(0);
    t.deps.now = () => new Date('2026-09-05T09:00:00.000Z');
    expect(await t.run(['jira', 'issue', 'createmeta', 'PROJ', '--type', 'Task'])).toBe(0);
    t.deps.now = () => new Date('2026-09-05T10:00:00.000Z');
    expect(await t.run(CREATE.map((arg) => (arg === 'Bug' ? 'Task' : arg)).slice(0, -2))).toBe(0);
    expect(metadataCalls(t)).toHaveLength(5);
    expect(await t.run(CREATE)).toBe(0);
    expect(metadataCalls(t)).toHaveLength(7);
    const cache = JSON.parse(await t.fs.readFile(CACHE));
    expect(cache.issueTypes).toHaveLength(2);
  });

  it('a full refresh removes types no longer returned by Jira', async () => {
    let types = [BUG, TASK];
    const t = program([
      { path: BASE, handler: () => ({ json: { values: types, total: types.length } }) },
    ]);
    expect(await t.run(['jira', 'issue', 'createmeta', 'PROJ'])).toBe(0);
    types = [TASK];
    expect(await t.run(['jira', 'issue', 'createmeta', 'PROJ'])).toBe(0);
    expect(await t.run(CREATE)).toBe(5);
    expect(writes(t)).toHaveLength(0);
  });

  it('does not use a removed type name after refreshing the type by id', async () => {
    let type = BUG;
    const t = program([{ path: BASE, handler: () => ({ json: { values: [type], total: 1 } }) }]);
    expect(await t.run(['jira', 'issue', 'createmeta', 'PROJ', '--type', 'Bug'])).toBe(0);
    type = { ...BUG, name: 'Defect' };
    expect(await t.run(['jira', 'issue', 'createmeta', 'PROJ', '--type', '10001'])).toBe(0);
    expect(await t.run(CREATE)).toBe(5);
    expect(writes(t)).toHaveLength(0);
  });

  it('treats broken JSON and unreadable cache files as misses', async () => {
    const t = program();
    await t.fs.writeFile(CACHE, '{');
    expect(await t.run([...CREATE, '--dry-run'])).toBe(0);
    const readFile = t.fs.readFile;
    t.fs.readFile = async (path) => {
      if (path === CACHE) throw new Error('permission denied');
      return readFile(path);
    };
    expect(await t.run(CREATE)).toBe(0);
    expect(metadataCalls(t)).toHaveLength(4);
    expect(t.stderr()).toContain('could not read cached create metadata');
  });

  it('warns and continues when another writer holds the cache lock', async () => {
    const t = program();
    const lock = '/home/u/proj/.lassi/cache/jira/createmeta/.lassi-write.lock';
    await t.fs.writeFile(lock, '{}');
    expect(await t.run(CREATE)).toBe(0);
    expect(t.stderr()).toContain('could not cache create metadata');
    expect(await t.fs.exists(CACHE)).toBe(false);
    expect(await t.fs.exists(lock)).toBe(true);
  });

  it('does not persist empty field metadata', async () => {
    const t = program([{ path: `${BASE}/10001`, json: { values: [], total: 0 } }]);
    expect(await t.run(['jira', 'issue', 'createmeta', 'PROJ', '--type', 'Bug'])).toBe(0);
    expect(JSON.parse(await t.fs.readFile(CACHE)).issueTypes).toEqual([]);
    expect(
      await t.run([
        'jira',
        'issue',
        'create',
        '--project',
        'PROJ',
        '--type',
        'Bug',
        '--summary',
        'Example',
        '--dry-run',
      ])
    ).toBe(0);
    expect(metadataCalls(t)).toHaveLength(4);
  });

  it('also warms and reuses legacy createmeta', async () => {
    const t = program([
      { path: BASE, status: 404, json: {} },
      {
        path: '/rest/api/2/issue/createmeta',
        json: {
          projects: [
            {
              key: 'PROJ',
              issuetypes: [{ ...BUG, fields: { summary: SUMMARY, customfield_10001: TEAM } }],
            },
          ],
        },
      },
    ]);
    expect(await t.run(['jira', 'issue', 'createmeta', 'PROJ', '--type', 'Bug'])).toBe(0);
    expect(await t.run(CREATE)).toBe(0);
    expect(metadataCalls(t)).toHaveLength(2);
  });

  it('leaves cached metadata intact when a live refresh fails', async () => {
    let fail = false;
    const t = program([
      {
        path: `${BASE}/10001`,
        handler: () =>
          fail ? { status: 403, json: {} } : { json: { values: [SUMMARY, TEAM], total: 2 } },
      },
    ]);
    const refresh = ['jira', 'issue', 'createmeta', 'PROJ', '--type', 'Bug'];
    expect(await t.run(refresh)).toBe(0);
    const before = await t.fs.readFile(CACHE);
    fail = true;
    expect(await t.run(refresh)).not.toBe(0);
    expect(await t.fs.readFile(CACHE)).toBe(before);
    expect(await t.run(CREATE)).toBe(0);
    expect(metadataCalls(t)).toHaveLength(4);
  });
});
