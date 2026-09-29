import { displayPath, isLassiError } from '@wonna/lassi-core';
import {
  usableEditmetaCache,
  type EditmetaCache,
  type JiraClient,
  type JiraFieldMetaMap,
  type JiraIssue,
} from '@wonna/lassi-jira';
import type { Context } from '../../context.js';
import {
  jiraEditmetaCachePath,
  lassiDirs,
  readJsonCache,
  writeJsonCache,
} from '../../workfile/index.js';

/** The issue fields that name its edit-metadata cache; a probe must include them. */
export const EDITMETA_PROBE_FIELDS = ['project', 'issuetype'];

export interface LoadedEditmeta {
  fields: JiraFieldMetaMap;
  fetchedAt: string;
  /** From `.lassi/cache/jira/editmeta/`, not from Jira. */
  cached: boolean;
}

const SLOW = 'Jira can take minutes to answer this on a large project';

function cacheKey(
  ctx: Context,
  client: JiraClient,
  probe: JiraIssue
): { path: string; project: string; issueTypeId: string; baseUrl: string } | undefined {
  const project = probe.fields.project?.key;
  const issueTypeId = probe.fields.issuetype?.id;
  if (project === undefined || issueTypeId === undefined) return undefined;
  const dirs = lassiDirs(ctx.deps.cwd, ctx.config, ctx.loaded.workspaceStateDir);
  return {
    path: jiraEditmetaCachePath(dirs, project, issueTypeId),
    project,
    issueTypeId,
    baseUrl: client.baseUrl,
  };
}

/** The cache only saves time: an entry that cannot be read is a miss, like a damaged one. */
async function readCache(ctx: Context, path: string): Promise<unknown> {
  try {
    return await readJsonCache(path, ctx.deps.fs);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(
      `could not read cached edit metadata ${displayPath(ctx.deps.cwd, path)}: ${reason}`
    );
    return undefined;
  }
}

/**
 * Remembers edit metadata for the issue's project and type. An empty answer is not stored: Jira
 * gives one for an issue in a status that forbids editing, and every other issue of that type would
 * inherit it. The cache only saves time, so failing to write it is a warning.
 */
async function store(
  ctx: Context,
  client: JiraClient,
  probe: JiraIssue,
  fields: JiraFieldMetaMap,
  fetchedAt: string
): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  const key = cacheKey(ctx, client, probe);
  if (!key) return;
  const entry: EditmetaCache = {
    schema: 1,
    baseUrl: key.baseUrl,
    project: key.project,
    issueTypeId: key.issueTypeId,
    fetchedAt,
    fields,
  };
  try {
    await writeJsonCache(key.path, entry, ctx.deps.fs);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    ctx.logger.warn(
      `could not cache edit metadata in ${displayPath(ctx.deps.cwd, key.path)}: ${reason}`
    );
  }
}

/**
 * Edit metadata for `update`, from the cache when it is fresh for the issue's project and type.
 * `probe` is an issue already fetched with `EDITMETA_PROBE_FIELDS`; without one, a cheap fetch
 * finds them.
 */
export async function loadEditmeta(
  ctx: Context,
  client: JiraClient,
  issueKey: string,
  opts: { fieldNames: string[]; probe?: JiraIssue }
): Promise<LoadedEditmeta> {
  const probe =
    opts.probe ?? (await client.getIssue(issueKey, { fields: EDITMETA_PROBE_FIELDS, expand: [] }));
  const key = cacheKey(ctx, client, probe);
  if (key) {
    const hit = usableEditmetaCache(await readCache(ctx, key.path), {
      ...key,
      now: ctx.deps.now(),
    });
    if (hit) return { fields: hit.fields, fetchedAt: hit.fetchedAt, cached: true };
  }
  ctx.logger.warn(
    `fetching edit metadata for ${issueKey} to check ${opts.fieldNames.join(', ')}; ${SLOW}`
  );
  const fields = await client.editmeta(issueKey);
  const fetchedAt = ctx.deps.now().toISOString();
  await store(ctx, client, probe, fields, fetchedAt);
  return { fields, fetchedAt, cached: false };
}

/** Live edit metadata for `issue editmeta`, stored for the next `update` of the same project and type. */
export async function fetchEditmeta(
  ctx: Context,
  client: JiraClient,
  issueKey: string
): Promise<JiraFieldMetaMap> {
  ctx.logger.warn(`fetching edit metadata for ${issueKey}; ${SLOW}`);
  const fields = await client.editmeta(issueKey);
  if (Object.keys(fields).length === 0) return fields;
  const fetchedAt = ctx.deps.now().toISOString();
  try {
    const probe = await client.getIssue(issueKey, { fields: EDITMETA_PROBE_FIELDS, expand: [] });
    await store(ctx, client, probe, fields, fetchedAt);
  } catch (err) {
    // The answer the user asked for is already here; a failed lookup only costs the cache.
    if (!isLassiError(err)) throw err;
    ctx.logger.warn(`could not cache edit metadata for ${issueKey}: ${err.message}`);
  }
  return fields;
}
