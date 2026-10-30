import type { Route } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import { BOTH_PRODUCTS_ENV, lastJsonLine, makeTestProgram } from '../../test/program.js';

function labelJira(initial: string[] = ['backend'], concurrentLabel?: string) {
  const labels = new Set(initial);
  const routes: Route[] = [
    {
      method: 'GET',
      path: '/rest/api/2/issue/PROJ-1',
      handler: () => ({ json: { id: '1', key: 'PROJ-1', fields: { labels: [...labels] } } }),
    },
    {
      method: 'PUT',
      path: '/rest/api/2/issue/PROJ-1',
      handler: (call) => {
        // Another editor adds a label after our GET but before Jira applies our update.
        if (concurrentLabel) labels.add(concurrentLabel);
        const body = JSON.parse(call.bodyText ?? '{}') as {
          fields?: { labels: string[] };
          update?: { labels: Array<{ add?: string; remove?: string }> };
        };
        if (body.fields) {
          labels.clear();
          for (const label of body.fields.labels) labels.add(label);
        }
        for (const operation of body.update?.labels ?? []) {
          if (operation.add !== undefined) labels.add(operation.add);
          if (operation.remove !== undefined) labels.delete(operation.remove);
        }
        return { status: 204 };
      },
    },
  ];
  return { routes, labels: () => [...labels] };
}

function program(routes: Route[], env: Record<string, string> = {}) {
  return makeTestProgram({ env: { ...BOTH_PRODUCTS_ENV, ...env }, routes });
}

const writes = (t: ReturnType<typeof program>) => t.fetch.calls.filter((c) => c.method !== 'GET');

