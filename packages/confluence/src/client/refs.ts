import { LassiError } from '@wonna/lassi-core';
import type { PageRef } from './types.js';

const SPACE_TITLE = /^(~?[A-Za-z0-9_.-]+):(\S.*)$/;

/** A hand-typed URL can hold a bare `%` (`Rollout 100%`), which `decodeURIComponent` rejects. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * a numeric id, `SPACE:Title`, a page URL (`pageId=`, `/spaces/S/pages/ID`,
 * `/display/S/Title`) or, with a default space, a bare title. Tiny links need the server.
 */
export function parsePageRef(input: string, defaultSpace?: string): PageRef {
  const text = input.trim();
  if (/^\d+$/.test(text)) return { kind: 'id', id: text };
  if (/^https?:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new LassiError('usage', `not a page reference: ${input}`);
    }
    const pageId = url.searchParams.get('pageId');
    if (pageId && /^\d+$/.test(pageId)) return { kind: 'id', id: pageId };
    const spaces = /\/spaces\/[^/]+\/pages\/(\d+)/.exec(url.pathname);
    if (spaces) return { kind: 'id', id: spaces[1] as string };
    const display = /\/display\/([^/]+)\/([^/?#]+)/.exec(url.pathname);
    if (display) {
      return {
        kind: 'title',
        space: decodeSegment(display[1] as string),
        title: decodeSegment((display[2] as string).replace(/\+/g, ' ')),
      };
    }
    if (/\/x\//.test(url.pathname)) {
      throw new LassiError('usage', `tiny links cannot be resolved offline: ${input}`, {
        hint: 'open the link and pass the pageId from the address bar',
      });
    }
    throw new LassiError('usage', `not a page URL lassi understands: ${input}`, {
      hint: 'pass the numeric page id, SPACE:Title, or a URL with pageId= or /display/SPACE/Title',
    });
  }
  const m = SPACE_TITLE.exec(text);
  if (m) return { kind: 'title', space: m[1] as string, title: m[2] as string };
  if (defaultSpace) return { kind: 'title', space: defaultSpace, title: text };
  throw new LassiError('usage', `not a page reference: ${input}`, {
    hint: 'pass a numeric id, SPACE:Title, a page URL, or set confluence.defaultSpace to use bare titles',
  });
}
