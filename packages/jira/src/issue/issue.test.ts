import { describe, expect, it } from 'vitest';
import type { JiraIssue } from '../client/types.js';
import { buildIssueCache } from './cache.js';
import { frontmatterDiff } from './diff.js';
import {
  composeBody,
  expansionFromSections,
  joinSections,
  stripGeneratedSections,
  renderAttachments,
  renderComments,
  renderLinks,
  trailerLine,
} from './document.js';
import { issueToFrontmatter } from './frontmatter.js';

const ALIASES = { team: 'customfield_10001' };

const ISSUE: JiraIssue = {
  id: '40213',
  key: 'PROJ-123',
  fields: {
    summary: 'Login page throws 500 on empty password',
    description: 'h2. Steps\n# one\n# two',
    issuetype: { id: '1', name: 'Bug' },
    priority: { id: '2', name: 'High' },
    status: { name: 'In Progress' },
    assignee: { name: 'jsmith', displayName: 'John Smith' },
    reporter: { name: 'jdoe', displayName: 'Jane Doe' },
    labels: ['auth', 'regression'],
    components: [{ id: '10', name: 'UI' }],
    fixVersions: [],
    created: '2026-08-30T09:12:44.000+0300',
    updated: '2026-09-03T14:02:10.000+0300',
    comment: { comments: [], total: 7, startAt: 0, maxResults: 0 },
    attachment: [
      {
        id: '1',
        filename: 'a.png',
        mimeType: 'image/png',
        size: 2048,
        content: 'https://jira.example.internal/secure/attachment/1/a.png',
      },
      { id: '2', filename: 'b.txt', mimeType: 'text/plain', size: 10, content: 'x' },
    ],
    issuelinks: [
      {
        id: '1',
        type: { id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
        outwardIssue: { id: '2', key: 'PROJ-2' },
      },
    ],
    customfield_10001: { id: '1', value: 'Platform' },
    customfield_10005: 3,
    customfield_10006: null,
    customfield_10007: [],
    customfield_10008: { name: 'jdoe', displayName: 'Jane' },
  },
  names: { customfield_10005: 'Story Points', customfield_10008: 'Approver' },
  schema: {
    customfield_10001: { type: 'option', custom: 'select' },
    customfield_10005: { type: 'number' },
    customfield_10008: { type: 'user' },
  },
};

describe('issueToFrontmatter', () => {
  it('produces the shape: editable keys, aliases, non-empty unmapped fields, readonly, counts', () => {
    const { frontmatter, comments, fieldSchema } = issueToFrontmatter(ISSUE, ALIASES, {
      baseUrl: 'https://jira.example.internal',
      fetchedAt: '2026-09-04T10:00:00+0300',
    });
    expect(frontmatter).toEqual({
      key: 'PROJ-123',
      summary: 'Login page throws 500 on empty password',
      type: 'Bug',
      priority: 'High',
      assignee: 'jsmith',
      labels: ['auth', 'regression'],
      components: ['UI'],
      team: 'Platform',
      customfield_10005: 3,
      customfield_10008: 'jdoe',
      readonly: {
        id: '40213',
        status: 'In Progress',
        reporter: 'jdoe',
        created: '2026-08-30T09:12:44.000+0300',
        updated: '2026-09-03T14:02:10.000+0300',
        url: 'https://jira.example.internal/browse/PROJ-123',
      },
      counts: { comments: 7, attachments: 2, links: 1 },
      lassi: { fetchedAt: '2026-09-04T10:00:00+0300', product: 'jira', schema: 1 },
    });
    expect(comments).toEqual({ customfield_10005: 'Story Points', customfield_10008: 'Approver' });
    expect(Object.keys(fieldSchema)).toEqual([
      'customfield_10001',
      'customfield_10005',
      'customfield_10008',
    ]);
  });

  it('keeps aliased fields present even when empty', () => {
    const bare: JiraIssue = { id: '1', key: 'PROJ-1', fields: { summary: 'x' } };
    const { frontmatter } = issueToFrontmatter(bare, ALIASES, {
      baseUrl: 'https://jira.example.internal',
      fetchedAt: 't',
    });
    expect(frontmatter.team).toBeNull();
    expect(frontmatter.priority).toBeNull();
    expect(frontmatter.labels).toEqual([]);
    expect('components' in frontmatter).toBe(false);
  });
});

describe('frontmatterDiff', () => {
  const { frontmatter, fieldSchema } = issueToFrontmatter(ISSUE, ALIASES, {
    baseUrl: 'https://jira.example.internal',
    fetchedAt: 't',
  });
  const cache = buildIssueCache(
    ISSUE,
    frontmatter,
    '## Steps\n\n1. one\n2. two\n',
    fieldSchema,
    ALIASES
  );

  it('sends only changed keys, coerced by cached schema or the standard table', () => {
    const edited = {
      ...cache.editable,
      summary: 'New summary',
      labels: ['regression', 'auth'],
      assignee: null,
      team: 'Web',
      customfield_10005: 5,
      priority: 'Low',
    };
    const result = frontmatterDiff(
      cache,
      { editable: edited, readonly: cache.readonly, body: cache.descriptionMarkdown },
      ALIASES
    );
    expect(result.fields).toEqual({
      summary: 'New summary',
      assignee: null,
      customfield_10001: { value: 'Web' },
      customfield_10005: 5,
      priority: { name: 'Low' },
    });
    expect(result.changedKeys).toEqual([
      'summary',
      'priority',
      'assignee',
      'team',
      'customfield_10005',
    ]);
    expect(result.descriptionChanged).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it('warns on deleted keys and readonly edits, detects description changes, uses editmeta allowed values', () => {
    const edited = { ...cache.editable };
    delete edited['priority'];
    const result = frontmatterDiff(
      cache,
      {
        editable: { ...edited, team: 'Platform' },
        readonly: { ...cache.readonly, status: 'Done' },
        body: 'changed\n',
      },
      ALIASES,
      {
        customfield_10001: {
          fieldId: 'customfield_10001',
          name: 'Team',
          required: true,
          schema: { type: 'option' },
          allowedValues: [{ value: 'Platform' }, { value: 'Web' }],
        },
      }
    );
    expect(result.fields).toEqual({});
    expect(result.descriptionChanged).toBe(true);
    expect(result.warnings).toEqual([
      '"priority" was removed from the file; not sent (set `priority: null` to clear it)',
      'readonly.status was edited; ignored',
    ]);
    expect(() =>
      frontmatterDiff(
        cache,
        { editable: { ...cache.editable, team: 'Mobile' }, body: cache.descriptionMarkdown },
        ALIASES,
        {
          customfield_10001: {
            fieldId: 'customfield_10001',
            name: 'Team',
            required: true,
            schema: { type: 'option' },
            allowedValues: [{ value: 'Platform' }],
          },
        }
      )
    ).toThrow(expect.objectContaining({ code: 'validation' }));
    expect(() =>
      frontmatterDiff(
        cache,
        { editable: { ...cache.editable, nope: 1 }, body: cache.descriptionMarkdown },
        ALIASES
      )
    ).toThrow(expect.objectContaining({ code: 'usage' }));
  });

  it('type maps to issuetype and components to names', () => {
    const result = frontmatterDiff(
      cache,
      {
        editable: { ...cache.editable, type: 'Task', components: ['UI', 'API'] },
        body: cache.descriptionMarkdown,
      },
      ALIASES
    );
    expect(result.fields).toEqual({
      issuetype: { name: 'Task' },
      components: [{ name: 'UI' }, { name: 'API' }],
    });
  });
});

describe('document sections', () => {
  it('renders comments, attachments, links and the trailer', () => {
    expect(
      renderComments([
        {
          id: '5',
          body: 'h3. Root cause\nthe *dto*',
          created: '2026-09-01T10:00:00+0300',
          author: { name: 'jdoe', displayName: 'J' },
        },
      ])
    ).toBe(
      '## Comments\n\n### jdoe · 2026-09-01T10:00:00+0300 · id 5\n\n### Root cause\n\nthe **dto**\n'
    );
    expect(renderAttachments(ISSUE.fields.attachment ?? [])).toContain(
      '| a.png | 2.0 KB | image/png | 1 |'
    );
    expect(
      renderLinks('PROJ-123', [
        {
          id: '1',
          typeName: 'Blocks',
          direction: 'outward',
          description: 'blocks',
          otherKey: 'PROJ-2',
          otherSummary: 'S|2',
          otherStatus: 'Open',
        },
      ])
    ).toContain('| PROJ-123 blocks PROJ-2 | PROJ-2 | S\\|2 | Open |');
    expect(
      trailerLine(
        { comments: 7, attachments: 2, links: 3 },
        { comments: false, attachments: false, links: false }
      )
    ).toBe(
      '(7 comments, 2 attachments, 3 links not shown — use --comments, --attachments, --links or --all)'
    );
    expect(
      trailerLine(
        { comments: 1, attachments: 0, links: 0 },
        { comments: false, attachments: false, links: false }
      )
    ).toBe('(1 comment not shown — use --comments, --attachments, --links or --all)');
    expect(
      trailerLine(
        { comments: 1, attachments: 0, links: 0 },
        { comments: true, attachments: false, links: false }
      )
    ).toBeUndefined();
    expect(composeBody('desc\n\n', ['', '## Comments\n\nx\n'])).toBe('desc\n\n## Comments\n\nx\n');
    expect(composeBody('', [])).toBe('\n');
  });
});

describe('generated sections', () => {
  it('joins, strips and recognises the generated tail of a working file', () => {
    const parts = ['## Comments\n\nx\n', '', '## Links\n\n| a |\n'];
    const sections = joinSections(parts);
    expect(sections).toBe('## Comments\n\nx\n\n## Links\n\n| a |');
    const body = composeBody('# Desc\n\ntext', parts);
    expect(stripGeneratedSections(body, sections)).toBe('# Desc\n\ntext');
    expect(stripGeneratedSections(body, '')).toBe(body.trimEnd());
    expect(stripGeneratedSections('# Desc\n\nedited tail\n', sections)).toBeUndefined();
    expect(expansionFromSections(sections)).toEqual({
      comments: true,
      attachments: false,
      links: true,
    });
  });
});
