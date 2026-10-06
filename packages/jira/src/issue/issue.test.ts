import { describe, expect, it } from 'vitest';
import type { JiraIssue } from '../client/types.js';
import { fieldPolicy } from '../fields/policy.js';
import { buildIssueCache, issueFileState } from './cache.js';
import { fieldChangeToApi, frontmatterChanges, frontmatterDiff } from './diff.js';
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

const POLICY = fieldPolicy({ team: { id: 'customfield_10001', editable: true } });
const ALIASES = POLICY.aliases;

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

const OPTS = { baseUrl: 'https://jira.example.internal', fetchedAt: 't' };

describe('issueToFrontmatter', () => {
  it('produces the shape: editable keys and aliases, read-only custom fields, readonly, counts', () => {
    const { frontmatter, comments, fieldSchema, formats } = issueToFrontmatter(ISSUE, POLICY, {
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
      readonly: {
        id: '40213',
        status: 'In Progress',
        reporter: 'jdoe',
        created: '2026-08-30T09:12:44.000+0300',
        updated: '2026-09-03T14:02:10.000+0300',
        url: 'https://jira.example.internal/browse/PROJ-123',
        customfield_10005: 3,
        customfield_10008: 'jdoe',
      },
      counts: { comments: 7, attachments: 2, links: 1 },
      lassi: { fetchedAt: '2026-09-04T10:00:00+0300', product: 'jira', schema: 1 },
    });
    expect(comments).toEqual({
      'readonly.customfield_10005': 'Story Points',
      'readonly.customfield_10008': 'Approver',
    });
    expect(Object.keys(fieldSchema)).toEqual([
      'customfield_10001',
      'customfield_10005',
      'customfield_10008',
    ]);
    expect(formats).toEqual({});
  });

  it('keeps aliased fields present even when empty', () => {
    const bare: JiraIssue = { id: '1', key: 'PROJ-1', fields: { summary: 'x' } };
    const { frontmatter } = issueToFrontmatter(bare, POLICY, OPTS);
    expect(frontmatter.team).toBeNull();
    expect(frontmatter.priority).toBeNull();
    expect(frontmatter.labels).toEqual([]);
    expect('components' in frontmatter).toBe(false);
  });

  it('puts a string alias of a custom field under readonly, after the built-in facts', () => {
    const policy = fieldPolicy({
      points: 'customfield_10005',
      team: { id: 'customfield_10001' },
      owner: { id: 'customfield_10009' },
    });
    const { frontmatter, comments } = issueToFrontmatter(ISSUE, policy, OPTS);
    expect('points' in frontmatter).toBe(false);
    expect('team' in frontmatter).toBe(false);
    expect(Object.keys(frontmatter.readonly)).toEqual([
      'id',
      'status',
      'reporter',
      'created',
      'updated',
      'url',
      'points',
      'team',
      'owner',
      'customfield_10008',
    ]);
    expect(frontmatter.readonly).toMatchObject({ points: 3, team: 'Platform', owner: null });
    expect(comments).toEqual({ 'readonly.customfield_10008': 'Approver' });
  });

  it('leaves an excluded field out entirely, rather than showing it as an unaliased field', () => {
    const policy = fieldPolicy({
      team: { id: 'customfield_10001', editable: true },
      development: { id: 'customfield_10005', exclude: true },
    });
    const { frontmatter, comments, fieldSchema } = issueToFrontmatter(ISSUE, policy, OPTS);
    expect('development' in frontmatter).toBe(false);
    expect('development' in frontmatter.readonly).toBe(false);
    expect('customfield_10005' in frontmatter.readonly).toBe(false);
    expect(comments).toEqual({ 'readonly.customfield_10008': 'Approver' });
    expect('customfield_10005' in fieldSchema).toBe(false);
  });

  it('keeps wiki markup verbatim unless the field opts into the wiki format', () => {
    const markup = 'h1. Title\n*bold* text';
    const issue: JiraIssue = {
      id: '1',
      key: 'PROJ-1',
      fields: { summary: 'x', customfield_10020: markup, customfield_10021: 'Plain words' },
      schema: { customfield_10020: { type: 'string' }, customfield_10021: { type: 'string' } },
    };
    const raw = issueToFrontmatter(
      issue,
      fieldPolicy({
        lastComment: { id: 'customfield_10020', format: 'raw' },
        plain: { id: 'customfield_10021' },
      }),
      OPTS
    );
    expect(raw.frontmatter.readonly).toMatchObject({ lastComment: markup, plain: 'Plain words' });
    expect(raw.formats).toEqual({});

    const wiki = issueToFrontmatter(
      issue,
      fieldPolicy({
        lastComment: { id: 'customfield_10020', format: 'wiki', editable: true },
        plain: { id: 'customfield_10021', format: 'wiki' },
      }),
      OPTS
    );
    expect(wiki.frontmatter['lastComment']).toBe('# Title\n\n**bold** text');
    expect(wiki.frontmatter.readonly).toMatchObject({ plain: 'Plain words' });
    expect(wiki.formats).toEqual({ customfield_10020: 'wiki', customfield_10021: 'wiki' });
  });

  it('shows an empty wiki field as it is, and still records its format for a later edit', () => {
    const issue: JiraIssue = { id: '1', key: 'PROJ-1', fields: { summary: 'x' } };
    const { frontmatter, formats } = issueToFrontmatter(
      issue,
      fieldPolicy({ lastComment: { id: 'customfield_10020', format: 'wiki' } }),
      OPTS
    );
    expect(frontmatter.readonly['lastComment']).toBeNull();
    expect(formats).toEqual({ customfield_10020: 'wiki' });
  });
});

