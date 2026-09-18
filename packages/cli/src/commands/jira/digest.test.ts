import type { Route } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import { BOTH_PRODUCTS_ENV, lastJsonLine, makeTestProgram } from '../../test/program.js';

const PROJ_123 = {
  id: '1',
  key: 'PROJ-123',
  fields: {
    summary: 'Login page throws 500 on empty password',
    status: { name: 'In Progress' },
    assignee: { name: 'jsmith', displayName: 'S' },
    updated: '2026-09-03T17:00:00.000+0300',
    comment: {
      comments: [
        {
          id: '10',
          body: '[~jsmith] can you *look*?',
          created: '2026-09-03T16:00:00.000+0300',
          author: { name: 'jdoe', displayName: 'J' },
        },
        {
          id: '11',
          body: 'on it',
          created: '2026-09-03T17:00:00.000+0300',
          author: { name: 'jsmith', displayName: 'S' },
        },
      ],
      total: 2,
      startAt: 0,
      maxResults: 2,
    },
  },
  changelog: {
    startAt: 0,
    maxResults: 2,
    total: 2,
    histories: [
      {
        id: '1',
        author: { name: 'jdoe', displayName: 'J' },
        created: '2026-09-03T14:02:10.000+0300',
        items: [
          {
            field: 'status',
            fieldId: 'status',
            from: '1',
            fromString: 'Open',
            to: '3',
            toString: 'In Progress',
          },
        ],
      },
      {
        id: '2',
        author: { name: 'jsmith', displayName: 'S' },
        created: '2026-09-03T15:00:00.000+0300',
        items: [
          {
            field: 'Team',
            fieldId: 'customfield_10001',
            from: null,
            fromString: null,
            to: '1',
            toString: 'Platform',
          },
        ],
      },
    ],
  },
};

const PROJ_124 = {
  id: '2',
  key: 'PROJ-124',
  fields: {
    summary: 'Busy issue',
    status: { name: 'Open' },
    // Jira cut the container: only the oldest comment came with the search.
    comment: {
      comments: [
        {
          id: '20',
          body: 'old',
          created: '2026-08-01T10:00:00.000+0300',
          author: { name: 'jdoe' },
        },
      ],
      total: 3,
      startAt: 0,
      maxResults: 1,
    },
  },
  changelog: { startAt: 0, maxResults: 0, total: 0, histories: [] },
};

function routes(overrides: { mine?: unknown[]; mentions?: unknown[]; mineTotal?: number } = {}) {
  const searches: Array<Record<string, unknown>> = [];
  const list: Route[] = [
    { path: '/rest/api/2/myself', json: { name: 'jsmith', displayName: 'John Smith' } },
    {
      method: 'POST',
      path: '/rest/api/2/search',
      handler: (call) => {
        const body = JSON.parse(call.bodyText ?? '{}') as Record<string, unknown>;
        searches.push(body);
        const jql = String(body['jql']);
        // Distinct objects for the same keys, as two search responses would carry.
        const clone = (issues: unknown[]) => JSON.parse(JSON.stringify(issues)) as unknown[];
        const issues = jql.startsWith('comment ~')
          ? clone(overrides.mentions ?? [PROJ_123, PROJ_124])
          : clone(overrides.mine ?? [PROJ_123, PROJ_124]);
        return {
          json: {
            issues,
            total: jql.startsWith('comment ~')
              ? issues.length
              : (overrides.mineTotal ?? issues.length),
            startAt: 0,
            maxResults: 50,
          },
        };
      },
    },
    {
      // Paged newest-first; the client asks for 100 per page, this fake hands out one per page
      // so the loop has to continue into the window and stop once it has left it.
      path: '/rest/api/2/issue/PROJ-124/comment',
      handler: (call) => {
        const startAt = Number(call.url.searchParams.get('startAt'));
        const pages = [
          {
            id: '22',
            body: 'done',
            created: '2026-09-03T18:00:00.000+0300',
            author: { name: 'jsmith' },
          },
          {
            id: '21',
            body: 'first',
            created: '2026-09-03T14:00:00.000+0300',
            author: { name: 'jdoe' },
          },
          {
            id: '20',
            body: 'old',
            created: '2026-08-01T10:00:00.000+0300',
            author: { name: 'jdoe' },
          },
        ];
        return {
          json: { comments: pages.slice(startAt, startAt + 1), total: 3, startAt, maxResults: 1 },
        };
      },
    },
  ];
  return { list, searches };
}

function program(overrides: Parameters<typeof routes>[0] = {}) {
  const r = routes(overrides);
  const t = makeTestProgram({
    env: BOTH_PRODUCTS_ENV,
    routes: r.list,
    files: {
      '/home/u/proj/.lassi.json': JSON.stringify({
        jira: { fields: { team: 'customfield_10001' }, defaultProject: 'PROJ' },
      }),
    },
  });
  return { ...t, searches: r.searches };
}

