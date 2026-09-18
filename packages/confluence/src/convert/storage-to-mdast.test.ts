import { describe, expect, it } from 'vitest';
import { parseConfluenceMarkdown, stringifyConfluenceMarkdown } from './md/index.js';
import { storageToMdast } from './storage-to-mdast.js';
import { collectMentions, collectUserKeys, collectUsernames, userDirectory } from './users.js';

const md = (storage: string, users = userDirectory([])): string =>
  stringifyConfluenceMarkdown(storageToMdast(storage, { users }).tree);
const warnings = (storage: string) => storageToMdast(storage).warnings;

describe('storageToMdast', () => {
  it('collapses and trims inline whitespace, keeping verbatim code and moving edge spaces out', () => {
    expect(md('<p>  a\n  <strong> b </strong>\n c </p>')).toBe('a **b** c\n');
    // CommonMark strips one edge space from a code span, so the stringifier pads it back.
    expect(md('<p><code>  x  </code> y</p>')).toBe('`   x   ` y\n');
    expect(md('<p>two <code>x</code></p>')).toBe('two `x`\n');
  });

  it('reads bare inline runs under a block container as paragraphs', () => {
    expect(md('text <em>here</em><p>para</p>more')).toBe('text *here*\n\npara\n\nmore\n');
    expect(md('<blockquote>quoted</blockquote>')).toBe('> quoted\n');
  });

  it('turns unknown blocks, comments and attribute-bearing paragraphs into exact fences', () => {
    const storage =
      '<p class="x">a</p><!-- note --><pre>  raw</pre><ac:macro ac:name="old">x</ac:macro>';
    expect(md(storage)).toBe(
      '```confluence\n<p class="x">a</p>\n```\n\n```confluence\n<!-- note -->\n```\n\n```confluence\n<pre>  raw</pre>\n```\n\n```confluence\n<ac:macro ac:name="old">x</ac:macro>\n```\n'
    );
    expect(warnings(storage)).toEqual([
      { code: 'attribute-unknown', name: 'p[class]', path: '/p[1]' },
      { code: 'block-unknown', name: '#comment', path: '/comment()[1]' },
      { code: 'block-unknown', name: 'pre', path: '/pre[1]' },
      { code: 'block-unknown', name: 'ac:macro', path: '/ac:macro[1]' },
    ]);
  });

  it('escalates inline unknowns to the enclosing paragraph, list item or table', () => {
    expect(md('<p>a <u>u</u> b</p>')).toBe('```confluence\n<p>a <u>u</u> b</p>\n```\n');
    expect(md('<ul><li>ok</li><li>bad <sup>2</sup></li></ul>')).toBe(
      '- ok\n- ```confluence\n  bad <sup>2</sup>\n  ```\n'
    );
    expect(
      warnings(
        '<table><tbody><tr><th>h</th></tr><tr><td><time datetime="2026-09-05" /></td></tr></tbody></table>'
      )
    ).toEqual([{ code: 'table-shape', name: 'time', path: '/table[1]' }]);
    expect(md('<h2>x <ac:placeholder>hint</ac:placeholder></h2>')).toBe(
      '```confluence\n<h2>x <ac:placeholder>hint</ac:placeholder></h2>\n```\n'
    );
  });

  it('reads links with titles, refuses extra link attributes, and keeps a stray br as a flow break', () => {
    expect(md('<p><a href="https://x.example.internal" title="T">t</a></p>')).toBe(
      '[t](https://x.example.internal "T")\n'
    );
    expect(warnings('<p><a href="https://x.example.internal" class="c">t</a></p>')).toEqual([
      { code: 'inline-unknown', name: 'a[class]', path: '/p[1]' },
    ]);
    expect(md('<p>a</p><br /><p>b</p>')).toBe('a\n\n<br />\n\nb\n');
  });

  it('reads table shapes and records them for the writer', () => {
    const result = storageToMdast(
      '<table class="wrapped"><colgroup><col /></colgroup><tbody><tr><th><p>H</p></th></tr><tr><td><p>x</p></td></tr></tbody></table><table><tbody><tr><td>y</td></tr></tbody></table>'
    );
    expect(result.shapes.tableShells).toEqual(['wrapped-colgroup', 'plain']);
    expect(result.shapes.cellWraps).toEqual(['p', 'none']);
    expect(warnings('<table><tbody><tr><td>a</td><td><p>b</p></td></tr></tbody></table>')).toEqual([
      { code: 'table-shape', name: 'cell-wrap', path: '/table[1]' },
    ]);
    expect(warnings('<table><tbody><tr><th>a</th><td>b</td></tr></tbody></table>')).toEqual([
      { code: 'table-shape', name: 'mixed-th', path: '/table[1]' },
    ]);
  });

  it('resolves user keys through the directory and records the mention form', () => {
    const users = userDirectory([{ userKey: 'k1', username: 'jsmith' }]);
    const result = storageToMdast(
      '<p><ac:link><ri:user ri:userkey="k1" /></ac:link> <ac:link><ri:user ri:userkey="k2" /></ac:link> <ac:link><ri:user ri:username="jdoe" /></ac:link></p>',
      { users }
    );
    expect(stringifyConfluenceMarkdown(result.tree)).toBe('@jsmith @{userkey:k2} @jdoe\n');
    expect(result.shapes.mentionAttributes).toEqual(['userkey', 'userkey', 'username']);
    expect(result.warnings).toEqual([{ code: 'user-unresolved', name: 'k2', path: '/p[1]' }]);
  });

  it('fences a code macro with a rich body and a panel with extra parameters', () => {
    expect(
      warnings(
        '<ac:structured-macro ac:name="code"><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>'
      )
    ).toEqual([{ code: 'block-unknown', name: 'macro:code', path: '/ac:structured-macro[1]' }]);
    expect(
      warnings(
        '<ac:structured-macro ac:name="info"><ac:parameter ac:name="icon">false</ac:parameter><ac:rich-text-body><p>x</p></ac:rich-text-body></ac:structured-macro>'
      )
    ).toEqual([{ code: 'block-unknown', name: 'macro:info', path: '/ac:structured-macro[1]' }]);
  });
});

describe('users', () => {
  it('collects user keys and usernames from storage and mentions from markdown', () => {
    const storage =
      '<p><ac:link><ri:user ri:userkey="k1" /></ac:link><ac:link><ri:user ri:userkey="k1" /></ac:link><ac:link><ri:user ri:username="jdoe" /></ac:link></p>';
    expect(collectUserKeys(storage)).toEqual(['k1']);
    expect(collectUsernames(storage)).toEqual(['jdoe']);
    expect(
      collectMentions(parseConfluenceMarkdown('@jsmith and @{userkey:k9} and @jsmith\n'))
    ).toEqual({
      usernames: ['jsmith'],
      userKeys: ['k9'],
    });
  });

  it('maps keys to names and back', () => {
    const dir = userDirectory([{ userKey: 'k1', username: 'jsmith' }]);
    expect(dir.usernameForKey('k1')).toBe('jsmith');
    expect(dir.keyForUsername('jsmith')).toBe('k1');
    expect(dir.usernameForKey('nope')).toBeUndefined();
  });
});
