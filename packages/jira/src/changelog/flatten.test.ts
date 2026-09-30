import { parseSince } from '@wonna/lassi-core';
import { describe, expect, it } from 'vitest';
import type { JiraHistory } from '../client/types.js';
import {
  changelogFieldNames,
  changelogNeedsFieldNames,
  flattenChangelog,
  matchesField,
  sinceToJql,
} from './flatten.js';

const HISTORIES: JiraHistory[] = [
  {
    id: '2',
    author: { name: 'jsmith', displayName: 'S' },
    created: '2026-09-03T14:02:10.000+0300',
    items: [
      {
        field: 'Team',
        fieldtype: 'custom',
        fieldId: 'customfield_10001',
        from: null,
        fromString: null,
        to: '1',
        toString: 'Platform',
      },
      {
        field: 'labels',
        fieldtype: 'jira',
        fieldId: 'labels',
        from: null,
        fromString: 'auth',
        to: null,
        toString: 'auth regression',
      },
    ],
  },
  {
    id: '1',
    author: { name: 'jdoe', displayName: 'J' },
    created: '2026-09-02T09:00:00.000+0300',
    items: [
      {
        field: 'status',
        fieldtype: 'jira',
        fieldId: 'status',
        from: '1',
        fromString: 'Open',
        to: '3',
        toString: 'In Progress',
      },
    ],
  },
];
const ALIASES = { team: 'customfield_10001' };

describe('flattenChangelog', () => {
  it('orders oldest first, applies aliases and turns null into an empty cell', () => {
    expect(flattenChangelog(HISTORIES, { aliases: ALIASES })).toEqual([
      {
        at: '2026-09-02T09:00:00.000+0300',
        who: 'jdoe',
        field: 'status',
        fieldId: 'status',
        from: 'Open',
        to: 'In Progress',
      },
      {
        at: '2026-09-03T14:02:10.000+0300',
        who: 'jsmith',
        field: 'team',
        fieldId: 'customfield_10001',
        from: '',
        to: 'Platform',
      },
      {
        at: '2026-09-03T14:02:10.000+0300',
        who: 'jsmith',
        field: 'labels',
        fieldId: 'labels',
        from: 'auth',
        to: 'auth regression',
      },
    ]);
  });

  it('cuts at --since inclusively and filters fields by alias, name or id', () => {
    const since = new Date('2026-09-03T11:02:10.000Z');
    expect(flattenChangelog(HISTORIES, { since }).map((r) => r.field)).toEqual(['Team', 'labels']);
    expect(flattenChangelog(HISTORIES, { since: new Date('2026-09-03T11:02:11.000Z') })).toEqual(
      []
    );
    expect(
      flattenChangelog(HISTORIES, { fields: ['STATUS'], aliases: ALIASES }).map((r) => r.field)
    ).toEqual(['status']);
    expect(
      flattenChangelog(HISTORIES, { fields: ['team'], aliases: ALIASES }).map((r) => r.to)
    ).toEqual(['Platform']);
    expect(
      flattenChangelog(HISTORIES, { fields: ['customfield_10001'] }).map((r) => r.field)
    ).toEqual(['Team']);
    expect(
      flattenChangelog(HISTORIES, {
        fields: ['theteam'],
        aliases: { TheTeam: 'customfield_10001' },
      }).map((r) => r.to)
    ).toEqual(['Platform']);
  });

  it('keeps an entry whose date it cannot parse rather than dropping it silently', () => {
    const odd: JiraHistory[] = [{ ...(HISTORIES[1] as JiraHistory), created: 'unknown' }];
    expect(flattenChangelog(odd, { since: new Date() })).toHaveLength(1);
  });

  it('orders the rest correctly around an entry whose date it cannot parse', () => {
    // The comparator switched key per pair, which is not transitive: one undated entry let the
    // sort emit an arbitrary permutation of the whole history.
    const dated = (n: number): JiraHistory => ({
      id: String(n),
      created: `2026-09-${String(n).padStart(2, '0')}T10:00:00.000+0300`,
      author: { name: 'jsmith', displayName: 'John Smith' },
      items: [{ field: 'Status', from: null, fromString: 'Open', to: null, toString: `S${n}` }],
    });
    const histories = [dated(9), dated(3), { ...dated(5), created: 'unknown' }, dated(7)];
    expect(flattenChangelog(histories).map((r) => r.to)).toEqual(['S3', 'S7', 'S9', 'S5']);
  });

  it('treats an empty field filter as no filter', () => {
    // `[]` is truthy and `.some` on it is false, so every row was skipped and the command said
    // "no changes for  on KEY".
    expect(flattenChangelog(HISTORIES, { fields: [] })).toEqual(flattenChangelog(HISTORIES));
  });

  it('does not let Object.prototype answer for a missing toString', () => {
    // A changelog item without its own `toString` key resolved to the prototype method, so a
    // function landed in a field the type calls a string and the digest died on it.
    const item = { field: 'Status', from: null, fromString: 'Open', to: 'x' };
    const rows = flattenChangelog([
      {
        id: '1',
        created: HISTORIES[0]?.created ?? '',
        author: { name: 'jsmith', displayName: 'John Smith' },
        items: [item],
      },
    ] as JiraHistory[]);
    expect(rows[0]?.to).toBe('x');
  });
});

