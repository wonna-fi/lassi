import { describe, expect, it } from 'vitest';
import { normalizeStorage, toCanonicalTree } from './normalize.js';
import { cdata, escapeAttr, escapeText } from './xml/escape.js';
import { decodeText, parseStorage, sliceSource } from './xml/parse.js';

const NBSP = String.fromCharCode(160);

describe('parseStorage', () => {
  it('keeps source offsets so a node slice is byte-exact, entities included', () => {
    const src =
      '<p>a&nbsp;b</p><ac:structured-macro ac:name="toc"><ac:parameter ac:name="x">1</ac:parameter></ac:structured-macro>';
    const { doc } = parseStorage(src);
    expect(sliceSource(src, doc.children[0]!)).toBe('<p>a&nbsp;b</p>');
    expect(sliceSource(src, doc.children[1]!)).toBe(
      '<ac:structured-macro ac:name="toc"><ac:parameter ac:name="x">1</ac:parameter></ac:structured-macro>'
    );
  });

  it('leaves CDATA raw and decodes text on demand with the HTML5 table', () => {
    const src =
      '<ac:plain-text-body><![CDATA[a && <b>]]></ac:plain-text-body><p>x&rsquo;y &amp; z</p>';
    const { doc } = parseStorage(src);
    expect(sliceSource(src, doc.children[0]!)).toContain('<![CDATA[a && <b>]]>');
    expect(decodeText('x&rsquo;y &amp; z&nbsp;')).toBe(`x’y & z${NBSP}`);
  });

  it('repairs an unclosed void element that swallowed its siblings', () => {
    const { doc } = parseStorage('<p>a<br>b<strong>c</strong></p>');
    const p = doc.children[0] as {
      children: Array<{ name?: string; data?: string; children?: unknown[] }>;
    };
    expect(p.children.map((c) => c.name ?? c.data)).toEqual(['a', 'br', 'b', 'strong']);
    expect(p.children[1]?.children).toEqual([]);
  });
});

describe('escape', () => {
  it('escapes text and attributes, keeps the nbsp entity and drops control characters', () => {
    expect(escapeText(`a < b & c > d${NBSP}e${String.fromCharCode(7)}`)).toBe(
      'a &lt; b &amp; c &gt; d&nbsp;e'
    );
    expect(escapeAttr('say "hi" & <go>')).toBe('say &quot;hi&quot; &amp; &lt;go&gt;');
  });

  it('splits a literal ]]> across CDATA sections', () => {
    expect(cdata('x')).toBe('<![CDATA[x]]>');
    expect(cdata('a]]>b')).toBe('<![CDATA[a]]]]><![CDATA[>b]]>');
  });
});

describe('normalizeStorage', () => {
  const n = normalizeStorage;

  it('re-encodes entities deterministically and merges CDATA into text', () => {
    expect(n('<p>a&nbsp;&rsquo;&#39;b</p>')).toBe("<p>a&nbsp;’'b</p>");
    expect(n('<x><![CDATA[a]]><![CDATA[b]]></x>')).toBe('<x>ab</x>');
  });

  it('drops layout whitespace between block children and collapses inline runs', () => {
    expect(n('<ul>\n  <li>a</li>\n  <li>b</li>\n</ul>')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(n('<p>  a\n   <strong> b </strong>  c  </p>')).toBe('<p>a <strong>b</strong> c</p>');
    expect(n('<p><em> x</em>y</p>')).toBe('<p><em>x</em>y</p>');
    expect(n('<pre>  keep\n  this </pre>')).toBe('<pre>  keep\n  this </pre>');
    expect(n('<p><code>  x  </code></p>')).toBe('<p><code>  x  </code></p>');
  });

  it('sorts attributes, quotes them, and removes server bookkeeping', () => {
    expect(
      n(
        '<ac:structured-macro ac:schema-version="1" ac:name="code" ac:macro-id="abc"><ac:parameter ac:name="language">js</ac:parameter></ac:structured-macro>'
      )
    ).toBe(
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter></ac:structured-macro>'
    );
    expect(n('<ri:page ri:version-at-save="3" ri:content-title="T"/>')).toBe(
      '<ri:page ri:content-title="T"/>'
    );
    expect(
      n(
        '<ac:task><ac:task-id>1</ac:task-id><ac:task-uuid>u</ac:task-uuid><ac:task-status>complete</ac:task-status></ac:task>'
      )
    ).toBe('<ac:task><ac:task-status>complete</ac:task-status></ac:task>');
  });

  it('writes childless elements self-closed and sorts macro parameters first by name', () => {
    expect(n('<p><br></br></p>')).toBe('<p><br/></p>');
    expect(
      n(
        '<ac:structured-macro ac:name="x"><ac:rich-text-body><p>a</p></ac:rich-text-body><ac:parameter ac:name="title">T</ac:parameter><ac:parameter ac:name="borderStyle">s</ac:parameter></ac:structured-macro>'
      )
    ).toBe(
      '<ac:structured-macro ac:name="x"><ac:parameter ac:name="borderStyle">s</ac:parameter><ac:parameter ac:name="title">T</ac:parameter><ac:rich-text-body><p>a</p></ac:rich-text-body></ac:structured-macro>'
    );
  });

  it('keeps comments and processing instructions', () => {
    expect(n('<!-- note --><?pi x?><p>a</p>')).toBe('<!-- note --><?pi x?><p>a</p>');
  });

  it('treats a li or td with block children as a block container', () => {
    expect(n('<li>\n<p>a</p>\n<ul><li>b</li></ul>\n</li>')).toBe(
      '<li><p>a</p><ul><li>b</li></ul></li>'
    );
    expect(n('<td>\n  a <em>b</em>\n</td>')).toBe('<td>a <em>b</em></td>');
  });

  it.each([
    ['element order', '<p>a</p><p>b</p>', '<p>b</p><p>a</p>'],
    ['b vs strong', '<p><b>a</b></p>', '<p><strong>a</strong></p>'],
    [
      'thead vs tbody',
      '<table><thead><tr><th>a</th></tr></thead></table>',
      '<table><tbody><tr><th>a</th></tr></tbody></table>',
    ],
    ['p wrapper', '<td><p>a</p></td>', '<td>a</td>'],
    ['class attribute', '<table class="wrapped"><tbody/></table>', '<table><tbody/></table>'],
    ['br count', '<p>a<br/>b</p>', '<p>a<br/><br/>b</p>'],
    [
      'parameter value',
      '<ac:parameter ac:name="k">1</ac:parameter>',
      '<ac:parameter ac:name="k">2</ac:parameter>',
    ],
  ])('does not normalise away %s', (_label, a, b) => {
    expect(n(a)).not.toBe(n(b));
  });

  it('exposes the canonical tree', () => {
    expect(toCanonicalTree('<p a="1">x</p>')).toEqual([
      { kind: 'element', name: 'p', attrs: [['a', '1']], children: [{ kind: 'text', value: 'x' }] },
    ]);
  });
});
