/** Characters XML 1.0 forbids in text (C0 controls other than tab, LF, CR); dropped, not escaped. */
function stripControl(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) continue;
    out += ch;
  }
  return out;
}

const NBSP = /\u00A0/g;

/** Text content escaping for storage XHTML; U+00A0 keeps its entity. */
export function escapeText(text: string): string {
  return stripControl(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(NBSP, '&nbsp;');
}

export function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;');
}

/**
 * A CDATA section; a literal `]]>` inside is split across two sections. Controls are dropped here
 * too: CDATA exempts its content from escaping, not from what XML 1.0 allows at all, and the
 * fidelity gate reparses with the same non-validating parser, so a U+000C in a code fence looked
 * equal on both sides and the server answered 400.
 */
export function cdata(text: string): string {
  return `<![CDATA[${stripControl(text).replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}
