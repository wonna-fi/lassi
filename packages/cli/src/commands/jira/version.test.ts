import type { Route } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import { BOTH_PRODUCTS_ENV, lastJsonLine, makeTestProgram } from '../../test/program.js';

const VERSIONS = [
  { id: '100', name: '1.0', archived: true, released: true, releaseDate: '2026-01-15' },
  { id: '101', name: '2.0', archived: false, released: true, releaseDate: '2026-08-01' },
  { id: '102', name: '2.1', archived: false, released: false },
  { id: '103', name: '3.0', archived: false, released: false },
];

/** Project PROJ with its versions, and PROJ-1 with fix versions that `PUT` sets or adds to. */
function versionJira(onIssue: string[] = ['2.0']) {
  let fixVersions = onIssue.map((n) => VERSIONS.find((v) => v.name === n)?.id ?? '');
  const routes: Route[] = [
    {
      method: 'GET',
      path: '/rest/api/2/issue/PROJ-1',
      handler: () => ({
        json: {
          id: '1',
          key: 'PROJ-1',
          fields: {
            project: { id: '10', key: 'PROJ' },
            fixVersions: VERSIONS.filter((v) => fixVersions.includes(v.id)).map((v) => ({
              id: v.id,
              name: v.name,
            })),
          },
        },
      }),
    },
    { method: 'GET', path: '/rest/api/2/project/PROJ/versions', json: VERSIONS },
    {
      method: 'PUT',
      path: '/rest/api/2/issue/PROJ-1',
      handler: (call) => {
        const body = JSON.parse(call.bodyText ?? '{}') as {
          fields?: { fixVersions: Array<{ id: string }> };
          update?: { fixVersions: Array<{ add: { id: string } }> };
        };
        if (body.fields) fixVersions = body.fields.fixVersions.map((v) => v.id);
        for (const op of body.update?.fixVersions ?? []) fixVersions.push(op.add.id);
        return { status: 204 };
      },
    },
  ];
  return {
    routes,
    onIssue: () => VERSIONS.filter((v) => fixVersions.includes(v.id)).map((v) => v.name),
  };
}

function program(routes: Route[], env: Record<string, string> = {}) {
  return makeTestProgram({ env: { ...BOTH_PRODUCTS_ENV, ...env }, routes });
}

const writes = (t: ReturnType<typeof program>) => t.fetch.calls.filter((c) => c.method !== 'GET');

describe('lassi jira project version list', () => {
  it('lists the versions an issue can take, leaving out archived ones', async () => {
    const t = program(versionJira().routes);
    expect(await t.run(['jira', 'project', 'version', 'list', 'PROJ'])).toBe(0);
    expect(t.stdout()).toBe(
      [
        '# PROJ fix versions',
        '',
        '| Name | Released | Release date | Id |',
        '| - | - | - | - |',
        '| 2.0 | yes | 2026-08-01 | 101 |',
        '| 2.1 | no | - | 102 |',
        '| 3.0 | no | - | 103 |',
        '',
      ].join('\n')
    );
    const axi = program(versionJira().routes);
    expect(await axi.run(['jira', 'project', 'version', 'list', 'PROJ', '--axi'])).toBe(0);
    expect(axi.stdout()).toContain('lassi jira issue fix-version set <KEY>');
  });
});

describe('lassi jira issue fix-version set', () => {
  it('replaces the fix versions with the ones given, by id', async () => {
    const jira = versionJira(['2.0']);
    const t = program(jira.routes);
    expect(await t.run(['jira', 'issue', 'fix-version', 'set', 'PROJ-1', '2.1', '--json'])).toBe(0);
    expect(JSON.parse(t.stdout())).toEqual({ key: 'PROJ-1', fixVersions: ['2.1'], added: ['2.1'] });
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
      fields: { fixVersions: [{ id: '102' }] },
    });
    expect(jira.onIssue()).toEqual(['2.1']);
  });

  it('adds to the fix versions with --add, skipping the ones the issue has', async () => {
    const jira = versionJira(['2.0']);
    const t = program(jira.routes);
    expect(
      await t.run(['jira', 'issue', 'fix-version', 'set', 'PROJ-1', '2.0', '3.0', '--add'])
    ).toBe(0);
    expect(t.stdout()).toBe('added fix version 3.0 to PROJ-1\n');
    expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
      update: { fixVersions: [{ add: { id: '103' } }] },
    });
    expect(jira.onIssue()).toEqual(['2.0', '3.0']);
  });

  it('sends nothing when the issue already has exactly those versions', async () => {
    for (const args of [['2.0'], ['2.0', '--add']]) {
      const t = program(versionJira(['2.0']).routes);
      expect(await t.run(['jira', 'issue', 'fix-version', 'set', 'PROJ-1', ...args])).toBe(0);
      expect(t.stdout()).toBe('no changes for PROJ-1 (fix versions: 2.0)\n');
      expect(writes(t)).toHaveLength(0);
    }
  });

  it('refuses a version the project lacks, listing the allowed ones, before sending', async () => {
    const t = program(versionJira().routes);
    expect(await t.run(['jira', 'issue', 'fix-version', 'set', 'PROJ-1', '2.1', '9.9'])).toBe(4);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'not_found',
      message: 'no version "9.9" in PROJ; allowed: 2.0, 2.1, 3.0',
      hint: 'run `lassi jira project version list PROJ`',
    });
    expect(writes(t)).toHaveLength(0);
  });

  it('refuses an archived version', async () => {
    const t = program(versionJira().routes);
    expect(await t.run(['jira', 'issue', 'fix-version', 'set', 'PROJ-1', '1.0'])).toBe(5);
    expect(lastJsonLine(t.stderr())).toMatchObject({
      code: 'validation',
      message: 'version "1.0" in PROJ is archived; allowed: 2.0, 2.1, 3.0',
    });
    expect(writes(t)).toHaveLength(0);
  });

  it('warns when replacing drops an archived fix version', async () => {
    const jira = versionJira(['1.0', '2.0']);
    const t = program(jira.routes);
    expect(await t.run(['jira', 'issue', 'fix-version', 'set', 'PROJ-1', '2.0'])).toBe(0);
    expect(t.stderr()).toContain(
      'PROJ-1 loses archived fix version 1.0, which cannot be set again; use --add to keep it'
    );
    expect(jira.onIssue()).toEqual(['2.0']);
  });

  it('previews the update under --dry-run, and is blocked under read-only', async () => {
    const jira = versionJira(['2.0']);
    const dry = program(jira.routes);
    expect(
      await dry.run(['jira', 'issue', 'fix-version', 'set', 'PROJ-1', '2.1', '--dry-run'])
    ).toBe(0);
    expect(dry.stdout()).toBe(
      [
        'DRY RUN — nothing sent',
        'PUT /rest/api/2/issue/PROJ-1',
        'sets PROJ-1 fix versions to 2.1 (was: 2.0)',
        '--- fields (json) ---',
        '{\n  "fields": {\n    "fixVersions": [\n      {\n        "id": "102"\n      }\n    ]\n  }\n}',
        '',
      ].join('\n')
    );
    const readOnly = program(jira.routes, { LASSI_READ_ONLY: '1' });
    expect(await readOnly.run(['jira', 'issue', 'fix-version', 'set', 'PROJ-1', '2.1'])).toBe(7);
    expect(readOnly.fetch.calls).toHaveLength(0);
    expect(writes(dry)).toHaveLength(0);
    expect(jira.onIssue()).toEqual(['2.0']);
  });
});
