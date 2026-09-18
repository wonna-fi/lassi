import { parseSince } from '@wonna/lassi-core';
import { describe, expect, it } from 'vitest';
import type { JiraHistory, JiraIssue, JiraSearchPage } from '../client/types.js';
import { buildDigest, commentSnippet, mentionsUser } from './build.js';
import { digestJql, jqlQuote } from './jql.js';

const NOW = new Date('2026-09-04T10:00:00.000Z');
const SINCE = parseSince('1d', NOW);
const ME = 'jsmith';

function page(issues: JiraIssue[], total = issues.length): JiraSearchPage {
  return { issues, total, startAt: 0, maxResults: 50 };
}

const PROJ_123: JiraIssue = {
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
          body: '[~jsmith] can you look?\n\nSecond paragraph.',
          created: '2026-09-03T16:00:00.000+0300',
          author: { name: 'jdoe', displayName: 'J' },
        },
        {
          id: '11',
          body: 'on it',
          created: '2026-09-03T17:00:00.000+0300',
          author: { name: 'jsmith', displayName: 'S' },
        },
        {
          id: '9',
          body: '[~jsmith] old',
          created: '2026-09-01T10:00:00.000+0300',
          author: { name: 'jdoe', displayName: 'J' },
        },
      ],
      total: 3,
      startAt: 0,
      maxResults: 3,
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

const PROJ_124: JiraIssue = {
  id: '2',
  key: 'PROJ-124',
  fields: {
    summary: 'Only my comment',
    status: { name: 'Open' },
    comment: {
      comments: [
        {
          id: '20',
          body: 'done',
          created: '2026-09-03T18:00:00.000+0300',
          author: { name: 'jsmith', displayName: 'S' },
        },
      ],
      total: 1,
      startAt: 0,
      maxResults: 1,
    },
  },
  changelog: { startAt: 0, maxResults: 0, total: 0, histories: [] },
};

const PROJ_200: JiraIssue = {
  id: '3',
  key: 'PROJ-200',
  fields: {
    summary: 'Similar name',
    status: { name: 'Open' },
    comment: {
      comments: [
        {
          id: '30',
          body: '[~jsmithson] fyi',
          created: '2026-09-03T18:00:00.000+0300',
          author: { name: 'jdoe', displayName: 'J' },
        },
      ],
      total: 1,
      startAt: 0,
      maxResults: 1,
    },
  },
};

