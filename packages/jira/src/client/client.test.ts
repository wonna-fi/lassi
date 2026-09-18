import { PassThrough } from 'node:stream';
import { fakeFetch, type Route } from '@wonna/lassi-core/testing';
import { describe, expect, it } from 'vitest';
import { createJiraClient } from './index.js';
import { resolveLinkDirection } from './links.js';
import { resolveTransition } from './transitions.js';
import type { JiraLinkType, JiraTransition } from './types.js';

const BASE = 'https://jira.example.internal';

function client(routes: Route[]) {
  const fetch = fakeFetch(routes);
  const c = createJiraClient({
    baseUrl: BASE,
    token: 'pat-token-1234',
    fetch,
    random: () => 0,
    sleep: async () => {},
  });
  return { c, fetch };
}

const PAGINATED_TYPES = {
  path: '/rest/api/2/issue/createmeta/PROJ/issuetypes',
  json: {
    values: [
      { id: '10001', name: 'Bug', subtask: false },
      { id: '10002', name: 'Task', subtask: false },
    ],
    total: 2,
  },
};
const BUG_FIELDS = {
  path: '/rest/api/2/issue/createmeta/PROJ/issuetypes/10001',
  json: {
    values: [
      { fieldId: 'summary', name: 'Summary', required: true, schema: { type: 'string' } },
      {
        fieldId: 'customfield_10001',
        name: 'Team',
        required: true,
        schema: { type: 'option', custom: 'select' },
        allowedValues: [
          { id: '1', value: 'Platform' },
          { id: '2', value: 'Web' },
        ],
      },
    ],
    total: 2,
  },
};

