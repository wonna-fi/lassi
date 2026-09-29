import { describe, expect, it } from 'vitest';
import type { JiraFieldMeta, JiraIssueTypeMeta } from '../client/types.js';
import { aliasFor, fieldIdFor, resolveFieldAliases } from './aliases.js';
import { coerceFieldValue, isLiteralFieldValue, parseFieldArg, splitList } from './coerce.js';
import { buildCreateIssueFields, checkRequiredFields } from './create-fields.js';
import { EDITMETA_CACHE_TTL_MS, usableEditmetaCache } from './editmeta-cache.js';
import { apiValueToScalar, needsFieldMeta, scalarToApiValue, standardSchema } from './normalize.js';

const ALIASES = { team: 'customfield_10001', points: 'customfield_10002' };

describe('aliases', () => {
  it('maps aliases, raw ids and standard names; type → issuetype', () => {
    expect(fieldIdFor(ALIASES, 'team')).toBe('customfield_10001');
    expect(fieldIdFor(ALIASES, 'customfield_10009')).toBe('customfield_10009');
    expect(fieldIdFor(ALIASES, 'summary')).toBe('summary');
    expect(fieldIdFor(ALIASES, 'type')).toBe('issuetype');
    expect(fieldIdFor(ALIASES, 'bogus')).toBeUndefined();
    expect(resolveFieldAliases(ALIASES, { team: 'x', bogus: 1, labels: ['a'] })).toEqual({
      fields: { customfield_10001: 'x', labels: ['a'] },
      unknown: ['bogus'],
    });
    expect(aliasFor(ALIASES, 'customfield_10002')).toBe('points');
    expect(aliasFor(ALIASES, 'summary')).toBeUndefined();
  });
});

describe('apiValueToScalar', () => {
  it('flattens users, options, cascading options, named things and arrays', () => {
    expect(
      apiValueToScalar({ name: 'jsmith', displayName: 'J S', active: true }, { type: 'user' })
    ).toBe('jsmith');
    expect(apiValueToScalar({ name: 'jsmith', displayName: 'J S' })).toBe('jsmith');
    expect(apiValueToScalar({ id: '1', value: 'Platform' })).toBe('Platform');
    expect(apiValueToScalar({ value: 'A', child: { value: 'B' } })).toEqual({
      value: 'A',
      child: 'B',
    });
    expect(apiValueToScalar({ id: '3', name: 'High' }, { type: 'priority' })).toBe('High');
    expect(apiValueToScalar({ id: '1', key: 'PROJ', name: 'Project' }, { type: 'project' })).toBe(
      'PROJ'
    );
    expect(
      apiValueToScalar([{ name: 'UI' }, { name: 'API' }], { type: 'array', items: 'component' })
    ).toEqual(['UI', 'API']);
    expect(apiValueToScalar(3.5, { type: 'number' })).toBe(3.5);
    expect(apiValueToScalar(null)).toBeNull();
    expect(apiValueToScalar({ weird: true })).toEqual({ weird: true });
  });
});

describe('scalarToApiValue', () => {
  const option: JiraFieldMeta = {
    fieldId: 'customfield_10001',
    name: 'Team',
    required: true,
    schema: { type: 'option', custom: 'select' },
    allowedValues: [
      { id: '1', value: 'Platform' },
      { id: '2', value: 'Web' },
    ],
  };
  it('follows the schema table', () => {
    expect(scalarToApiValue('platform', option.schema, option)).toEqual({ value: 'Platform' });
    expect(() => scalarToApiValue('Mobile', option.schema, option)).toThrow(/not an allowed value/);
    expect(scalarToApiValue('jsmith', { type: 'user' })).toEqual({ name: 'jsmith' });
    expect(scalarToApiValue('High', { type: 'priority' })).toEqual({ name: 'High' });
    expect(scalarToApiValue('PROJ', { type: 'project' })).toEqual({ key: 'PROJ' });
    expect(scalarToApiValue(['a', 'b'], { type: 'array', items: 'string' })).toEqual(['a', 'b']);
    expect(scalarToApiValue(['UI'], { type: 'array', items: 'component' })).toEqual([
      { name: 'UI' },
    ]);
    expect(scalarToApiValue('7', { type: 'number' })).toBe(7);
    expect(scalarToApiValue(null, { type: 'user' })).toBeNull();
    expect(scalarToApiValue({ value: 'A', child: 'B' }, { type: 'option-with-child' })).toEqual({
      value: 'A',
      child: { value: 'B' },
    });
    expect(scalarToApiValue({ id: '5' }, { type: 'option' })).toEqual({ id: '5' });
    expect(scalarToApiValue('2026-09-04', { type: 'date' })).toBe('2026-09-04');
  });

  it('matches components and versions to ids when allowed values are known', () => {
    const comp: JiraFieldMeta = {
      fieldId: 'components',
      name: 'Components',
      required: false,
      schema: { type: 'array', items: 'component' },
      allowedValues: [{ id: '10', name: 'UI' }],
    };
    expect(scalarToApiValue(['ui', 'New'], comp.schema, comp)).toEqual([
      { id: '10' },
      { name: 'New' },
    ]);
  });
});

