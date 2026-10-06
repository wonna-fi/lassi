import { displayPath, pathApi } from '@wonna/lassi-core';
import {
  readCreatemetaCache,
  usableCreateType,
  type CreatemetaCache,
  type JiraClient,
  type JiraCreateMeta,
} from '@wonna/lassi-jira';
import type { Context } from '../../context.js';
import {
  jiraCreatemetaCachePath,
  lassiDirs,
  readJsonCache,
  writeJsonCache,
} from '../../workfile/index.js';
import { withStorageLock } from '../shared/storage.js';

interface LoadedCreatemeta {
  meta: JiraCreateMeta;
  cachedAt?: string;
}

function cachePath(ctx: Context, project: string): string {
  const dirs = lassiDirs(ctx.deps.cwd, ctx.config, ctx.loaded.workspaceStateDir);
  return jiraCreatemetaCachePath(dirs, project.toUpperCase());
}

async function readCache(
  ctx: Context,
  client: JiraClient,
  project: string
): Promise<CreatemetaCache | undefined> {
  try {
    return readCreatemetaCache(await readJsonCache(cachePath(ctx, project), ctx.deps.fs), {
      baseUrl: client.baseUrl,
      project: project.toUpperCase(),
    });
  } catch (err) {
    ctx.logger.warn(
      `could not read cached create metadata: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

async function store(
  ctx: Context,
  client: JiraClient,
  project: string,
  meta: JiraCreateMeta,
  allTypes: boolean
): Promise<void> {
  try {
    const path = cachePath(ctx, project);
    // Merge under the same lock used by other storage writers. Independent type refreshes must
    // not discard one another; readers see a complete snapshot through writeJsonCache's rename.
    await withStorageLock(ctx, pathApi(path).dirname(path), async () => {
      const previous = allTypes ? undefined : await readCache(ctx, client, project);
      const replaced = new Set(meta.issueTypes.map((type) => type.id));
      const fetchedAt = ctx.deps.now().toISOString();
      const entry: CreatemetaCache = {
        schema: 1,
        baseUrl: client.baseUrl,
        project: { ...meta.project, key: project.toUpperCase() },
        issueTypes: [
          ...(previous?.issueTypes.filter(({ type }) => !replaced.has(type.id)) ?? []),
          ...meta.issueTypes
            .filter((type) => Object.keys(type.fields).length > 0)
            .map((type) => ({ fetchedAt, mode: meta.mode, type })),
        ],
      };
      await writeJsonCache(path, entry, ctx.deps.fs);
    });
    ctx.logger.debug(`cached create metadata in ${displayPath(ctx.deps.cwd, path)}`);
  } catch (err) {
    ctx.logger.warn(
      `could not cache create metadata: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Explicit inspection always fetches live metadata and warms subsequent issue creation. */
export async function fetchCreatemeta(
  ctx: Context,
  client: JiraClient,
  project: string,
  issueType?: string
): Promise<JiraCreateMeta> {
  const scope = issueType
    ? `${project} (${issueType})`
    : `every issue type in ${project}; pass --type to narrow`;
  ctx.logger.warn(
    `fetching create metadata for ${scope}; Jira can take minutes to answer on a large project`
  );
  const meta = await client.createmeta(project, issueType);
  await store(ctx, client, project, meta, !issueType);
  return meta;
}

export async function loadCreatemeta(
  ctx: Context,
  client: JiraClient,
  project: string,
  issueType: string
): Promise<LoadedCreatemeta> {
  const cache = await readCache(ctx, client, project);
  const hit = cache && usableCreateType(cache, issueType, ctx.deps.now());
  if (hit) {
    return {
      meta: { project: cache.project, mode: hit.mode, issueTypes: [hit.type] },
      cachedAt: hit.fetchedAt,
    };
  }
  return { meta: await fetchCreatemeta(ctx, client, project, issueType) };
}
