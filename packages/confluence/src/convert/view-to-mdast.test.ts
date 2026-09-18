import { describe, expect, it } from 'vitest';
import { viewToMarkdown } from './index.js';
import { userDirectory } from './users.js';
import { viewToMdast } from './view-to-mdast.js';

const VIEW = [
  '<h2 id="Payment-Overview">Overview</h2>',
  '<p class="auto-cursor-target">Hello <strong>world</strong>&nbsp;and <a href="https://example.internal/x" rel="nofollow" class="external-link">a link</a>.</p>',
  '<div class="code panel pdl conf-macro output-block" data-hasbody="true" data-macro-name="code" style="border-width: 1px;">',
  '<div class="codeHeader panelHeader pdl" style="border-bottom-width: 1px;"><b>Setup.ts</b></div>',
  '<div class="codeContent panelContent pdl"><pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: typescript; gutter: false; theme: Confluence" data-theme="Confluence">const a = 1 &lt; 2;</pre></div></div>',
  '<div class="confluence-information-macro confluence-information-macro-tip conf-macro output-block" data-hasbody="true" data-macro-name="tip">',
  '<p class="title conf-macro-render">Heads up</p><span class="aui-icon aui-icon-small aui-iconfont-approve confluence-information-macro-icon"></span>',
  '<div class="confluence-information-macro-body"><p>Use the <code>--out</code> flag.</p></div></div>',
  '<div class="table-wrap"><table class="wrapped confluenceTable"><colgroup><col/><col/></colgroup><tbody>',
  '<tr><th class="confluenceTh">Name</th><th class="confluenceTh">Value</th></tr>',
  '<tr><td class="confluenceTd" colspan="1">a</td><td class="confluenceTd">1</td></tr></tbody></table></div>',
  '<ul class="inline-task-list" data-inline-tasks-content-id="123456">',
  '<li data-inline-task-id="1" class="checked"><span class="placeholder-inline-tasks">Ship it</span></li>',
  '<li data-inline-task-id="2"><span class="placeholder-inline-tasks">Tell <a class="confluence-userlink user-mention" data-username="jsmith" href="/display/~jsmith" data-linked-resource-type="userinfo">John Smith</a></span></li></ul>',
  '<p>See <a href="/display/DEV/Payment+design">the design</a> and <a href="/display/DEV/Payment+design">Payment design</a>, ',
  'plus <a class="confluence-embedded-file" href="/download/attachments/123456/spec.pdf?version=2&amp;api=v2" data-linked-resource-type="attachment" data-linked-resource-default-alias="spec.pdf" data-nice-type="PDF">spec.pdf</a>.</p>',
  '<p><span class="confluence-embedded-file-wrapper image-center-wrapper"><img class="confluence-embedded-image image-center" width="300" src="/download/attachments/123456/diagram.png?version=1&amp;api=v2" data-image-src="/download/attachments/123456/diagram.png?version=1&amp;api=v2" data-linked-resource-type="attachment" data-linked-resource-default-alias="diagram.png" alt="the diagram"></span></p>',
  '<p>Done <img class="emoticon emoticon-smile" src="/images/icons/emoticons/smile.svg" data-emoticon-name="smile" alt="(smile)"></p>',
  '<div class="contentLayout2"><div class="columnLayout single" data-layout="single"><div class="cell normal" data-type="normal"><div class="innerCell">',
  '<p>Inside a layout.</p></div></div></div></div>',
  '<div class="expand-container conf-macro output-block" data-hasbody="true" data-macro-name="expand"><div class="expand-control"><span class="expand-control-text">Click here to expand…</span></div><div class="expand-content"><p>Hidden</p></div></div>',
  '<p class="auto-cursor-target"><br></p>',
  '<p>Issue <span class="jira-issue conf-macro output-inline" data-jira-key="PROJ-1" data-macro-name="jira"><a href="https://jira.example.internal/browse/PROJ-1" class="jira-issue-key">PROJ-1</a> - <span class="summary">Login 500</span></span> is open.</p>',
  '<div class="toc-macro rbtoc1725000000000 conf-macro output-block" data-macro-name="toc"><ul class="toc-indentation"><li><a href="#Payment-Overview">Overview</a></li></ul></div>',
].join('\n');