describe('matchesField', () => {
  it('matches without a fieldId only by display name', () => {
    const item = { field: 'Team', from: null, fromString: null, to: null, toString: null };
    expect(matchesField(item, 'team')).toBe(true);
    expect(matchesField(item, 'team', ALIASES)).toBe(true);
    expect(matchesField(item, 'customfield_10001', ALIASES)).toBe(false);
  });

  it('matches a system field by its id or edit-screen name when Jira sends only the history name', () => {
    const item = (field: string) => ({
      field,
      from: null,
      fromString: null,
      to: null,
      toString: null,
    });
    for (const wanted of ['components', 'Components', 'Component/s', 'Component']) {
      expect(matchesField(item('Component'), wanted)).toBe(true);
    }
    for (const wanted of ['fixVersions', 'Fix Version/s', 'Fix Version']) {
      expect(matchesField(item('Fix Version'), wanted)).toBe(true);
    }
    for (const wanted of ['versions', 'Affects Version/s']) {
      expect(matchesField(item('Version'), wanted)).toBe(true);
    }
    expect(matchesField(item('Link'), 'issuelinks')).toBe(true);
    // Each name belongs to one field: affects versions are not fix versions.
    expect(matchesField(item('Fix Version'), 'versions')).toBe(false);
    expect(matchesField(item('Version'), 'fixVersions')).toBe(false);
    expect(matchesField(item('Component'), 'labels')).toBe(false);
    expect(matchesField(item('constructor'), 'components')).toBe(false);
  });

  it('trusts a fieldId over the history name', () => {
    const named = (field: string, fieldId: string) => ({
      field,
      fieldId,
      from: null,
      fromString: null,
      to: null,
      toString: null,
    });
    expect(matchesField(named('Component', 'components'), 'Component/s')).toBe(true);
    expect(matchesField(named('Fix Version', 'fixVersions'), 'fixVersions')).toBe(true);
    // A custom field called "Component" is not the components field.
    expect(matchesField(named('Component', 'customfield_123'), 'components')).toBe(false);
    expect(matchesField(named('Component', 'customfield_123'), 'Component/s')).toBe(false);
    expect(matchesField(named('Component', 'customfield_123'), 'Component')).toBe(true);
  });
});