describe('coerceFieldValue / parseFieldArg', () => {
  it('parses alias=value with = inside the value', () => {
    expect(parseFieldArg('team=Platform')).toEqual({ key: 'team', raw: 'Platform' });
    expect(parseFieldArg('jql=a=b')).toEqual({ key: 'jql', raw: 'a=b' });
    expect(() => parseFieldArg('nope')).toThrow(/alias=value/);
  });

  it('coerces by schema, passes JSON through, clears on empty', () => {
    const number: JiraFieldMeta = {
      fieldId: 'customfield_10002',
      name: 'Points',
      required: false,
      schema: { type: 'number' },
    };
    expect(coerceFieldValue('3', number, 'customfield_10002')).toBe(3);
    expect(() => coerceFieldValue('x', number, 'customfield_10002')).toThrow(/expected a number/);
    expect(coerceFieldValue('', number, 'customfield_10002')).toBeNull();
    expect(coerceFieldValue('-', number, 'customfield_10002')).toBeNull();
    expect(coerceFieldValue('{"value":"A","child":{"value":"B"}}', undefined, 'x')).toEqual({
      value: 'A',
      child: { value: 'B' },
    });
    expect(() => coerceFieldValue('{bad', undefined, 'x')).toThrow(/looks like JSON/);
    const labels: JiraFieldMeta = {
      fieldId: 'labels',
      name: 'Labels',
      required: false,
      schema: { type: 'array', items: 'string' },
    };
    expect(coerceFieldValue('a, b,"c, d"', labels, 'labels')).toEqual(['a', 'b', 'c, d']);
    expect(coerceFieldValue('plain', undefined, 'customfield_10009')).toBe('plain');
  });

  it('turns an allowed-value mismatch into a validation error with the allowed list', () => {
    const option: JiraFieldMeta = {
      fieldId: 'customfield_10001',
      name: 'Team',
      required: true,
      schema: { type: 'option' },
      allowedValues: [{ value: 'Platform' }],
    };
    expect(() => coerceFieldValue('Mobile', option, 'customfield_10001')).toThrow(
      expect.objectContaining({
        code: 'validation',
        errors: { customfield_10001: 'Allowed: Platform' },
      })
    );
  });

  it('splitList respects quotes', () => {
    expect(splitList('a,"b,c", d')).toEqual(['a', 'b,c', 'd']);
  });
});