describe('viewToMdast', () => {
  it('reads rendered HTML through the storage handlers after rewriting the renderer markup', () => {
    const md = viewToMarkdown(VIEW);
    expect(md).toBe(
      [
        '## Overview',
        '',
        'Hello **world** and [a link](https://example.internal/x).',
        '',
        '```typescript title=Setup.ts',
        'const a = 1 < 2;',
        '```',
        '',
        '> [!TIP] Heads up',
        '> Use the `--out` flag.',
        '',
        '| Name | Value |',
        '| - | - |',
        '| a | 1 |',
        '',
        '- [x] Ship it',
        '- [ ] Tell @jsmith',
        '',
        'See [[DEV:Payment design|the design]] and [[DEV:Payment design]], plus [spec.pdf](attachment:spec.pdf).',
        '',
        '![the diagram](attachment:diagram.png "width=300")',
        '',
        '```html',
        '<p>Done <img class="emoticon emoticon-smile" src="/images/icons/emoticons/smile.svg" data-emoticon-name="smile" alt="(smile)"></p>',
        '```',
        '',
        'Inside a layout.',
        '',
        '```html',
        '<div class="expand-container conf-macro output-block" data-hasbody="true" data-macro-name="expand"><div class="expand-control"><span class="expand-control-text">Click here to expand…</span></div><div class="expand-content"><p>Hidden</p></div></div>',
        '```',
        '',
        '<br />',
        '',
        'Issue {jira:PROJ-1} is open.',
        '',
        '<!-- toc -->',
        '',
      ].join('\n')
    );
  });

  it('reports fences as html code blocks with the usual warnings and resolves user keys', () => {
    const result = viewToMdast(
      '<p>Hi <a class="confluence-userlink" data-username="jdoe" href="/display/~jdoe">Jane</a></p><div data-macro-name="drawio" class="conf-macro output-block"><div class="ap-container">…</div></div>',
      { users: userDirectory([{ userKey: 'k1', username: 'jdoe' }]) }
    );
    expect(result.warnings).toEqual([
      { code: 'block-unknown', name: 'macro:drawio', path: '/ac:structured-macro[1]' },
    ]);
    const fence = result.tree.children[1];
    expect(fence).toMatchObject({ type: 'code', lang: 'html' });
    expect((fence as { value: string }).value.startsWith('<div data-macro-name="drawio"')).toBe(
      true
    );
    expect(result.shapes.mentionAttributes).toEqual(['username']);
  });

  it('uses the legacy class names when data-macro-name is absent', () => {
    const md = viewToMarkdown(
      '<div class="code panel pdl"><div class="codeContent panelContent pdl"><pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: java; gutter: false">int x;</pre></div></div>' +
        '<div class="confluence-information-macro confluence-information-macro-warning"><div class="confluence-information-macro-body"><p>Careful</p></div></div>' +
        '<div class="preformatted panel"><div class="preformattedContent panelContent"><pre>raw &amp; text</pre></div></div>' +
        '<p><img src="https://example.internal/pic.png" alt="ext"></p>'
    );
    expect(md).toBe(
      '```java\nint x;\n```\n\n> [!WARNING]\n> Careful\n\n```noformat\nraw & text\n```\n\n![ext](https://example.internal/pic.png)\n'
    );
  });

  it('keeps a rendered panel that has no macro-body wrapper', () => {
    // Older renders put the text straight in the div. Building an empty rich-text body from that
    // produced `> [!TIP]` with nothing under it, and the words were simply gone.
    const md = viewToMarkdown(
      '<div class="confluence-information-macro confluence-information-macro-tip" data-macro-name="tip"><p>Use the flag.</p></div>'
    );
    expect(md).toContain('Use the flag.');
  });

  it('survives a panel class that names a member of Object.prototype', () => {
    const md = viewToMarkdown(
      '<div class="confluence-information-macro constructor"><div class="confluence-information-macro-body"><p>Body.</p></div></div>'
    );
    expect(md).toContain('Body.');
  });

  it('decodes an attachment alias once, so it is not escaped twice', () => {
    // The view is parsed with `decodeEntities: false`, so the alias arrives encoded while the URL
    // fallback does not. Escaping both left `Q&amp;A.png` as `Q&amp;amp;A.png`, which then never
    // matched the link text and appended a link body nobody asked for.
    const md = viewToMarkdown(
      '<p><a class="confluence-embedded-file" href="/download/attachments/123456/Q%26A.png" data-linked-resource-type="attachment" data-linked-resource-default-alias="Q&amp;A.png">Q&amp;A.png</a></p>' +
        '<p><img class="confluence-embedded-image" src="/download/attachments/123456/Q%26A.png" data-linked-resource-type="attachment" data-linked-resource-default-alias="Q&amp;A.png"></p>'
    );
    // `\\&` is the markdown escape; what matters is that no entity survives into the filename.
    expect(md).toBe('[Q\\&A.png](attachment:Q\\&A.png)\n\n![](attachment:Q\\&A.png)\n');
    expect(md).not.toContain('amp;');
  });
});