describe('matchesField without field ids', () => {
  const team = { field: 'Owning Team', from: null, fromString: null, to: null, toString: null };
  const NAMES = { customfield_10001: 'Owning Team', customfield_10002: 'Squad' };

  it('matches an alias or a customfield id through the field name when the item has no fieldId', () => {
    for (const wanted of ['team', 'TEAM', 'customfield_10001', 'CustomField_10001']) {
      expect(matchesField(team, wanted, ALIASES, NAMES)).toBe(true);
    }
    expect(matchesField(team, 'customfield_10002', ALIASES, NAMES)).toBe(false);
    // Without the instance's names there is nothing to compare, as before.
    expect(matchesField(team, 'team', ALIASES)).toBe(false);
    expect(matchesField(team, 'customfield_10001')).toBe(false);
  });

  it('lets a fieldId decide over a matching name', () => {
    const other = { ...team, fieldId: 'customfield_10002' };
    expect(matchesField(other, 'team', ALIASES, NAMES)).toBe(false);
    expect(matchesField(other, 'customfield_10002', ALIASES, NAMES)).toBe(true);
  });

  it('resolves an alias to a system field through its history name', () => {
    const status = { field: 'status', from: null, fromString: null, to: null, toString: null };
    const component = { ...status, field: 'Component' };
    const aliases = { st: 'status', comp: 'components' };
    expect(matchesField(status, 'st', aliases)).toBe(true);
    expect(matchesField(component, 'comp', aliases)).toBe(true);
  });

  it('never reads a field name from the prototype', () => {
    const odd = { ...team, field: 'function Object() { [native code] }' };
    expect(matchesField(odd, 'constructor', { constructor: 'constructor' }, {})).toBe(false);
  });
});

describe('changelogNeedsFieldNames', () => {
  const withIds: JiraHistory[] = HISTORIES;
  const withoutIds: JiraHistory[] = [
    {
      id: '3',
      created: '2026-09-04T09:00:00.000+0300',
      items: [{ field: 'Owning Team', from: null, fromString: null, to: null, toString: 'Web' }],
    },
  ];

  it('asks for names only for a custom-field filter and items without fieldId', () => {
    expect(changelogNeedsFieldNames(withoutIds, ['team'], ALIASES)).toBe(true);
    expect(changelogNeedsFieldNames(withoutIds, ['customfield_10001'], {})).toBe(true);
    expect(changelogNeedsFieldNames(withoutIds, ['status', 'Owning Team'], ALIASES)).toBe(false);
    expect(changelogNeedsFieldNames(withIds, ['team'], ALIASES)).toBe(false);
  });

  it('matches through the names once they are fetched', () => {
    const { fieldNames, warnings } = changelogFieldNames(
      [{ id: 'customfield_10001', name: 'Owning Team', custom: true }],
      ['team'],
      ALIASES
    );
    expect(warnings).toEqual([]);
    expect(
      flattenChangelog(withoutIds, { aliases: ALIASES, fields: ['team'], fieldNames })
    ).toHaveLength(1);
  });
});

describe('changelogFieldNames', () => {
  it('warns about a filter field the instance lacks and about a shared display name', () => {
    const defs = [
      { id: 'customfield_10001', name: 'Owning Team', custom: true },
      { id: 'customfield_10003', name: 'owning team', custom: true },
    ];
    expect(
      changelogFieldNames(defs, ['team', 'customfield_10009', 'status'], ALIASES).warnings
    ).toEqual([
      'team → customfield_10001 is called "Owning Team", like customfield_10003; changes without a field id match all of them',
      'customfield_10009 is not a field on this instance',
    ]);
  });
});

describe('sinceToJql', () => {
  const now = new Date('2026-09-04T10:00:00.000Z');
  it('passes a relative form through and turns an absolute one into minutes', () => {
    expect(sinceToJql(parseSince('1d', now), now)).toBe('-1d');
    expect(sinceToJql(parseSince('-2h', now), now)).toBe('-2h');
    // One minute of slack covers clock skew; the exact cut is client-side anyway.
    expect(sinceToJql(parseSince('2026-09-03T10:00:00Z', now), now)).toBe('-1441m');
    expect(sinceToJql(parseSince('2026-09-04T10:00:00Z', now), now)).toBe('-1m');
  });
});