describe('lassi jira issue label', () => {
  it.each([
    {
      mode: 'add',
      current: ['backend'],
      changed: ['Backend', 'review'],
      unchanged: ['backend'],
      final: ['backend', 'Backend', 'review'],
    },
    {
      mode: 'remove',
      current: ['Backend', 'review', 'keep'],
      changed: ['Backend', 'review'],
      unchanged: ['backend'],
      final: ['keep'],
    },
  ])(
    '$mode changes only requested labels and reports the unchanged ones',
    async ({ mode, current, changed, unchanged, final }) => {
      const jira = labelJira(current);
      const t = program(jira.routes);
      expect(
        await t.run([
          'jira',
          'issue',
          'label',
          mode,
          'PROJ-1',
          'backend',
          'Backend',
          'review',
          'Backend',
          'backend',
          '--json',
        ])
      ).toBe(0);
      expect(JSON.parse(t.stdout())).toEqual({
        key: 'PROJ-1',
        [mode === 'add' ? 'added' : 'removed']: changed,
        unchanged,
      });
      expect(t.fetch.calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
      expect(t.fetch.calls[0]?.url.searchParams.get('fields')).toBe('labels');
      expect(t.fetch.calls[0]?.url.searchParams.has('expand')).toBe(false);
      expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({
        update: { labels: changed.map((label) => ({ [mode]: label })) },
      });
      expect(jira.labels()).toEqual(final);
    }
  );

  it.each(['add', 'remove'])('%s preserves unrelated labels added after the read', async (mode) => {
    const jira = labelJira(mode === 'add' ? ['keep'] : ['keep', 'target'], 'concurrent');
    const t = program(jira.routes);
    expect(await t.run(['jira', 'issue', 'label', mode, 'PROJ-1', 'target'])).toBe(0);
    expect(jira.labels()).toEqual(
      mode === 'add' ? ['keep', 'concurrent', 'target'] : ['keep', 'concurrent']
    );
    expect(t.stdout()).toBe(
      `${mode === 'add' ? 'added' : 'removed'} labels target ${mode === 'add' ? 'to' : 'from'} PROJ-1\n`
    );
  });

  it.each(['add', 'remove'])('%s reports no changes, including under dry-run', async (mode) => {
    for (const flags of [[], ['--dry-run'], ['--json']]) {
      const jira = labelJira(mode === 'add' ? ['backend'] : []);
      const t = program(jira.routes);
      expect(
        await t.run(['jira', 'issue', 'label', mode, 'PROJ-1', 'backend', 'backend', ...flags])
      ).toBe(0);
      expect(t.fetch.calls.map((call) => call.method)).toEqual(['GET']);
      const output = flags.includes('--json') ? JSON.parse(t.stdout()) : t.stdout();
      const expected = flags.includes('--json')
        ? { key: 'PROJ-1', [mode === 'add' ? 'added' : 'removed']: [], unchanged: ['backend'] }
        : `no changes for PROJ-1\nunchanged labels (already ${mode === 'add' ? 'present' : 'absent'}): backend\n`;
      expect(output).toEqual(expected);
    }
  });

  it('adds literal arguments to an empty label list without parsing CSV or JSON', async () => {
    const jira = labelJira([]);
    const t = program(jira.routes);
    expect(await t.run(['jira', 'issue', 'label', 'add', 'PROJ-1', 'a,b', '["literal"]'])).toBe(0);
    expect(jira.labels()).toEqual(['a,b', '["literal"]']);
  });

  it.each(['add', 'remove'])(
    '%s previews only the necessary operations, including in read-only mode',
    async (mode) => {
      for (const format of [[], ['--axi']]) {
        const jira = labelJira(mode === 'add' ? ['skip'] : ['change']);
        const t = program(jira.routes, { LASSI_READ_ONLY: '1' });
        expect(
          await t.run([
            '--dry-run',
            ...format,
            'jira',
            'issue',
            'label',
            mode,
            'PROJ-1',
            'skip',
            'change',
          ])
        ).toBe(0);
        expect(t.fetch.calls.map((call) => call.method)).toEqual(['GET']);
        expect(t.stdout()).toContain(format.includes('--axi') ? 'dryRun: true' : 'DRY RUN');
        expect(t.stdout()).toContain('unchanged labels');
        expect(t.stdout()).toContain(`${mode === 'add' ? 'adds' : 'removes'} labels change`);
        expect(jira.labels()).toEqual(mode === 'add' ? ['skip'] : ['change']);
      }
    }
  );

  it.each(['add', 'remove'])(
    '%s returns an exact JSON preview with only the changed labels',
    async (mode) => {
      const t = program(labelJira(mode === 'add' ? ['skip'] : ['change']).routes);
      expect(
        await t.run([
          'jira',
          'issue',
          'label',
          mode,
          'PROJ-1',
          'skip',
          'change',
          '--dry-run',
          '--json',
        ])
      ).toBe(0);
      const data = JSON.parse(t.stdout());
      expect(data).toMatchObject({
        dryRun: true,
        key: 'PROJ-1',
        method: 'PUT',
        path: '/rest/api/2/issue/PROJ-1',
        unchanged: ['skip'],
      });
      expect(JSON.parse(data.payload)).toEqual({ update: { labels: [{ [mode]: 'change' }] } });
      expect(t.fetch.calls.map((call) => call.method)).toEqual(['GET']);
    }
  );

  it.each(['add', 'remove'])(
    '%s refuses writes in read-only mode before network access',
    async (mode) => {
      const t = program(labelJira().routes, { LASSI_READ_ONLY: '1' });
      expect(await t.run(['jira', 'issue', 'label', mode, 'PROJ-1', 'backend'])).toBe(7);
      expect(lastJsonLine(t.stderr())).toMatchObject({ code: 'read_only' });
      expect(t.fetch.calls).toHaveLength(0);
    }
  );

  it.each(['add', 'remove'])(
    '%s rejects invalid labels without sending a partial update',
    async (mode) => {
      for (const invalid of [
        '',
        'two words',
        ' leading',
        'trailing ',
        'tab\tlabel',
        'line\nlabel',
      ]) {
        const jira = labelJira(['valid']);
        const t = program(jira.routes);
        expect(await t.run(['jira', 'issue', 'label', mode, 'PROJ-1', 'valid', invalid])).toBe(2);
        expect(lastJsonLine(t.stderr())).toMatchObject({
          code: 'usage',
          message: expect.stringContaining('invalid label'),
        });
        expect(writes(t)).toHaveLength(0);
        expect(jira.labels()).toEqual(['valid']);
      }
    }
  );

  it.each(['add', 'remove'])('%s requires an issue key and at least one label', async (mode) => {
    for (const args of [[], ['PROJ-1'], ['invalid', 'backend']]) {
      const t = program([]);
      expect(await t.run(['jira', 'issue', 'label', mode, ...args])).toBe(2);
      expect(lastJsonLine(t.stderr())).toMatchObject({ code: 'usage' });
      expect(t.fetch.calls).toHaveLength(0);
    }
  });

  it.each(['add', 'remove'])(
    '%s resolves the branch key and includes results and a verification hint in AXI',
    async (mode) => {
      const t = makeTestProgram({
        env: BOTH_PRODUCTS_ENV,
        routes: labelJira(mode === 'add' ? ['skip'] : ['backend']).routes,
        files: { '/home/u/proj/.git/HEAD': 'ref: refs/heads/feature/PROJ-1-labels\n' },
      });
      expect(await t.run(['jira', 'issue', 'label', mode, '.', 'backend', 'skip', '--axi'])).toBe(
        0
      );
      expect(t.stdout()).toContain('key: PROJ-1');
      expect(t.stdout()).toContain(`${mode === 'add' ? 'added' : 'removed'}[1]: backend`);
      expect(t.stdout()).toContain('unchanged[1]: skip');
      expect(t.stdout()).toContain('Run `lassi jira issue get PROJ-1` to verify.');
    }
  );

  it.each(['add', 'remove'])(
    '%s summarizes changed and unchanged labels in Markdown',
    async (mode) => {
      const t = program(labelJira(mode === 'add' ? ['skip'] : ['change']).routes);
      expect(await t.run(['jira', 'issue', 'label', mode, 'PROJ-1', 'change', 'skip'])).toBe(0);
      expect(t.stdout()).toBe(
        `${mode === 'add' ? 'added' : 'removed'} labels change ${mode === 'add' ? 'to' : 'from'} PROJ-1\nunchanged labels (already ${mode === 'add' ? 'present' : 'absent'}): skip\n`
      );
    }
  );

  it.each(['add', 'remove'])('%s redacts labels from output and previews', async (mode) => {
    for (const format of [[], ['--json'], ['--axi'], ['--dry-run']]) {
      const secret = BOTH_PRODUCTS_ENV.LASSI_JIRA_TOKEN;
      const t = program(labelJira(mode === 'add' ? [] : [secret]).routes);
      expect(await t.run(['jira', 'issue', 'label', mode, 'PROJ-1', secret, ...format])).toBe(0);
      expect(t.stdout()).not.toContain(secret);
      expect(t.stderr()).not.toContain(secret);
    }
  });

  it.each(['add', 'remove'])(
    '%s propagates structured read and write failures without success output',
    async (mode) => {
      for (const method of ['GET', 'PUT']) {
        const failure: Route = {
          method,
          path: '/rest/api/2/issue/PROJ-1',
          status: method === 'GET' ? 404 : 400,
          json:
            method === 'GET'
              ? { errorMessages: ['Issue does not exist.'] }
              : { errors: { labels: 'Labels cannot be edited on this screen.' } },
        };
        const t = program([failure, ...labelJira(mode === 'add' ? [] : ['backend']).routes]);
        expect(await t.run(['jira', 'issue', 'label', mode, 'PROJ-1', 'backend'])).toBe(
          method === 'GET' ? 4 : 5
        );
        expect(lastJsonLine(t.stderr())).toMatchObject(
          method === 'GET'
            ? { code: 'not_found', http: 404 }
            : {
                code: 'validation',
                http: 400,
                errors: { labels: 'Labels cannot be edited on this screen.' },
              }
        );
        expect(t.stdout()).toBe('');
        expect(writes(t)).toHaveLength(method === 'GET' ? 0 : 1);
      }
    }
  );

  it.each(['labels=["only"]', 'labels=[]'])(
    'issue update still replaces the full list with %s',
    async (field) => {
      const jira = labelJira(['backend', 'review']);
      const t = program(jira.routes);
      expect(await t.run(['jira', 'issue', 'update', 'PROJ-1', '--field', field])).toBe(0);
      const labels = field === 'labels=[]' ? [] : ['only'];
      expect(JSON.parse(writes(t)[0]?.bodyText ?? '')).toEqual({ fields: { labels } });
      expect(jira.labels()).toEqual(labels);
    }
  );
});