describe('frontmatterDiff', () => {
  const { frontmatter, fieldSchema } = issueToFrontmatter(ISSUE, POLICY, OPTS);
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
      priority: 'Low',
    };
    const result = frontmatterDiff(
      cache,
      { editable: edited, readonly: cache.readonly, body: cache.descriptionMarkdown },
      POLICY
    );
    expect(result.fields).toEqual({
      summary: 'New summary',
      assignee: null,
      customfield_10001: { value: 'Web' },
      priority: { name: 'Low' },
    });
    expect(result.changedKeys).toEqual(['summary', 'priority', 'assignee', 'team']);
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
      POLICY,
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
        POLICY,
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
        POLICY
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
      POLICY
    );
    expect(result.fields).toEqual({
      issuetype: { name: 'Task' },
      components: [{ name: 'UI' }, { name: 'API' }],
    });
  });
});

describe('frontmatterChanges / fieldChangeToApi', () => {
  const { frontmatter, fieldSchema } = issueToFrontmatter(ISSUE, POLICY, OPTS);
  const cache = buildIssueCache(ISSUE, frontmatter, '', fieldSchema, ALIASES);

  it('lists changed fields with the schema known without fetching metadata', () => {
    const { changes } = frontmatterChanges(
      cache,
      { editable: { ...cache.editable, team: 'Web', labels: ['x'] }, body: '' },
      POLICY
    );
    expect(changes).toEqual([
      { key: 'labels', id: 'labels', value: ['x'], schema: { type: 'array', items: 'string' } },
      {
        key: 'team',
        id: 'customfield_10001',
        value: 'Web',
        schema: { type: 'option', custom: 'select' },
      },
    ]);
  });

  it('refuses every changed key the policy keeps read-only, in one error', () => {
    // An old-layout file had custom fields at the top level; editing one now is refused too.
    expect(() =>
      frontmatterChanges(
        cache,
        {
          editable: { ...cache.editable, customfield_10005: 5, customfield_10077: 'y' },
          body: '',
        },
        POLICY
      )
    ).toThrow(
      expect.objectContaining({
        code: 'usage',
        message: 'read-only fields: customfield_10005, customfield_10077',
        errors: {
          customfield_10005: 'read-only in jira.fields',
          customfield_10077: 'read-only in jira.fields',
        },
        context: expect.objectContaining({ issueKey: 'PROJ-123', operation: 'update' }),
      })
    );
  });

  it('accepts a raw id at the top level when an entry makes its field editable', () => {
    const policy = fieldPolicy({
      team: { id: 'customfield_10001', editable: true },
      points: { id: 'customfield_10005', editable: true },
    });
    const { changes } = frontmatterChanges(
      cache,
      { editable: { ...cache.editable, customfield_10005: 5 }, body: '' },
      policy
    );
    expect(changes.map((c) => [c.key, c.id, c.value])).toEqual([
      ['customfield_10005', 'customfield_10005', 5],
    ]);
  });

  it('warns about, and ignores, an edit to a read-only custom field under readonly', () => {
    const { changes, warnings } = frontmatterChanges(
      cache,
      {
        editable: cache.editable,
        readonly: { ...cache.readonly, customfield_10005: 8 },
        body: '',
      },
      POLICY
    );
    expect(changes).toEqual([]);
    expect(warnings).toEqual(['readonly.customfield_10005 was edited; ignored']);
  });

  it('frontmatterDiff sends a Markdown edit of a wiki field as wiki markup', () => {
    const policy = fieldPolicy({ notes: { id: 'customfield_10020', editable: true } });
    const wikiCache = {
      ...cache,
      editable: { ...cache.editable, notes: '**old**' },
      formats: { customfield_10020: 'wiki' as const },
    };
    const result = frontmatterDiff(
      wikiCache,
      { editable: { ...wikiCache.editable, notes: '# New\n\n**bold** and `code`' }, body: '' },
      policy
    );
    expect(result.fields).toEqual({ customfield_10020: 'h1. New\n\n*bold* and {{code}}\n' });
    expect(result.changedKeys).toEqual(['notes']);
  });

  it('marks a change to a field the file showed as Markdown', () => {
    const policy = fieldPolicy({ notes: { id: 'customfield_10020', editable: true } });
    const wikiCache = {
      ...cache,
      editable: { ...cache.editable, notes: '**old**' },
      formats: { customfield_10020: 'wiki' as const },
    };
    const { changes } = frontmatterChanges(
      wikiCache,
      { editable: { ...wikiCache.editable, notes: '**new**' }, body: '' },
      policy
    );
    expect(changes).toEqual([
      { key: 'notes', id: 'customfield_10020', value: '**new**', wiki: true },
    ]);
    expect(issueFileState(wikiCache).formats).toEqual({ customfield_10020: 'wiki' });
  });

  it('converts with the metadata when given, and without it by the recorded schema', () => {
    const change = {
      key: 'team',
      id: 'customfield_10001',
      value: 'web',
      schema: { type: 'option' },
    };
    expect(fieldChangeToApi(change, 'PROJ-123')).toEqual({ value: 'web' });
    const meta = {
      fieldId: 'customfield_10001',
      name: 'Team',
      required: false,
      schema: { type: 'option' },
      allowedValues: [{ value: 'Web' }],
    };
    expect(fieldChangeToApi(change, 'PROJ-123', meta)).toEqual({ value: 'Web' });
    expect(() => fieldChangeToApi({ ...change, value: 'Mobile' }, 'PROJ-123', meta)).toThrow(
      expect.objectContaining({
        code: 'validation',
        context: expect.objectContaining({ issueKey: 'PROJ-123', operation: 'update' }),
      })
    );
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
