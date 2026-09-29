import type { JiraFieldMetaMap } from '../client/types.js';

/** How long cached edit metadata answers before it is fetched again. */
export const EDITMETA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Edit metadata remembered per project and issue type, which is what the edit screen, the field
 * configuration and the option contexts depend on, so every issue of one type shares it. The CLI
 * writes it under `.lassi/cache/jira/editmeta/`.
 */
export interface EditmetaCache {
  schema: 1;
  baseUrl: string;
  project: string;
  issueTypeId: string;
  fetchedAt: string;
  fields: JiraFieldMetaMap;
}

export interface EditmetaCacheKey {
  baseUrl: string;
  project: string;
  issueTypeId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The stored value when it may stand in for a live fetch: the same schema, server, project and
 * issue type, and younger than `ttlMs`. A field it lacks is not on that edit screen, so a missing
 * field is no reason to fetch again.
 */
export function usableEditmetaCache(
  stored: unknown,
  want: EditmetaCacheKey & { now: Date; ttlMs?: number }
): EditmetaCache | undefined {
  if (!isRecord(stored) || stored['schema'] !== 1 || !isRecord(stored['fields'])) return undefined;
  if (
    stored['baseUrl'] !== want.baseUrl ||
    stored['project'] !== want.project ||
    stored['issueTypeId'] !== want.issueTypeId ||
    typeof stored['fetchedAt'] !== 'string'
  ) {
    return undefined;
  }
  const age = want.now.getTime() - Date.parse(stored['fetchedAt']);
  if (!(age >= 0 && age < (want.ttlMs ?? EDITMETA_CACHE_TTL_MS))) return undefined;
  return stored as unknown as EditmetaCache;
}
