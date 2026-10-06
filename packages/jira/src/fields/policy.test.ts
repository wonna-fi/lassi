import { describe, expect, it } from 'vitest';
import {
  assertWritable,
  fieldAliases,
  fieldPolicy,
  formatOf,
  isExcluded,
  isWritable,
} from './policy.js';

describe('fieldPolicy', () => {
  it('reads string and object entries into aliases and per-field settings', () => {
    const policy = fieldPolicy({
      points: 'customfield_10005',
      team: { id: 'customfield_10030', editable: true },
      notes: { id: 'customfield_10020', format: 'wiki' },
      development: { id: 'customfield_10040', exclude: true },
      due: 'duedate',
    });
    expect(policy.aliases).toEqual({
      points: 'customfield_10005',
      team: 'customfield_10030',
      notes: 'customfield_10020',
      development: 'customfield_10040',
      due: 'duedate',
    });
    expect(policy.settings).toEqual({
      customfield_10030: { editable: true },
      customfield_10020: { format: 'wiki' },
      customfield_10040: { exclude: true },
    });
  });

  it('makes custom fields read-only and other fields writable unless an entry says otherwise', () => {
    const policy = fieldPolicy({
      points: 'customfield_10005',
      team: { id: 'customfield_10030', editable: true },
      due: { id: 'duedate', editable: false },
    });
    expect(isWritable(policy, 'customfield_10005')).toBe(false);
    expect(isWritable(policy, 'customfield_99999')).toBe(false);
    expect(isWritable(policy, 'customfield_10030')).toBe(true);
    expect(isWritable(policy, 'summary')).toBe(true);
    expect(isWritable(policy, 'timetracking')).toBe(true);
    expect(isWritable(policy, 'duedate')).toBe(false);
    expect(formatOf(policy, 'customfield_10005')).toBe('raw');
    expect(isExcluded(policy, 'customfield_10005')).toBe(false);
  });

  it('merges two aliases of one field and rejects ones that disagree', () => {
    expect(
      fieldPolicy({
        a: { id: 'customfield_1', editable: true },
        b: { id: 'customfield_1', format: 'wiki' },
        c: 'customfield_1',
      }).settings
    ).toEqual({ customfield_1: { editable: true, format: 'wiki' } });
    expect(() =>
      fieldPolicy({
        a: { id: 'customfield_1', editable: true },
        b: { id: 'customfield_1', editable: false },
      })
    ).toThrow(
      expect.objectContaining({
        code: 'usage',
        message: 'invalid jira.fields: two entries for customfield_1 disagree on editable',
      })
    );
  });

  it('rejects an alias that would shadow a frontmatter key or name another field', () => {
    for (const alias of ['summary', 'description', 'status', 'readonly', 'lassi', 'url']) {
      expect(() => fieldPolicy({ [alias]: 'customfield_1' })).toThrow(
        expect.objectContaining({ code: 'usage', message: expect.stringContaining(`"${alias}"`) })
      );
    }
    expect(() => fieldPolicy({ customfield_2: 'customfield_1' })).toThrow(
      expect.objectContaining({
        message:
          'invalid jira.fields: alias "customfield_2" is itself a field id but maps to customfield_1',
      })
    );
    expect(() => fieldPolicy({ duedate: 'customfield_1' })).toThrow(
      expect.objectContaining({ code: 'usage' })
    );
    expect(fieldPolicy({ customfield_1: 'customfield_1' }).aliases).toEqual({
      customfield_1: 'customfield_1',
    });
  });

  it('rejects settings on a field behind a fixed frontmatter key, listing every problem', () => {
    expect(() =>
      fieldPolicy({
        title: { id: 'summary', exclude: true },
        prio: { id: 'priority', editable: false, format: 'wiki' },
      })
    ).toThrow(
      expect.objectContaining({
        message:
          'invalid jira.fields: summary ("title") is always shown as a built-in frontmatter key; remove exclude; priority ("prio") is always shown as a built-in frontmatter key; remove editable, format',
      })
    );
    expect(fieldPolicy({ title: 'summary' }).aliases).toEqual({ title: 'summary' });
    // The readonly facts are always shown too, so excluding one could not take effect.
    for (const id of ['status', 'reporter', 'created', 'updated', 'resolution']) {
      expect(() => fieldPolicy({ fact: { id, exclude: true } })).toThrow(
        expect.objectContaining({
          message: `invalid jira.fields: ${id} ("fact") is always shown as a built-in frontmatter key; remove exclude`,
        })
      );
    }
  });
});

