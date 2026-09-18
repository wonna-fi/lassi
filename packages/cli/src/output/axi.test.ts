import { describe, expect, it } from 'vitest';
import { renderAxi, renderHelp, truncate } from './axi.js';

describe('renderAxi', () => {
  it('encodes uniform rows as a TOON table, nested objects and arrays inline, strings quoted only when needed', () => {
    const out = renderAxi({
      data: {
        total: 3,
        shown: 2,
        issues: [
          { key: 'PROJ-1', summary: 'Login, 500: bad', status: 'Open', assignee: null },
          { key: 'PROJ-2', summary: 'x', status: 'Done', assignee: 'jsmith' },
        ],
        counts: { comments: 7, attachments: 0 },
        labels: ['auth', 'regression'],
        description: 'line one\nline two',
        empty: [],
        flag: true,
      },
    });
    expect(out).toBe(
      [
        'total: 3',
        'shown: 2',
        'issues[2]{key,summary,status,assignee}:',
        '  PROJ-1,"Login, 500: bad",Open,null',
        '  PROJ-2,x,Done,jsmith',
        'counts:',
        '  comments: 7',
        '  attachments: 0',
        'labels[2]: auth,regression',
        'description: "line one\\nline two"',
        'empty: []',
        'flag: true',
        '',
      ].join('\n')
    );
  });

  it('wraps a bare array or scalar so the document always has a root object, and drops undefined', () => {
    expect(renderAxi({ data: [{ a: 1 }, { a: 2 }] })).toBe('count: 2\nitems[2]{a}:\n  1\n  2\n');
    expect(renderAxi({ data: 'x' })).toBe('value: x\n');
    expect(renderAxi({ data: { a: undefined, b: 1 } })).toBe('b: 1\n');
  });

  it('renders help lines by hand after the data block', () => {
    expect(renderHelp(undefined)).toBe('');
    expect(renderHelp([])).toBe('');
    expect(renderHelp(['Do this.'])).toBe('help[1]:\n  Do this.\n');
    expect(renderAxi({ data: { ok: true }, help: ['One.', ' Two. '] })).toBe(
      'ok: true\nhelp[2]:\n  One.\n  Two.\n'
    );
  });

  it('truncates long text to one line with an ellipsis', () => {
    expect(truncate('short  text\nhere')).toBe('short text here');
    const long = 'x'.repeat(250);
    expect(truncate(long)).toHaveLength(200);
    expect(truncate(long).endsWith('…')).toBe(true);
    expect(truncate('abcdef', 4)).toBe('abc…');
  });
});
