import { describe, expect, it } from 'vitest';
import { countMacros, fenceReason, observePage, summarize } from './macros.js';

const PAGE_A =
  '<ac:layout><ac:layout-section ac:type="single"><ac:layout-cell>' +
  '<p>Hi</p>' +
  '<ac:structured-macro ac:name="code" ac:schema-version="1"><ac:plain-text-body><![CDATA[x]]></ac:plain-text-body></ac:structured-macro>' +
  '<ac:structured-macro ac:name="Excerpt" ac:schema-version="1"><ac:rich-text-body><p>e</p></ac:rich-text-body></ac:structured-macro>' +
  '</ac:layout-cell></ac:layout-section></ac:layout>';
const PAGE_B =
  '<table class="wrapped"><colgroup><col/></colgroup><tbody><tr><th><p>H</p></th></tr><tr><td><p>c</p></td></tr></tbody></table>' +
  '<p><ac:link><ri:user ri:userkey="k1"/></ac:link> <ac:structured-macro ac:name="status"><ac:parameter ac:name="title">ok</ac:parameter></ac:structured-macro></p>' +
  '<ac:macro ac:name="toc"/>';

describe('confluence stats', () => {
  it('counts macros by lower-cased name and layouts as one bucket', () => {
    expect([...countMacros(PAGE_A).entries()]).toEqual([
      ['layout', 1],
      ['code', 1],
      ['excerpt', 1],
    ]);
    expect([...countMacros(PAGE_B).entries()]).toEqual([
      ['status', 1],
      ['toc', 1],
    ]);
    expect(countMacros('<div class="contentLayout2"><p>x</p></div>').get('layout')).toBe(1);
  });

  it('buckets converter warnings into fence reasons', () => {
    expect(fenceReason({ code: 'block-unknown', name: 'macro:excerpt', path: '' })).toBe(
      'macro:excerpt'
    );
    expect(fenceReason({ code: 'block-unknown', name: 'ac:layout', path: '' })).toBe('layout');
    expect(fenceReason({ code: 'inline-unknown', name: 'macro:status', path: '' })).toBe(
      'inline:macro:status'
    );
    expect(fenceReason({ code: 'table-shape', name: 'colspan', path: '' })).toBe(
      'table-shape:colspan'
    );
    expect(fenceReason({ code: 'user-unresolved', name: 'k1', path: '' })).toBeUndefined();
  });

  it('summarizes macros, fence reasons and conventions across pages', () => {
    const summary = summarize([observePage('1', PAGE_A), observePage('2', PAGE_B)]);
    expect(summary.pages).toBe(2);
    expect(summary.fencedPages).toBe(2);
    expect(summary.macros).toEqual([
      { name: 'code', pages: 1, occurrences: 1 },
      { name: 'excerpt', pages: 1, occurrences: 1 },
      { name: 'layout', pages: 1, occurrences: 1 },
      { name: 'status', pages: 1, occurrences: 1 },
      { name: 'toc', pages: 1, occurrences: 1 },
    ]);
    expect(summary.fences).toEqual([
      { name: 'block:ac:macro', pages: 1, occurrences: 1 },
      { name: 'inline:macro:status', pages: 1, occurrences: 1 },
      { name: 'layout', pages: 1, occurrences: 1 },
    ]);
    expect(summary.conventions).toEqual([
      { aspect: 'layout', value: 'ac:layout', pages: 1 },
      { aspect: 'layout', value: 'none', pages: 1 },
      { aspect: 'table shell', value: 'wrapped-colgroup', pages: 1 },
      { aspect: 'cell wrap', value: 'p', pages: 1 },
      { aspect: 'mention attribute', value: 'userkey', pages: 1 },
    ]);
  });
});