describe('prototype-sensitive ids', () => {
  it('keeps an id like __proto__ a plain key instead of writing onto Object.prototype', () => {
    const policy = fieldPolicy({
      a: { id: '__proto__', editable: true, format: 'wiki' },
      b: { id: 'constructor', exclude: true },
    });
    expect(({} as Record<string, unknown>)['editable']).toBeUndefined();
    expect(({} as Record<string, unknown>)['format']).toBeUndefined();
    expect(isWritable(policy, '__proto__')).toBe(true);
    expect(formatOf(policy, '__proto__')).toBe('wiki');
    expect(isExcluded(policy, 'constructor')).toBe(true);
    expect(isWritable(policy, 'toString')).toBe(true);
    expect(fieldAliases({ a: '__proto__' })['a']).toBe('__proto__');
  });
});

describe('fieldAliases', () => {
  it('extracts alias → id even from a policy fieldPolicy would reject', () => {
    const entries = { summary: 'customfield_1', b: { id: 'priority', exclude: true } };
    expect(() => fieldPolicy(entries)).toThrow();
    expect(fieldAliases(entries)).toEqual({ summary: 'customfield_1', b: 'priority' });
  });
});

describe('assertWritable', () => {
  const policy = fieldPolicy({
    points: 'customfield_10005',
    due: { id: 'duedate', editable: false },
    team: { id: 'customfield_10030', editable: true },
  });
  const context = { product: 'jira' as const, issueKey: 'PROJ-1', operation: 'update' as const };

  it('passes writable fields', () => {
    expect(() =>
      assertWritable(
        policy,
        [
          { key: 'team', id: 'customfield_10030' },
          { key: 'customfield_10030', id: 'customfield_10030' },
          { key: 'summary', id: 'summary' },
        ],
        context
      )
    ).not.toThrow();
  });

  it('names every refused field and how to make each one writable', () => {
    expect(() =>
      assertWritable(
        policy,
        [
          { key: 'points', id: 'customfield_10005' },
          { key: 'customfield_10077', id: 'customfield_10077' },
          { key: 'due', id: 'duedate' },
        ],
        context
      )
    ).toThrow(
      expect.objectContaining({
        code: 'usage',
        message: 'read-only fields: points (customfield_10005), customfield_10077, due (duedate)',
        hint: 'set "editable": true on jira.fields.points; add { "id": "customfield_10077", "editable": true } under jira.fields; remove "editable": false from the jira.fields entry for duedate to let Lassi write them, if Jira allows it (`lassi jira fields` lists the policy)',
        errors: {
          customfield_10005: 'read-only in jira.fields',
          customfield_10077: 'read-only in jira.fields',
          duedate: 'read-only in jira.fields',
        },
        context: expect.objectContaining({ issueKey: 'PROJ-1', aliases: policy.aliases }),
      })
    );
  });

  it('does not send the user to an alias that does not say editable: false', () => {
    const twoAliases = fieldPolicy({
      due: 'duedate',
      deadline: { id: 'duedate', editable: false },
    });
    expect(() => assertWritable(twoAliases, [{ key: 'due', id: 'duedate' }], context)).toThrow(
      expect.objectContaining({
        hint: expect.stringMatching(
          /^remove "editable": false from the jira.fields entry for duedate /
        ),
      })
    );
  });

  it('explains how to enable an explicitly read-only custom field across aliases', () => {
    const field = [{ key: 'points', id: 'customfield_10005' }];
    const entries = {
      points: 'customfield_10005',
      estimate: { id: 'customfield_10005', editable: false },
    };
    expect(() => assertWritable(fieldPolicy(entries), field, context)).toThrow(
      expect.objectContaining({
        hint: expect.stringContaining(
          'set "editable": true on every jira.fields entry for customfield_10005'
        ),
      })
    );
    const enabled = fieldPolicy({
      points: { id: 'customfield_10005', editable: true },
      estimate: { id: 'customfield_10005', editable: true },
    });
    expect(() => assertWritable(enabled, field, context)).not.toThrow();
  });
});