describe('create fields', () => {
  it('never lets custom fields override the standard ones', () => {
    const fields = buildCreateIssueFields({
      project: 'PROJ',
      issueType: 'Bug',
      summary: 'S',
      description: 'h1. x',
      custom: {
        summary: 'hijack',
        project: { key: 'EVIL' },
        customfield_10001: { value: 'Platform' },
      },
    });
    expect(fields).toEqual({
      customfield_10001: { value: 'Platform' },
      project: { key: 'PROJ' },
      issuetype: { name: 'Bug' },
      summary: 'S',
      description: 'h1. x',
    });
  });

  it('lists required fields that are neither set nor defaulted', () => {
    const type: JiraIssueTypeMeta = {
      id: '1',
      name: 'Bug',
      subtask: false,
      fields: {
        summary: {
          fieldId: 'summary',
          name: 'Summary',
          required: true,
          schema: { type: 'string' },
        },
        project: {
          fieldId: 'project',
          name: 'Project',
          required: true,
          schema: { type: 'project' },
        },
        reporter: {
          fieldId: 'reporter',
          name: 'Reporter',
          required: true,
          schema: { type: 'user' },
        },
        priority: {
          fieldId: 'priority',
          name: 'Priority',
          required: true,
          schema: { type: 'priority' },
          hasDefaultValue: true,
        },
        customfield_10001: {
          fieldId: 'customfield_10001',
          name: 'Team',
          required: true,
          schema: { type: 'option' },
        },
        labels: {
          fieldId: 'labels',
          name: 'Labels',
          required: false,
          schema: { type: 'array', items: 'string' },
        },
      },
    };
    expect(checkRequiredFields(type, { summary: 'S', project: { key: 'PROJ' } })).toEqual([
      'customfield_10001',
    ]);
    expect(
      checkRequiredFields(type, { summary: 'S', customfield_10001: { value: 'Platform' } })
    ).toEqual([]);
    expect(checkRequiredFields(type, { summary: '', customfield_10001: [] })).toEqual([
      'summary',
      'customfield_10001',
    ]);
  });
});

describe('needsFieldMeta / standardSchema', () => {
  it('asks for metadata only where allowed values are checked or the schema is unknown', () => {
    expect(needsFieldMeta({ type: 'option' })).toBe(true);
    expect(needsFieldMeta({ type: 'array', items: 'option' })).toBe(true);
    expect(needsFieldMeta(standardSchema('priority'))).toBe(true);
    expect(needsFieldMeta(standardSchema('issuetype'))).toBe(true);
    expect(needsFieldMeta({ type: 'resolution' })).toBe(true);
    expect(needsFieldMeta(undefined)).toBe(true);
    for (const id of ['summary', 'labels', 'assignee', 'duedate', 'components', 'fixVersions']) {
      expect(needsFieldMeta(standardSchema(id))).toBe(false);
    }
    expect(needsFieldMeta({ type: 'number' })).toBe(false);
    expect(standardSchema('customfield_10001')).toBeUndefined();
    expect(standardSchema('toString')).toBeUndefined();
  });

  it('coerces --field values with a fallback schema when no metadata was fetched', () => {
    expect(coerceFieldValue('High', undefined, 'priority', standardSchema('priority'))).toEqual({
      name: 'High',
    });
    expect(coerceFieldValue('a, b', undefined, 'labels', standardSchema('labels'))).toEqual([
      'a',
      'b',
    ]);
    expect(isLiteralFieldValue(' - ')).toBe(true);
    expect(isLiteralFieldValue('')).toBe(true);
    expect(isLiteralFieldValue('{"value":"A"}')).toBe(true);
    expect(isLiteralFieldValue('Web')).toBe(false);
  });
});

describe('usableEditmetaCache', () => {
  const now = new Date('2026-09-04T10:00:00.000Z');
  const want = { baseUrl: 'https://jira.example.internal', project: 'PROJ', issueTypeId: '1', now };
  const entry = {
    schema: 1,
    baseUrl: 'https://jira.example.internal',
    project: 'PROJ',
    issueTypeId: '1',
    fetchedAt: '2026-09-04T09:00:00.000Z',
    fields: {},
  };

  it('accepts a fresh entry for the same server, project and issue type', () => {
    expect(usableEditmetaCache(entry, want)).toBe(entry);
  });

  it('rejects anything else as a miss', () => {
    const stale = new Date(Date.parse(entry.fetchedAt) + EDITMETA_CACHE_TTL_MS);
    for (const stored of [
      undefined,
      'text',
      { ...entry, schema: 2 },
      { ...entry, baseUrl: 'https://other.example.internal' },
      { ...entry, project: 'OTHER' },
      { ...entry, issueTypeId: '2' },
      { ...entry, fetchedAt: 'yesterday' },
      { ...entry, fetchedAt: '2026-09-04T11:00:00.000Z' },
      { ...entry, fields: [] },
    ]) {
      expect(usableEditmetaCache(stored, want)).toBeUndefined();
    }
    expect(usableEditmetaCache(entry, { ...want, now: stale })).toBeUndefined();
    expect(usableEditmetaCache(entry, { ...want, ttlMs: 60_000 })).toBeUndefined();
  });
});
