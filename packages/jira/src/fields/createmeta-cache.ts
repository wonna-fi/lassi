import type { JiraCreateMeta, JiraIssueTypeMeta, JiraProjectRef } from '../client/types.js';

export const CREATEMETA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface CachedCreateType {
  fetchedAt: string;
  mode: JiraCreateMeta['mode'];
  type: JiraIssueTypeMeta;
}

/** Each type expires separately, so refreshing one cannot extend another's lifetime. */
export interface CreatemetaCache {
  schema: 1;
  baseUrl: string;
  project: JiraProjectRef;
  issueTypes: CachedCreateType[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCachedType(value: unknown): value is CachedCreateType {
  if (!isRecord(value) || typeof value['fetchedAt'] !== 'string') return false;
  if (value['mode'] !== 'paginated' && value['mode'] !== 'legacy') return false;
  const type = value['type'];
  if (
    !isRecord(type) ||
    typeof type['id'] !== 'string' ||
    typeof type['name'] !== 'string' ||
    typeof type['subtask'] !== 'boolean' ||
    !isRecord(type['fields'])
  )
    return false;
  const fields = Object.values(type['fields']);
  return (
    fields.length > 0 &&
    fields.every(
      (field) =>
        isRecord(field) &&
        typeof field['fieldId'] === 'string' &&
        typeof field['name'] === 'string' &&
        typeof field['required'] === 'boolean' &&
        isRecord(field['schema']) &&
        typeof field['schema']['type'] === 'string' &&
        (field['allowedValues'] === undefined ||
          (Array.isArray(field['allowedValues']) && field['allowedValues'].every(isRecord)))
    )
  );
}

/** Invalid entries are misses, including a cache belonging to another Jira instance. */
export function readCreatemetaCache(
  stored: unknown,
  want: { baseUrl: string; project: string }
): CreatemetaCache | undefined {
  if (
    !isRecord(stored) ||
    stored['schema'] !== 1 ||
    stored['baseUrl'] !== want.baseUrl ||
    !isRecord(stored['project']) ||
    stored['project']['key'] !== want.project ||
    !Array.isArray(stored['issueTypes']) ||
    !stored['issueTypes'].every(isCachedType)
  ) {
    return undefined;
  }
  return stored as unknown as CreatemetaCache;
}

export function usableCreateType(
  cache: CreatemetaCache,
  issueType: string,
  now: Date
): CachedCreateType | undefined {
  const matches = cache.issueTypes.filter(
    ({ type }) => type.id === issueType || type.name.toLowerCase() === issueType.toLowerCase()
  );
  if (matches.length !== 1) return undefined;
  const entry = matches[0]!;
  const age = now.getTime() - Date.parse(entry.fetchedAt);
  return age >= 0 && age < CREATEMETA_CACHE_TTL_MS ? entry : undefined;
}
