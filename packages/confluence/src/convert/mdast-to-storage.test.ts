import { describe, expect, it } from 'vitest';
import { createStorageConverter } from './index.js';
import { markdownToStorage, mdastToStorage } from './mdast-to-storage.js';
import { userDirectory } from './users.js';

const users = userDirectory([{ userKey: 'k1', username: 'jsmith' }]);

function write(markdown: string, writer = {}): string {
  return markdownToStorage(markdown, { users, writer }).storage;
}

describe('mdastToStorage', () => {
  it('writes the basic blocks and inline forms without whitespace between blocks', () => {
    expect(write('# T\n\nA **b** *c* ~~d~~ `e & f`\\\ng\n\n---\n\n> q\n')).toBe(
      '<h1>T</h1><p>A <strong>b</strong> <em>c</em> <s>d</s> <code>e &amp; f</code><br />g</p><hr /><blockquote><p>q</p></blockquote>'
    );
  });

  it('passes ```confluence fences through verbatim and maps noformat and code fences to macros', () => {
    expect(write('```confluence\n<ac:layout><p>x</p></ac:layout>\n```\n')).toBe(
      '<ac:layout><p>x</p></ac:layout>'
    );
    expect(write('```noformat\n *x* \n```\n')).toBe(
      '<ac:structured-macro ac:name="noformat"><ac:plain-text-body><![CDATA[ *x* ]]></ac:plain-text-body></ac:structured-macro>'
    );
    expect(write('```\nplain\n```\n')).toBe(
      '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[plain]]></ac:plain-text-body></ac:structured-macro>'
    );
    const result = markdownToStorage('```js not=key=value words\nx\n```\n');
    expect(result.storage).toBe(
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro>'
    );
    expect(result.warnings).toEqual([
      { code: 'code-meta-dropped', message: expect.stringContaining('not=key=value'), line: 1 },
    ]);
  });

  it('maps html to the two forms the dialect allows and refuses the rest', () => {
    expect(write('a\n\n<br />\n\nb\n')).toBe('<p>a</p><p><br /></p><p>b</p>');
    expect(write('<!-- toc -->\n')).toBe('<ac:structured-macro ac:name="toc" />');
    expect(write('<!-- toc maxLevel=2 -->\n')).toBe(
      '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="maxLevel">2</ac:parameter></ac:structured-macro>'
    );
    const dropped = markdownToStorage('<!-- toc ===bad -->\n');
    expect(dropped.storage).toBe('<ac:structured-macro ac:name="toc" />');
    expect(dropped.warnings[0]?.code).toBe('toc-params-dropped');
    expect(() => write('<div>x</div>\n')).toThrow(/HTML blocks are not supported.*\(line 1\)/);
    expect(() => write('a <span>x</span> b\n')).toThrow(/inline HTML is not supported/);
    expect(() => write('x<br>y\n')).not.toThrow();
  });

  it('writes lists in the inline or block form and task lists as ac:task-list', () => {
    expect(write('- a\n- b\n  - c\n\n1. x\n2. y\n')).toBe(
      '<ul><li>a</li><li>b<ul><li>c</li></ul></li></ul><ol><li>x</li><li>y</li></ol>'
    );
    expect(write('- a\n\n  more\n- b\n')).toBe(
      '<ul><li><p>a</p><p>more</p></li><li><p>b</p></li></ul>'
    );
    expect(write('- [x] done\n- [ ] todo\n')).toBe(
      '<ac:task-list><ac:task><ac:task-status>complete</ac:task-status><ac:task-body><span class="placeholder-inline-tasks">done</span></ac:task-body></ac:task><ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body><span class="placeholder-inline-tasks">todo</span></ac:task-body></ac:task></ac:task-list>'
    );
    expect(() => write('- [x] done\n- plain\n')).toThrow(/cannot mix/);
    expect(() => write('- [ ] a\n\n  second paragraph\n')).toThrow(/one line of text/);
  });

  it('writes tables per the writer options and refuses rows wider than the header', () => {
    const md = '| A | B |\n| - | - |\n| 1 | |\n| x<br />y | 2 |\n';
    expect(write(md)).toBe(
      '<table><tbody><tr><th>A</th><th>B</th></tr><tr><td>1</td><td></td></tr><tr><td>x<br />y</td><td>2</td></tr></tbody></table>'
    );
    expect(write(md, { tableShell: 'wrapped-colgroup', cellWrap: 'p' })).toBe(
      '<table class="wrapped"><colgroup><col /><col /></colgroup><tbody><tr><th><p>A</p></th><th><p>B</p></th></tr><tr><td><p>1</p></td><td></td></tr><tr><td><p>x<br />y</p></td><td><p>2</p></td></tr></tbody></table>'
    );
    expect(write('| | |\n| - | - |\n| a | b |\n', { tableShell: 'wrapped' })).toBe(
      '<table class="wrapped"><tbody><tr><td>a</td><td>b</td></tr></tbody></table>'
    );
    expect(write('| A |\n| - |\n| 1 |\n| 2 |\n')).toContain('<tr><td>2</td></tr>');
  });

  it('writes alerts as panels and refuses [!CAUTION]', () => {
    expect(write('> [!NOTE] Title\n> body\n')).toBe(
      '<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Title</ac:parameter><ac:rich-text-body><p>body</p></ac:rich-text-body></ac:structured-macro>'
    );
    expect(write('> [!IMPORTANT]\n> body\n')).toBe(
      '<ac:structured-macro ac:name="note"><ac:rich-text-body><p>body</p></ac:rich-text-body></ac:structured-macro>'
    );
    expect(() => write('> [!CAUTION]\n> body\n')).toThrow(/\[!CAUTION\] has no Confluence panel/);
  });

  it('writes links, autolink literals, attachments, images and references', () => {
    expect(
      write(
        '[t](https://x.example.internal/a "T \\"q\\"") https://y.example.internal a@example.internal\n'
      )
    ).toBe(
      '<p><a href="https://x.example.internal/a" title="T &quot;q&quot;">t</a> https://y.example.internal a@example.internal</p>'
    );
    expect(write('[spec.pdf](attachment:spec.pdf) [the spec](attachment:spec.pdf)\n')).toBe(
      '<p><ac:link><ri:attachment ri:filename="spec.pdf" /></ac:link> <ac:link><ri:attachment ri:filename="spec.pdf" /><ac:plain-text-link-body><![CDATA[the spec]]></ac:plain-text-link-body></ac:link></p>'
    );
    const flattened = markdownToStorage('[**bold** label](attachment:x.pdf)\n');
    expect(flattened.storage).toContain('<![CDATA[bold label]]>');
    expect(flattened.warnings[0]).toMatchObject({ code: 'link-label-flattened', line: 1 });
    expect(
      write('![a](attachment:p.png "width=10 height=20") ![](https://x.example.internal/i.png)\n')
    ).toBe(
      '<p><ac:image ac:alt="a" ac:width="10" ac:height="20"><ri:attachment ri:filename="p.png" /></ac:image> <ac:image><ri:url ri:value="https://x.example.internal/i.png" /></ac:image></p>'
    );
    const title = markdownToStorage('![a](attachment:p.png "just a caption")\n');
    expect(title.storage).toBe(
      '<p><ac:image ac:alt="a"><ri:attachment ri:filename="p.png" /></ac:image></p>'
    );
    expect(title.warnings[0]?.code).toBe('image-title-dropped');
    expect(() => write('![a](/relative.png)\n')).toThrow(/must be an attachment/);
    const refs = markdownToStorage('[t][d] ![i][d]\n\n[d]: https://x.example.internal/r "R"\n');
    expect(refs.storage).toBe(
      '<p><a href="https://x.example.internal/r" title="R">t</a> <ac:image ac:alt="i"><ri:url ri:value="https://x.example.internal/r" /></ac:image></p>'
    );
    expect(refs.warnings.map((w) => w.code)).toEqual(['reference-consumed', 'image-title-dropped']);
    expect(() =>
      mdastToStorage({
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              { type: 'linkReference', identifier: 'nope', referenceType: 'full', children: [] },
            ],
          },
        ],
      })
    ).toThrow(/unresolved reference \[nope\]/);
    expect(() => write('x[^1]\n\n[^1]: note\n')).toThrow(/footnotes/);
  });

  it('writes mentions per the attribute option, keeps placeholders and refuses unknown users', () => {
    expect(write('@jsmith @{userkey:k9}\n')).toBe(
      '<p><ac:link><ri:user ri:userkey="k1" /></ac:link> <ac:link><ri:user ri:userkey="k9" /></ac:link></p>'
    );
    expect(write('@jdoe\n', { mentionAttribute: 'username' })).toBe(
      '<p><ac:link><ri:user ri:username="jdoe" /></ac:link></p>'
    );
    expect(() => write('@jdoe\n')).toThrow(/unknown user @jdoe/);
  });

  it('writes page links and jira macros', () => {
    expect(
      write('[[Home]] [[DEV:Design|the design]] [[:Release:notes]] {jira:PROJ-1 serverId=1}\n')
    ).toBe(
      '<p><ac:link><ri:page ri:content-title="Home" /></ac:link> <ac:link><ri:page ri:space-key="DEV" ri:content-title="Design" /><ac:plain-text-link-body><![CDATA[the design]]></ac:plain-text-link-body></ac:link> <ac:link><ri:page ri:content-title="Release:notes" /></ac:link> <ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PROJ-1</ac:parameter><ac:parameter ac:name="serverId">1</ac:parameter></ac:structured-macro></p>'
    );
  });

  it('escapes text and attributes, keeps the non-breaking space as an entity', () => {
    expect(write(`a & b < c > d "q" 'e' fg\n`)).toBe(
      `<p>a &amp; b &lt; c &gt; d "q" 'e'&nbsp;fg</p>`
    );
    expect(write('[x](https://x.example.internal/?a=1&b=<2> "t&\\"u")\n')).toBe(
      '<p><a href="https://x.example.internal/?a=1&amp;b=&lt;2&gt;" title="t&amp;&quot;u">x</a></p>'
    );
  });

  it('forwards write warnings through the converter', () => {
    const seen: string[] = [];
    const converter = createStorageConverter({ onWriteWarning: (w) => seen.push(w.code) });
    converter.fromMarkdown('```js plain words\nx\n```\n');
    expect(seen).toEqual(['code-meta-dropped']);
  });

  it('drops the C0 controls XML forbids inside CDATA too', () => {
    // CDATA exempts its content from escaping, not from what XML 1.0 allows at all. The fidelity
    // gate reparses with the same non-validating parser, so it called this equal and the server
    // answered 400.
    expect(write('```ts\nconst a = 1;\u000c\n```\n')).not.toContain('\u000c');
  });

  it('keeps noformat parameters instead of dropping them without a word', () => {
    expect(write('```noformat nopanel=true\nplain\n```\n')).toBe(
      '<ac:structured-macro ac:name="noformat"><ac:parameter ac:name="nopanel">true</ac:parameter><ac:plain-text-body><![CDATA[plain]]></ac:plain-text-body></ac:structured-macro>'
    );
  });

  it('refuses a keyless mention in userkey mode and writes it in username mode', () => {
    // The empty string passed an `=== undefined` guard and wrote `<ri:user ri:userkey="" />`, which
    // names nobody. The same user is writable where the page's convention is `ri:username`.
    const keyless = userDirectory([{ userKey: '', username: 'jdoe' }]);
    expect(() => markdownToStorage('@jdoe\n', { users: keyless, writer: {} })).toThrow(
      /@jdoe has no user key/
    );
    expect(
      markdownToStorage('@jdoe\n', { users: keyless, writer: { mentionAttribute: 'username' } })
        .storage
    ).toBe('<p><ac:link><ri:user ri:username="jdoe" /></ac:link></p>');
    expect(() => markdownToStorage('@ghost\n', { users: keyless, writer: {} })).toThrow(
      /unknown user @ghost/
    );
  });
});
