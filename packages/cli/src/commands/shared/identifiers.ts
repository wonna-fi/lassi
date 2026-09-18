import { LassiError } from '@wonna/lassi-core';
import { isIssueKey } from '@wonna/lassi-jira';

/** Confluence content ids are decimal, everywhere in the DC REST API. */
const CONTENT_ID = /^\d+$/;

function reject(product: string, what: string, value: string): LassiError {
  return new LassiError('internal', `${product} returned ${what}: ${JSON.stringify(value)}`, {
    hint: 'the identifier names a file under .lassi, so it is refused rather than joined into a path',
  });
}

/**
 * An issue key that came back from the server, checked before it names a file. `join` normalises
 * `..`, so a response key of `../../../.bashrc` would write outside the export and cache
 * directories. Command arguments already go through `assertIssueKey`; this is the same rule in the
 * other direction, where the value is not the user's.
 */
export function serverIssueKey(key: string): string {
  if (!isIssueKey(key)) throw reject('Jira', 'an issue key that is not one', key);
  return key;
}

/** The same rule for Confluence content ids, which name the export file and the storage cache. */
export function serverContentId(id: string): string {
  if (!CONTENT_ID.test(id)) throw reject('Confluence', 'a content id that is not one', id);
  return id;
}