describe('createJiraClient', () => {
  it('fetches issues with the default expands and validates keys', async () => {
    const { c, fetch } = client([
      { path: '/rest/api/2/issue/PROJ-1', json: { id: '1', key: 'PROJ-1', fields: {} } },
    ]);
    await c.getIssue('PROJ-1');
    expect(fetch.calls[0]?.url.search).toBe('?fields=*all&expand=names%2Cschema');
    await expect(c.getIssue('proj-1')).rejects.toMatchObject({ code: 'usage' });
    expect(c.browseUrl('PROJ-1')).toBe(`${BASE}/browse/PROJ-1`);
  });

  it('changelog() fetches summary and status with the changelog expand and flags truncation', async () => {
    const { c, fetch } = client([
      {
        path: '/rest/api/2/issue/PROJ-1',
        json: {
          id: '1',
          key: 'PROJ-1',
          fields: { summary: 'S', status: { name: 'Open' } },
          changelog: {
            startAt: 0,
            maxResults: 1,
            total: 3,
            histories: [{ id: '1', created: 'x', items: [] }],
          },
        },
      },
    ]);
    const log = await c.changelog('PROJ-1');
    expect(fetch.calls[0]?.url.search).toBe('?fields=summary%2Cstatus&expand=changelog');
    expect(log).toMatchObject({
      key: 'PROJ-1',
      summary: 'S',
      status: 'Open',
      total: 3,
      truncated: true,
    });
    expect(log.histories).toHaveLength(1);
  });

  it('searches with POST and drains pages until short, capping at the limit', async () => {
    const page = (start: number, size: number, total: number) => ({
      issues: Array.from({ length: size }, (_, i) => ({
        id: String(start + i),
        key: `PROJ-${start + i}`,
        fields: {},
      })),
      total,
      startAt: start,
      maxResults: size,
    });
    const { c, fetch } = client([
      {
        method: 'POST',
        path: '/rest/api/2/search',
        handler: (call) => {
          const body = JSON.parse(call.bodyText ?? '{}') as { startAt: number; maxResults: number };
          return { json: page(body.startAt, Math.min(body.maxResults, 7 - body.startAt), 7) };
        },
      },
    ]);
    const all = await c.searchAll({ jql: 'project = PROJ', pageSize: 3 });
    expect(all.issues.map((i) => i.key)).toEqual([
      'PROJ-0',
      'PROJ-1',
      'PROJ-2',
      'PROJ-3',
      'PROJ-4',
      'PROJ-5',
      'PROJ-6',
    ]);
    expect(all.truncated).toBe(false);
    expect(fetch.calls).toHaveLength(3);
    expect(JSON.parse(fetch.calls[0]?.bodyText ?? '')).toEqual({
      jql: 'project = PROJ',
      startAt: 0,
      maxResults: 3,
    });

    const capped = await c.searchAll({ jql: 'project = PROJ', pageSize: 3, cap: 4 });
    expect(capped.issues).toHaveLength(4);
    expect(capped.truncated).toBe(true);
  });

  it('uses paginated createmeta, memoises, and reports the mode', async () => {
    const { c, fetch } = client([PAGINATED_TYPES, BUG_FIELDS]);
    expect(c.createmetaMode()).toBe('unknown');
    const meta = await c.createmeta('PROJ', 'bug');
    expect(meta.mode).toBe('paginated');
    expect(meta.issueTypes).toHaveLength(1);
    expect(meta.issueTypes[0]?.fields['customfield_10001']?.required).toBe(true);
    expect(c.createmetaMode()).toBe('paginated');
    await c.createmeta('PROJ', 'Bug');
    expect(fetch.calls).toHaveLength(2);
    await expect(c.createmeta('PROJ', 'Epic')).rejects.toMatchObject({
      code: 'validation',
      message: 'issue type "Epic" is not available in PROJ; available: Bug, Task',
    });
  });

  it('falls back to legacy createmeta on 404 and stays there', async () => {
    const { c, fetch } = client([
      {
        path: /\/rest\/api\/2\/issue\/createmeta\/PROJ\/issuetypes/,
        status: 404,
        text: 'not here',
      },
      {
        path: '/rest/api/2/issue/createmeta',
        json: {
          projects: [
            {
              id: '1',
              key: 'PROJ',
              name: 'Project',
              issuetypes: [
                {
                  id: '10001',
                  name: 'Bug',
                  fields: {
                    summary: { name: 'Summary', required: true, schema: { type: 'string' } },
                  },
                },
              ],
            },
          ],
        },
      },
    ]);
    const meta = await c.createmeta('PROJ', 'Bug');
    expect(meta.mode).toBe('legacy');
    expect(meta.issueTypes[0]?.fields['summary']?.fieldId).toBe('summary');
    expect(fetch.calls[1]?.url.search).toBe(
      '?projectKeys=PROJ&issuetypeNames=Bug&expand=projects.issuetypes.fields'
    );
    await c.createmeta('PROJ', 'Task').catch(() => undefined);
    expect(fetch.calls.filter((call) => call.url.pathname.includes('/issuetypes'))).toHaveLength(1);
    expect(c.createmetaMode()).toBe('legacy');
  });

  it('lists issue types without fetching field metadata', async () => {
    const { c, fetch } = client([PAGINATED_TYPES]);
    const list = await c.issueTypes('PROJ');
    expect(list).toMatchObject({ mode: 'paginated', project: { key: 'PROJ' } });
    expect(list.issueTypes.map((t) => t.name)).toEqual(['Bug', 'Task']);
    expect(fetch.calls).toHaveLength(1);
    expect(c.createmetaMode()).toBe('paginated');
  });

  it('lists issue types through the legacy form without the fields expand', async () => {
    const { c, fetch } = client([
      { path: /\/rest\/api\/2\/issue\/createmeta\/PROJ\/issuetypes/, status: 404, text: 'no' },
      {
        path: '/rest/api/2/issue/createmeta',
        json: {
          projects: [
            { id: '1', key: 'PROJ', name: 'Project', issuetypes: [{ id: '10001', name: 'Bug' }] },
          ],
        },
      },
    ]);
    const list = await c.issueTypes('PROJ');
    expect(list.mode).toBe('legacy');
    expect(list.project).toEqual({ id: '1', key: 'PROJ', name: 'Project' });
    expect(list.issueTypes).toEqual([{ id: '10001', name: 'Bug', subtask: false }]);
    expect(fetch.calls[1]?.url.search).toBe('?projectKeys=PROJ');
    expect(c.createmetaMode()).toBe('legacy');
  });

  it('does not mistake a missing project for a missing paginated endpoint', async () => {
    const { c, fetch } = client([
      {
        path: '/rest/api/2/issue/createmeta/NOPE/issuetypes',
        status: 404,
        json: { errorMessages: ["Project 'NOPE' not found"] },
      },
      { path: '/rest/api/2/issue/createmeta', json: { projects: [] } },
      PAGINATED_TYPES,
    ]);
    await expect(c.issueTypes('NOPE')).rejects.toMatchObject({
      code: 'not_found',
      message: 'project NOPE not found or not creatable',
    });
    expect(c.createmetaMode()).toBe('unknown');
    const list = await c.issueTypes('PROJ');
    expect(list.mode).toBe('paginated');
    expect(fetch.calls).toHaveLength(3);
  });

  it('reports the paginated 404 when the legacy form is gone as well', async () => {
    const { c } = client([
      {
        path: '/rest/api/2/issue/createmeta/NOPE/issuetypes',
        status: 404,
        json: { errorMessages: ["Project 'NOPE' not found"] },
      },
      { path: '/rest/api/2/issue/createmeta', status: 404, text: 'gone' },
    ]);
    await expect(c.createmeta('NOPE', 'Bug')).rejects.toMatchObject({
      code: 'not_found',
      http: 404,
      message: expect.stringContaining('NOPE'),
    });
    expect(c.createmetaMode()).toBe('unknown');
  });

  it('creates and updates issues and edits comments, carrying the create facts for hints', async () => {
    const { c, fetch } = client([
      { method: 'POST', path: '/rest/api/2/issue', json: { id: '1', key: 'PROJ-9' } },
      { method: 'PUT', path: '/rest/api/2/issue/PROJ-9', status: 204 },
      { method: 'PUT', path: '/rest/api/2/issue/PROJ-9/comment/5', json: { id: '5', body: 'b' } },
    ]);
    const created = await c.createIssue({ summary: 'x' }, { project: 'PROJ', issueType: 'Bug' });
    expect(created.key).toBe('PROJ-9');
    expect(JSON.parse(fetch.calls[0]?.bodyText ?? '')).toEqual({ fields: { summary: 'x' } });
    await c.updateIssue('PROJ-9', { fields: { summary: 'y' } });
    expect(fetch.calls[1]?.method).toBe('PUT');
    expect(JSON.parse(fetch.calls[1]?.bodyText ?? '')).toEqual({ fields: { summary: 'y' } });
    const edited = await c.editComment('PROJ-9', '5', 'b');
    expect(edited.id).toBe('5');
    expect(JSON.parse(fetch.calls[2]?.bodyText ?? '')).toEqual({ body: 'b' });
  });

  it('attaches project and issue type to a rejected create', async () => {
    const { c } = client([
      {
        method: 'POST',
        path: '/rest/api/2/issue',
        status: 400,
        json: { errorMessages: [], errors: { customfield_10001: 'Team is required.' } },
      },
    ]);
    await expect(c.createIssue({}, { project: 'PROJ', issueType: 'Bug' })).rejects.toMatchObject({
      code: 'validation',
      http: 400,
      errors: { customfield_10001: 'Team is required.' },
      context: { project: 'PROJ', issueType: 'Bug', operation: 'create' },
    });
  });

  it('normalises editmeta and lists fields', async () => {
    const { c } = client([
      {
        path: '/rest/api/2/issue/PROJ-1/editmeta',
        json: {
          fields: { summary: { name: 'Summary', required: true, schema: { type: 'string' } } },
        },
      },
      { path: '/rest/api/2/field', json: [{ id: 'summary', name: 'Summary', custom: false }] },
    ]);
    expect((await c.editmeta('PROJ-1'))['summary']?.fieldId).toBe('summary');
    expect(await c.fields()).toEqual([{ id: 'summary', name: 'Summary', custom: false }]);
  });

  it('lists comments newest-first when asked and posts wiki bodies verbatim', async () => {
    const { c, fetch } = client([
      {
        method: 'GET',
        path: '/rest/api/2/issue/PROJ-1/comment',
        json: {
          comments: [
            { id: '2', body: 'b', created: '2' },
            { id: '1', body: 'a', created: '1' },
          ],
          total: 2,
          startAt: 0,
          maxResults: 5,
        },
      },
      {
        method: 'POST',
        path: '/rest/api/2/issue/PROJ-1/comment',
        status: 201,
        json: { id: '3', body: 'h3. x', created: '3' },
      },
      { method: 'DELETE', path: '/rest/api/2/issue/PROJ-1/comment/3', status: 204 },
    ]);
    const page = await c.listComments('PROJ-1', { limit: 5, newest: true });
    expect(page.comments.map((x) => x.id)).toEqual(['1', '2']);
    expect(fetch.calls[0]?.url.search).toBe('?startAt=0&maxResults=5&orderBy=-created');
    expect((await c.addComment('PROJ-1', 'h3. x')).id).toBe('3');
    expect(fetch.calls[1]?.bodyText).toBe('{"body":"h3. x"}');
    await c.deleteComment('PROJ-1', '3');
    expect(fetch.calls[2]?.method).toBe('DELETE');
  });

  it('lists transitions with screen fields and posts transition + comment', async () => {
    const { c, fetch } = client([
      {
        method: 'GET',
        path: '/rest/api/2/issue/PROJ-1/transitions',
        json: {
          transitions: [
            {
              id: '31',
              name: 'Done',
              to: { name: 'Done' },
              fields: {
                resolution: { name: 'Resolution', required: true, schema: { type: 'resolution' } },
              },
            },
          ],
        },
      },
      { method: 'POST', path: '/rest/api/2/issue/PROJ-1/transitions', status: 204 },
    ]);
    const list = await c.listTransitions('PROJ-1');
    expect(list[0]).toMatchObject({ id: '31', hasScreen: true });
    expect(list[0]?.fields['resolution']?.fieldId).toBe('resolution');
    await c.doTransition('PROJ-1', {
      id: '31',
      fields: { resolution: { name: 'Fixed' } },
      commentBody: 'done',
    });
    expect(JSON.parse(fetch.calls[1]?.bodyText ?? '')).toEqual({
      transition: { id: '31' },
      fields: { resolution: { name: 'Fixed' } },
      update: { comment: [{ add: { body: 'done' } }] },
    });
  });

  it('downloads attachments through the absolute content URL with MIME fallback and size cap', async () => {
    const att = {
      id: '7',
      filename: 'a.bin',
      mimeType: 'image/png',
      size: 3,
      content: `${BASE}/secure/attachment/7/a.bin`,
    };
    const { c, fetch } = client([
      {
        path: '/secure/attachment/7/a.bin',
        bytes: new Uint8Array([1, 2, 3]),
        headers: { 'content-type': 'application/octet-stream' },
      },
    ]);
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (d: Buffer) => chunks.push(d));
    const result = await c.downloadAttachment(att, sink, { maxBytes: 1000 });
    expect(result).toEqual({ status: 'saved', bytes: 3, mimeType: 'image/png' });
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([1, 2, 3]));
    expect(fetch.calls[0]?.headers.authorization).toBe('Bearer pat-token-1234');

    expect(
      await c.downloadAttachment({ ...att, size: 5000 }, new PassThrough(), { maxBytes: 1000 })
    ).toEqual({ status: 'skipped', reason: 'size', size: 5000, maxBytes: 1000 });
    expect(fetch.calls).toHaveLength(1);

    await expect(
      c.downloadAttachment({ ...att, size: 1 }, new PassThrough(), { maxBytes: 2 })
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('uploads attachments as multipart with the no-check header', async () => {
    const { c, fetch } = client([
      {
        method: 'POST',
        path: '/rest/api/2/issue/PROJ-1/attachments',
        json: [{ id: '9', filename: 'n.txt', mimeType: 'text/plain', size: 5, content: 'x' }],
      },
    ]);
    const result = await c.uploadAttachment('PROJ-1', {
      data: 'hello',
      filename: 'n.txt',
      contentType: 'text/plain',
    });
    expect(result[0]?.id).toBe('9');
    expect(fetch.calls[0]?.headers['x-atlassian-token']).toBe('no-check');
    const file = fetch.calls[0]?.form?.get('file');
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('n.txt');
  });

  it('normalises issue links and creates links with the resolved direction', async () => {
    const { c, fetch } = client([
      {
        path: '/rest/api/2/issueLinkType',
        json: {
          issueLinkTypes: [{ id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }],
        },
      },
      {
        path: '/rest/api/2/issue/PROJ-1',
        json: {
          id: '1',
          key: 'PROJ-1',
          fields: {
            issuelinks: [
              {
                id: '10',
                type: { id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
                outwardIssue: {
                  id: '2',
                  key: 'PROJ-2',
                  fields: { summary: 'S2', status: { name: 'Open' } },
                },
              },
              {
                id: '11',
                type: { id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
                inwardIssue: { id: '3', key: 'PROJ-3' },
              },
            ],
          },
        },
      },
      { method: 'POST', path: '/rest/api/2/issueLink', status: 201 },
    ]);
    expect(await c.getLinkTypes()).toHaveLength(1);
    expect(await c.listLinks('PROJ-1')).toEqual([
      {
        id: '10',
        typeName: 'Blocks',
        direction: 'outward',
        description: 'blocks',
        otherKey: 'PROJ-2',
        otherSummary: 'S2',
        otherStatus: 'Open',
      },
      {
        id: '11',
        typeName: 'Blocks',
        direction: 'inward',
        description: 'is blocked by',
        otherKey: 'PROJ-3',
      },
    ]);
    await c.createLink({ typeName: 'Blocks', outwardKey: 'PROJ-1', inwardKey: 'PROJ-2' });
    expect(JSON.parse(fetch.calls[2]?.bodyText ?? '')).toEqual({
      type: { name: 'Blocks' },
      outwardIssue: { key: 'PROJ-1' },
      inwardIssue: { key: 'PROJ-2' },
    });
  });

  it('validates mentions with a cache and bounded concurrency', async () => {
    const { c, fetch } = client([
      {
        path: '/rest/api/2/user',
        handler: (call) =>
          call.url.searchParams.get('username') === 'jsmith'
            ? { json: { name: 'jsmith', displayName: 'J' } }
            : { status: 404, json: { errorMessages: ['no'] } },
      },
    ]);
    expect(await c.validateMentions(['jsmith', 'ghost', 'jsmith'])).toEqual({
      known: ['jsmith'],
      unknown: ['ghost'],
    });
    expect(fetch.calls).toHaveLength(2);
    await c.validateMentions(['jsmith', 'ghost']);
    expect(fetch.calls).toHaveLength(2);
  });

  it('wraps an existing HttpClient', async () => {
    const { c: inner } = client([
      { path: '/rest/api/2/myself', json: { name: 'jsmith', displayName: 'J' } },
    ]);
    const wrapped = createJiraClient({ baseUrl: BASE, http: inner.http });
    expect((await wrapped.myself()).name).toBe('jsmith');
  });
});

describe('resolveLinkDirection', () => {
  const types: JiraLinkType[] = [
    { id: '1', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
    { id: '2', name: 'Relates', inward: 'relates to', outward: 'relates to' },
    { id: '3', name: 'Cloners', inward: 'is cloned by', outward: 'clones' },
  ];

  it('keeps direction for outward phrases and type names, flips for inward phrases', () => {
    expect(resolveLinkDirection(types, 'blocks', 'A-1', 'B-2')).toMatchObject({
      outwardKey: 'A-1',
      inwardKey: 'B-2',
      sentence: 'A-1 blocks B-2',
    });
    expect(resolveLinkDirection(types, 'Blocks', 'A-1', 'B-2').outwardKey).toBe('A-1');
    expect(resolveLinkDirection(types, 'is blocked by', 'A-1', 'B-2')).toMatchObject({
      outwardKey: 'B-2',
      inwardKey: 'A-1',
      sentence: 'A-1 is blocked by B-2',
    });
    expect(resolveLinkDirection(types, 'relates to', 'A-1', 'B-2').outwardKey).toBe('A-1');
  });

  it('reports misses and ambiguity', () => {
    expect(() => resolveLinkDirection(types, 'duplicates', 'A-1', 'B-2')).toThrow(
      /no link type matches/
    );
    const ambiguous = [...types, { id: '4', name: 'Other', inward: 'blocks', outward: 'x' }];
    expect(() => resolveLinkDirection(ambiguous, 'blocks', 'A-1', 'B-2')).toThrow(
      /several link types/
    );
  });
});

describe('resolveTransition', () => {
  const list: JiraTransition[] = [
    { id: '11', name: 'In Progress', to: { name: 'In Progress' }, fields: {}, hasScreen: false },
    { id: '31', name: 'Done', to: { name: 'Done' }, fields: {}, hasScreen: true },
  ];
  it('matches id, then case-insensitive name', () => {
    expect(resolveTransition(list, '31', 'PROJ-1').name).toBe('Done');
    expect(resolveTransition(list, 'in progress', 'PROJ-1').id).toBe('11');
    expect(() => resolveTransition(list, 'Closed', 'PROJ-1')).toThrow(
      /available: In Progress \(11\), Done \(31\)/
    );
  });
});