describe('lassi jira digest', () => {
  it('renders mentions, changes by others and what the user did, completing cut comment containers', async () => {
    const t = program();
    expect(await t.run(['jira', 'digest'])).toBe(0);
    expect(t.stdout()).toBe(
      [
        '# Jira digest for jsmith since 2026-09-03 10:00 (1d)',
        '',
        '## Mentioned you (1)',
        '',
        '- PROJ-123 Login page throws 500 on empty password — jdoe, 2026-09-03T16:00:00.000+0300: "@jsmith can you **look**?"',
        '',
        '## Your issues that changed (2)',
        '',
        '### PROJ-123 Login page throws 500 on empty password (In Progress)',
        '',
        '- 2026-09-03T14:02:10.000+0300 jdoe status: Open → In Progress',
        '- 2026-09-03T16:00:00.000+0300 jdoe commented: "@jsmith can you **look**?"',
        '',
        '### PROJ-124 Busy issue (Open)',
        '',
        '- 2026-09-03T14:00:00.000+0300 jdoe commented: "first"',
        '',
        '## What you did (3)',
        '',
        '- 2026-09-03T15:00:00.000+0300 PROJ-123 team: - → Platform',
        '- 2026-09-03T17:00:00.000+0300 PROJ-123 commented: "on it"',
        '- 2026-09-03T18:00:00.000+0300 PROJ-124 commented: "done"',
        '',
      ].join('\n')
    );
    expect(t.searches).toHaveLength(2);
    expect(t.searches[0]).toMatchObject({
      jql: '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -1d ORDER BY updated DESC',
      maxResults: 50,
      expand: ['changelog'],
    });
    expect(t.searches[0]?.['fields']).toContain('comment');
    expect(t.searches[1]?.['jql']).toBe(
      'comment ~ "jsmith" AND updated >= -1d ORDER BY updated DESC'
    );
    // PROJ-124 came back from both searches; its comments were paged once and shared.
    const commentPages = t.fetch.calls
      .filter((c) => c.url.pathname === '/rest/api/2/issue/PROJ-124/comment')
      .map((c) => c.url.searchParams.get('startAt'));
    expect(commentPages).toEqual(['0', '1', '2']);
    expect(t.stderr()).toBe('');
  });

  it('honours --since, --jql and --limit in the JQL and warns when a section was cut', async () => {
    const t = program({ mineTotal: 80 });
    expect(
      await t.run([
        'jira',
        'digest',
        '--since',
        '2026-09-03T00:00+03:00',
        '--jql',
        'project = DEV',
        '--limit',
        '10',
      ])
    ).toBe(0);
    // 2026-09-02T21:00Z to the fixed clock 2026-09-04T10:00Z is 2220 minutes, plus one of slack.
    expect(t.searches[0]?.['jql']).toBe(
      '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -2221m AND (project = DEV) ORDER BY updated DESC'
    );
    expect(t.searches[0]?.['maxResults']).toBe(10);
    expect(t.stderr()).toContain(
      'warn: showing 2 of 80 of your issues; raise --limit or narrow --jql'
    );
    expect(t.stdout()).toContain('since 2026-09-02 21:00 (2026-09-03T00:00+03:00)'.slice(0, 6));
  });

  it('prints a definitive empty state and a next step under --axi', async () => {
    const t = program({ mine: [], mentions: [] });
    expect(await t.run(['jira', 'digest', '--since', '2h'])).toBe(0);
    expect(t.stdout()).toBe(
      '# Jira digest for jsmith since 2026-09-04 08:00 (2h)\n\nnothing happened on your issues since 2h\n'
    );
    const cut = program({ mine: [], mentions: [], mineTotal: 5 });
    await cut.run(['jira', 'digest']);
    expect(cut.stdout()).toContain(
      'nothing found among the fetched issues since 1d; the search returned more issues than were fetched'
    );
    expect(cut.stdout()).not.toContain('nothing happened');
    const axi = program({ mine: [], mentions: [] });
    await axi.run(['jira', 'digest', '--axi']);
    expect(axi.stdout()).toContain('counts:');
    expect(axi.stdout()).toContain('help[1]:\n  Nothing happened in that window; widen --since');
    const cutAxi = program({ mine: [], mentions: [], mineTotal: 5 });
    await cutAxi.run(['jira', 'digest', '--axi']);
    expect(cutAxi.stdout()).toContain(
      'help[1]:\n  Nothing found among the fetched issues; raise --limit'
    );
    const full = program();
    await full.run(['jira', 'digest', '--axi', '--since', '1w']);
    expect(full.stdout()).toContain('help[2]:\n  Run `lassi jira issue get <KEY> --comments 5`');
    expect(full.stdout()).toContain('lassi jira issue changelog <KEY> --since 1w');
  });

  it('shapes --json as the model and rejects bad flags before any request', async () => {
    const t = program();
    expect(await t.run(['jira', 'digest', '--json'])).toBe(0);
    expect(JSON.parse(t.stdout())).toMatchObject({
      me: 'jsmith',
      since: '2026-09-03T10:00:00.000Z',
      totals: { mentions: 1, changed: 2, actions: 3 },
      truncated: { mine: false, mentions: false },
    });
    for (const argv of [
      ['jira', 'digest', '--limit', '0'],
      ['jira', 'digest', '--jql', 'x = 1 ORDER BY y'],
      ['jira', 'digest', '--since', 'never'],
    ]) {
      const bad = program();
      expect(await bad.run(argv)).toBe(2);
      expect(lastJsonLine(bad.stderr())).toMatchObject({ code: 'usage' });
      expect(bad.fetch.calls).toHaveLength(0);
    }
  });

  it('stops the comment workers when one issue fails', async () => {
    // The busy issues share a queue. `Promise.all` rejects on the first failure and leaves the
    // other workers pulling entries, so the command reported the error while requests kept going.
    const cut = (key: string) => ({
      ...JSON.parse(JSON.stringify(PROJ_124)),
      key,
      fields: {
        ...JSON.parse(JSON.stringify(PROJ_124)).fields,
        comment: { comments: [], total: 3, startAt: 0, maxResults: 1 },
      },
    });
    const busy = ['PROJ-201', 'PROJ-202', 'PROJ-203', 'PROJ-204', 'PROJ-205'].map(cut);
    const t = makeTestProgram({
      env: BOTH_PRODUCTS_ENV,
      routes: [
        {
          method: 'POST',
          path: '/rest/api/2/search',
          handler: (call) => {
            const jql = String((JSON.parse(call.bodyText ?? '{}') as { jql: string }).jql);
            return {
              json: {
                issues: jql.startsWith('comment ~') ? [] : JSON.parse(JSON.stringify(busy)),
                total: jql.startsWith('comment ~') ? 0 : busy.length,
                startAt: 0,
                maxResults: 50,
              },
            };
          },
        },
        {
          path: /^\/rest\/api\/2\/issue\/PROJ-20\d\/comment$/,
          status: 403,
          json: { errorMessages: ['no'] },
        },
      ],
    });
    expect(await t.run(['jira', 'digest'])).not.toBe(0);
    const asked = t.fetch.calls.filter((c) => c.url.pathname.endsWith('/comment')).length;
    // At most one in flight per worker when the first failure lands; never the whole queue.
    expect(asked).toBeLessThanOrEqual(4);
  });

  it('stops paging an issue when another worker fails', async () => {
    // The mixed case the test above cannot reach: one issue refuses outright while another is
    // partway through a long comment history, which used to page to the end regardless.
    const many = (key: string, total: number) => ({
      ...JSON.parse(JSON.stringify(PROJ_124)),
      key,
      fields: {
        ...JSON.parse(JSON.stringify(PROJ_124)).fields,
        comment: { comments: [], total, startAt: 0, maxResults: 1 },
      },
    });
    let pages = 0;
    const t = makeTestProgram({
      env: BOTH_PRODUCTS_ENV,
      routes: [
        {
          method: 'POST',
          path: '/rest/api/2/search',
          handler: (call) => {
            const jql = String((JSON.parse(call.bodyText ?? '{}') as { jql: string }).jql);
            const issues = jql.startsWith('comment ~')
              ? []
              : [many('PROJ-301', 50), many('PROJ-302', 50)];
            return { json: { issues, total: issues.length, startAt: 0, maxResults: 50 } };
          },
        },
        {
          path: '/rest/api/2/issue/PROJ-301/comment',
          status: 403,
          json: { errorMessages: ['no'] },
        },
        {
          path: '/rest/api/2/issue/PROJ-302/comment',
          handler: (call) => {
            pages += 1;
            const startAt = Number(call.url.searchParams.get('startAt'));
            return {
              json: {
                comments: [
                  {
                    id: String(startAt),
                    body: 'x',
                    created: '2026-09-03T18:00:00.000+0300',
                    author: { name: 'jdoe' },
                  },
                ],
                total: 50,
                startAt,
                maxResults: 1,
              },
            };
          },
        },
      ],
    });
    expect(await t.run(['jira', 'digest'])).not.toBe(0);
    // 50 comments at one per page would be 50 requests if the loop ignored the other worker.
    expect(pages).toBeLessThan(10);
  });
});