describe('digestJql', () => {
  it('builds the two clauses with the window, an optional extra clause and quoting', () => {
    const jql = digestJql(ME, SINCE, NOW);
    expect(jql.mine).toBe(
      '(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -1d ORDER BY updated DESC'
    );
    expect(jql.mentions).toBe('comment ~ "jsmith" AND updated >= -1d ORDER BY updated DESC');
    const narrowed = digestJql(ME, SINCE, NOW, { extra: 'project = DEV' });
    expect(narrowed.mine).toContain('updated >= -1d AND (project = DEV) ORDER BY');
    expect(narrowed.mentions).toContain('AND (project = DEV) ORDER BY');
    expect(() => digestJql(ME, SINCE, NOW, { extra: 'x = 1 order by y' })).toThrow(/ORDER BY/);
    expect(digestJql(ME, SINCE, NOW, { extra: 'text ~ "order by"' }).mine).toContain(
      'AND (text ~ "order by") ORDER BY'
    );
    expect(() => digestJql(ME, SINCE, NOW, { extra: `text ~ 'x' ORDER BY y` })).toThrow(/ORDER BY/);
    expect(jqlQuote('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('refuses a clause with unbalanced parentheses', () => {
    // The clause is wrapped in `AND (…)`, so an extra `)` closed that wrapper and the section's own
    // conditions stopped applying: the "mine" search returned every Blocker in the instance.
    for (const extra of ['project = DEV) OR (priority = Blocker', '(project = DEV', 'a) AND (b']) {
      expect(() => digestJql(ME, SINCE, NOW, { extra })).toThrow(/unbalanced parentheses/);
    }
    // Parentheses inside a string literal are text, like `order by` above.
    expect(digestJql(ME, SINCE, NOW, { extra: 'text ~ "a)b"' }).mine).toContain(
      'AND (text ~ "a)b")'
    );
  });
});

describe("two of the user's own histories at the same instant", () => {
  it('stay two actions', () => {
    // Grouping the flattened rows by timestamp merged them into one, combined unrelated changes
    // and undercounted totals.actions. A history is the unit the user performed.
    const at = '2026-09-03T15:00:00.000+0300';
    const history = (id: string, field: string, to: string): JiraHistory => ({
      id,
      created: at,
      author: { name: ME, displayName: 'John Smith' },
      items: [{ field, from: null, fromString: '', to: null, toString: to }],
    });
    const issue: JiraIssue = {
      id: '1',
      key: 'PROJ-321',
      fields: { summary: 'Two at once' },
      changelog: {
        startAt: 0,
        maxResults: 100,
        total: 2,
        histories: [history('1', 'Status', 'Done'), history('2', 'Team', 'X')],
      },
    };
    const digest = buildDigest({
      me: ME,
      since: SINCE,
      mine: page([issue]),
      mentions: page([]),
    });
    expect(digest.actions.map((a) => a.what)).toEqual(['Status: - → Done', 'Team: - → X']);
    expect(digest.totals.actions).toBe(2);
  });
});

describe('mentionsUser / commentSnippet', () => {
  it('matches the exact mention and cuts the first paragraph', () => {
    expect(mentionsUser('[~jsmith] hi', 'jsmith')).toBe(true);
    expect(mentionsUser('[~jsmithson] hi', 'jsmith')).toBe(false);
    expect(mentionsUser('jsmith without brackets', 'jsmith')).toBe(false);
    expect(commentSnippet('first *line*\n\nsecond')).toBe('first **line**');
    expect(commentSnippet(`${'word '.repeat(80)}end`, 20)).toBe('word word word word…');
  });
});

describe('buildDigest', () => {
  const digest = buildDigest({
    me: ME,
    since: SINCE,
    aliases: { team: 'customfield_10001' },
    mine: page([PROJ_123, PROJ_124], 5),
    mentions: page([PROJ_123, PROJ_200]),
  });

  it('lists mentions by others inside the window only', () => {
    expect(digest.mentions).toEqual([
      {
        key: 'PROJ-123',
        summary: 'Login page throws 500 on empty password',
        id: '10',
        who: 'jdoe',
        at: '2026-09-03T16:00:00.000+0300',
        body: '@jsmith can you look?',
      },
    ]);
  });

  it('separates changes by others from what the user did', () => {
    expect(digest.changed).toHaveLength(1);
    expect(digest.changed[0]).toMatchObject({
      key: 'PROJ-123',
      status: 'In Progress',
      assignee: 'jsmith',
      partial: false,
      changes: [{ who: 'jdoe', field: 'status', from: 'Open', to: 'In Progress' }],
      comments: [{ id: '10', who: 'jdoe' }],
    });
    expect(digest.actions).toEqual([
      {
        key: 'PROJ-123',
        summary: 'Login page throws 500 on empty password',
        at: '2026-09-03T15:00:00.000+0300',
        what: 'team: - → Platform',
      },
      {
        key: 'PROJ-123',
        summary: 'Login page throws 500 on empty password',
        at: '2026-09-03T17:00:00.000+0300',
        what: 'commented: "on it"',
      },
      {
        key: 'PROJ-124',
        summary: 'Only my comment',
        at: '2026-09-03T18:00:00.000+0300',
        what: 'commented: "done"',
      },
    ]);
    expect(digest.totals).toEqual({ mentions: 1, changed: 1, actions: 3 });
    expect(digest.truncated).toEqual({ mine: true, mentions: false });
    expect(digest.since).toBe('2026-09-03T10:00:00.000Z');
  });

  it('shows a changed text value as one bounded line', () => {
    const long = `# Heading\n\n${'word '.repeat(100)}end`;
    const edited: JiraIssue = {
      ...PROJ_124,
      changelog: {
        startAt: 0,
        maxResults: 1,
        total: 1,
        histories: [
          {
            id: '9',
            author: { name: 'jdoe', displayName: 'J' },
            created: '2026-09-03T19:00:00.000+0300',
            items: [
              {
                field: 'description',
                fieldId: 'description',
                from: null,
                fromString: 'old',
                to: null,
                toString: long,
              },
            ],
          },
        ],
      },
    };
    const d = buildDigest({ me: ME, since: SINCE, mine: page([edited]), mentions: page([]) });
    const row = d.changed[0]?.changes[0];
    expect(row?.to).not.toContain('\n');
    expect(row?.to.length).toBe(120);
    expect(row?.to.endsWith('…')).toBe(true);
    expect(row?.to.startsWith('# Heading word')).toBe(true);
  });

  it('keeps an issue whose changelog Jira cut, so the gap is visible', () => {
    const cut: JiraIssue = {
      ...PROJ_124,
      changelog: { startAt: 0, maxResults: 0, total: 4, histories: [] },
    };
    const d = buildDigest({ me: ME, since: SINCE, mine: page([cut]), mentions: page([]) });
    expect(d.changed).toEqual([
      expect.objectContaining({ key: 'PROJ-124', partial: true, changes: [], comments: [] }),
    ]);
  });
});
