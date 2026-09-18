import type { Code, Paragraph, Root } from 'mdast';
import { describe, expect, it } from 'vitest';
import { joinFrontmatter, splitFrontmatter } from './frontmatter.js';
import { detectDialectLeak, leakMessage } from './leak-detector.js';
import type { Mention } from './mention.js';
import { parseMarkdown } from './parse.js';
import { isRawFence, rawFence } from './raw-fence.js';
import { normalizeMarkdown, stringifyMarkdown } from './stringify.js';

function firstParagraph(md: string): Paragraph {
  return parseMarkdown(md).children[0] as Paragraph;
}

function textRoot(value: string): Root {
  return { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', value }] }] };
}

describe('bare autolinks', () => {
  it('keeps URLs and e-mails bare, except a URL right before a hard break', () => {
    const tree = parseMarkdown('x\n');
    tree.children = [
      {
        type: 'paragraph',
        children: [
          {
            type: 'link',
            url: 'https://x.example.com',
            children: [{ type: 'text', value: 'https://x.example.com' }],
          },
          { type: 'text', value: ' and ' },
          {
            type: 'link',
            url: 'mailto:jane@example.internal',
            children: [{ type: 'text', value: 'jane@example.internal' }],
          },
          { type: 'break' },
          {
            type: 'link',
            url: 'https://y.example.com',
            children: [{ type: 'text', value: 'https://y.example.com' }],
          },
          { type: 'break' },
          { type: 'text', value: 'end' },
        ],
      },
    ];
    const md = stringifyMarkdown(tree);
    expect(md).toBe(
      'https://x.example.com and jane@example.internal\\\n<https://y.example.com>\\\nend\n'
    );
    expect(normalizeMarkdown(md)).toBe(md);
  });
});

describe('canonical markdown (parse → stringify)', () => {
  it.each([
    ['foo_bar baz', 'foo_bar baz\n'],
    ['a_b_c and https://x.example.com/a_b?c=1_2', 'a_b_c and https://x.example.com/a_b?c=1_2\n'],
    ['mail jane@example.internal', 'mail jane@example.internal\n'],
    ['2\\*3\\*4', '2\\*3\\*4\n'],
    ['2*3*4', '2*3*4\n'],
    ['a \\_x\\_ b', 'a \\_x\\_ b\n'],
    ['\\_lead and trail\\_', '\\_lead and trail\\_\n'],
    ['*em* and __strong__', '*em* and **strong**\n'],
    ['[text](https://x.example.com/a_b "t")', '[text](https://x.example.com/a_b "t")\n'],
    ['- one\n- two\n  - nested', '- one\n- two\n  - nested\n'],
    ['1. a\n2. b', '1. a\n2. b\n'],
    ['| h | i |\n|---|---|\n| 1 | 2 |', '| h | i |\n| - | - |\n| 1 | 2 |\n'],
    ['```ts\nconst x = 1;\n```', '```ts\nconst x = 1;\n```\n'],
    ['- [ ] todo\n- [x] done', '- [ ] todo\n- [x] done\n'],
    ['***', '---\n'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeMarkdown(input)).toBe(expected);
  });

  it('escapes literal text that would otherwise re-parse as markup', () => {
    expect(stringifyMarkdown(textRoot('use @Override and 2*3*4 and _x_'))).toBe(
      'use \\@Override and 2\\*3\\*4 and \\_x\\_\n'
    );
    expect(stringifyMarkdown(textRoot('snake_case stays, a_b_c too'))).toBe(
      'snake_case stays, a_b_c too\n'
    );
  });

  it('is idempotent on a mixed corpus', () => {
    const corpus = [
      '# Title\n\nsnake_case_name, `code_with_underscores`, 2*3, [x](https://a.example.com/b_c) and _em_.',
      '> quote\n\n- a\n- b\n\n| c | d |\n| - | - |\n| e_f | g*h |',
      'C:\\Users\\me\\file_name.txt and \\\\srv\\share and https://x.example.com/p?q=1',
    ].join('\n\n');
    const once = normalizeMarkdown(corpus);
    expect(normalizeMarkdown(once)).toBe(once);
  });
});

describe('mentions', () => {
  it('parses @user with dots, dashes and underscores but keeps trailing punctuation', () => {
    const p = firstParagraph('ping @j.smith-jr_2, thanks @jdoe.');
    expect(p.children.map((c) => c.type)).toEqual(['text', 'mention', 'text', 'mention', 'text']);
    expect((p.children[1] as Mention).username).toBe('j.smith-jr_2');
    expect((p.children[3] as Mention).username).toBe('jdoe');
    expect((p.children[4] as { value: string }).value).toBe('.');
  });

  it.each([
    'mail jane@example.internal now',
    'path a/@scope',
    'see \\@Override here',
    '@@x',
    'a-@b',
    'at @ end',
  ])('does not treat %j as a mention', (md) => {
    expect(firstParagraph(md).children.every((c) => c.type !== 'mention')).toBe(true);
  });

  it('round-trips mentions', () => {
    expect(normalizeMarkdown('hi @jsmith, see @j.smith and @a-b_c.')).toBe(
      'hi @jsmith, see @j.smith and @a-b_c.\n'
    );
    expect(normalizeMarkdown('see \\@Override here')).toBe('see \\@Override here\n');
  });
});

describe('raw fences', () => {
  it('survive parse → stringify byte for byte, including backticks and braces', () => {
    const value = '{panel:title=X}\n*bold* and ``` inside\n{panel}';
    const tree: Root = { type: 'root', children: [rawFence('wiki', value)] };
    const md = stringifyMarkdown(tree);
    const back = parseMarkdown(md).children[0] as Code;
    expect(isRawFence(back, 'wiki')).toBe(true);
    expect(back.value).toBe(value);
    expect(md).toBe('````jira\n{panel:title=X}\n*bold* and ``` inside\n{panel}\n````\n');
  });

  it('isRawFence distinguishes dialects', () => {
    expect(isRawFence(rawFence('storage', '<ac:x/>'), 'wiki')).toBe(false);
    expect(isRawFence(rawFence('storage', '<ac:x/>'))).toBe(true);
    expect(isRawFence({ type: 'code', lang: 'ts', value: '' })).toBe(false);
  });
});

describe('frontmatter', () => {
  const data = {
    key: 'PROJ-123',
    summary: 'Login page throws 500: on empty password',
    labels: ['auth', 'regression'],
    readonly: { updated: '2026-09-03T14:02:10+0300', id: 40213 },
    counts: { comments: 7, attachments: 2, links: 3 },
    lassi: { fetchedAt: '2026-09-04T10:00:00+0300', product: 'jira', schema: 1 },
  };

  it('joins with flow maps and splits back to the same data and body', () => {
    const text = joinFrontmatter(data, 'Description body\n\nwith *markdown*\n', {
      flowKeys: ['counts', 'lassi'],
    });
    expect(text).toContain('counts: { comments: 7, attachments: 2, links: 3 }');
    expect(text).toContain(
      'lassi: { fetchedAt: 2026-09-04T10:00:00+0300, product: jira, schema: 1 }'
    );
    expect(text.endsWith('---\n\nDescription body\n\nwith *markdown*\n')).toBe(true);
    const split = splitFrontmatter(text);
    expect(split.data).toEqual(data);
    expect(split.body).toBe('Description body\n\nwith *markdown*\n');
  });

  it('renders trailing comments on top-level keys', () => {
    const text = joinFrontmatter({ customfield_10001: 3, summary: 'S' }, 'b', {
      comments: { customfield_10001: 'Story Points' },
    });
    expect(text).toContain('customfield_10001: 3 # Story Points\n');
    expect(splitFrontmatter(text).data).toEqual({ customfield_10001: 3, summary: 'S' });
  });

  it('keeps timestamps as strings and quotes ambiguous scalars', () => {
    const text = joinFrontmatter({ summary: '123', flag: 'true', when: '2026-01-01' }, '');
    expect(splitFrontmatter(text).data).toEqual({
      summary: '123',
      flag: 'true',
      when: '2026-01-01',
    });
  });

  it('handles missing, empty and unclosed frontmatter', () => {
    expect(splitFrontmatter('just body')).toEqual({ body: 'just body' });
    expect(splitFrontmatter('---\n---\nbody')).toEqual({ data: {}, body: 'body' });
    expect(() => splitFrontmatter('---\nkey: 1\nbody')).toThrow(/not closed/);
    expect(() => splitFrontmatter('---\n- a\n---\n')).toThrow(/mapping/);
  });
});

describe('dialect-leak detector', () => {
  it.each([
    ['h1. Title', '[heading h1.]'],
    ['see {code:java}x{code}', '[{code}]'],
    ['{noformat}x{noformat}', '[{noformat}]'],
    ['{quote}x{quote}', '[{quote}]'],
    ['{panel:title=x}', '[{panel}]'],
    ['{color:red}x{color}', '[{color}]'],
    ['a [text|http://x.example.com] b', '[[text|url]]'],
    ['cc [~jsmith]', '[[~user]]'],
    ['||h1||h2||', '[||header||]'],
    ['use {{mono}} here', '[{{monospace}}]'],
    ['<ac:structured-macro ac:name="toc"/>', '[<ac:…>]'],
    ['<p><ri:page ri:content-title="X"/></p>', '[<ri:…>]'],
  ])('%j → %s', (md, expected) => {
    const hits = detectDialectLeak(parseMarkdown(md));
    expect(`[${hits.map((h) => h.pattern).join(', ')}]`).toBe(expected);
  });

  it('ignores markup inside code, inline code and raw fences', () => {
    const md = [
      '```jira',
      '{panel}h1. x{panel}',
      '```',
      '',
      'and `{{mono}}` and',
      '',
      '```',
      '||h||',
      '```',
      '',
      '```confluence',
      '<ac:layout/>',
      '```',
    ].join('\n');
    expect(detectDialectLeak(parseMarkdown(md))).toEqual([]);
  });

  it('reports the line and a usable message', () => {
    const hits = detectDialectLeak(parseMarkdown('intro\n\nh2. Section'));
    expect(hits[0]?.line).toBe(3);
    expect(leakMessage(hits)).toContain('line 3');
    expect(leakMessage(hits)).toContain('```jira / ```confluence fence');
  });
});

describe('mention escaping at construct starts', () => {
  it('escapes @ right after an emphasis, strong or link opener so it does not re-parse as a mention', () => {
    const tree: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'emphasis', children: [{ type: 'text', value: '@handle wx' }] },
            { type: 'text', value: ' ' },
            { type: 'strong', children: [{ type: 'text', value: '@x' }] },
            { type: 'text', value: ' ' },
            {
              type: 'link',
              url: 'https://x.example.internal',
              children: [{ type: 'text', value: '@label' }],
            },
            { type: 'text', value: ' (@tail)' },
          ],
        },
      ],
    };
    const md = stringifyMarkdown(tree);
    expect(md).toBe('*\\@handle wx* **\\@x** [\\@label](https://x.example.internal) (\\@tail)\n');
    expect(stringifyMarkdown(parseMarkdown(md))).toBe(md);
    const back = parseMarkdown(md).children[0];
    expect(JSON.stringify(back)).not.toContain('"mention"');
  });
});
