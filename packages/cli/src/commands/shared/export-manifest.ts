import { createHash, randomUUID } from 'node:crypto';
import { LassiError, pathApi, splitFrontmatter, type LassiFs } from '@wonna/lassi-core';

export interface ExportEntry {
  marker: string;
  /** Absolute source path; older entries may be relative to the exporting workspace. */
  path: string;
  /** Absent on older exports that did not record a content baseline. */
  sha256?: string;
  renderHash?: string;
  checkedAt?: string;
  fetchedAt?: string;
  query?: string;
  /** Only true after the paginated discussion was retrieved completely. */
  commentsComplete?: boolean;
}

/** `<dir>/manifest.json`: what an export wrote, so the next run skips unchanged items. */
export interface ExportRun {
  query: string;
  startedAt: string;
  finishedAt?: string;
  limit: number;
  keys: string[];
  failed: Record<string, string>;
  truncated: boolean;
  complete: boolean;
}

export interface ExportManifest {
  schema: 1;
  mode?: 'archive';
  source?: string;
  queries?: string[];
  lastRun?: ExportRun;
  runs?: ExportRun[];
  product: 'jira' | 'confluence';
  /** The JQL or CQL the export was made from. */
  query: string;
  exportedAt: string;
  /** Issue key or page id → the change marker (`updated` or `version`) and the file written. */
  items: Record<string, ExportEntry>;
}

export const EXPORT_MANIFEST_FILE = 'manifest.json';

/** Recognizable export metadata stays protected even when strict validation fails. */
export function isExportCandidate(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const product =
    'product' in value && (value.product === 'jira' || value.product === 'confluence');
  const queryItems = 'query' in value && 'items' in value;
  return (
    (product && ('exportedAt' in value || queryItems)) ||
    ('schema' in value && value.schema === 1 && 'exportedAt' in value && queryItems)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRun(value: unknown): value is ExportRun {
  return (
    isRecord(value) &&
    typeof value['query'] === 'string' &&
    typeof value['startedAt'] === 'string' &&
    (value['finishedAt'] === undefined || typeof value['finishedAt'] === 'string') &&
    Number.isSafeInteger(value['limit']) &&
    (value['limit'] as number) > 0 &&
    Array.isArray(value['keys']) &&
    value['keys'].every((key) => typeof key === 'string') &&
    isRecord(value['failed']) &&
    Object.values(value['failed']).every((error) => typeof error === 'string') &&
    typeof value['truncated'] === 'boolean' &&
    typeof value['complete'] === 'boolean'
  );
}

/** Everything the exporters read off a manifest, checked before any of it is trusted. */
export function isExportManifest(value: unknown): value is ExportManifest {
  if (!isRecord(value) || value['schema'] !== 1) return false;
  if (value['product'] !== 'jira' && value['product'] !== 'confluence') return false;
  if (typeof value['query'] !== 'string' || typeof value['exportedAt'] !== 'string') return false;
  if (value['mode'] !== undefined && value['mode'] !== 'archive') return false;
  if (value['source'] !== undefined && typeof value['source'] !== 'string') return false;
  if (
    value['queries'] !== undefined &&
    (!Array.isArray(value['queries']) || !value['queries'].every((q) => typeof q === 'string'))
  )
    return false;
  if (value['lastRun'] !== undefined && !isRun(value['lastRun'])) return false;
  if (value['runs'] !== undefined && (!Array.isArray(value['runs']) || !value['runs'].every(isRun)))
    return false;
  const items = value['items'];
  if (!isRecord(items)) return false;
  return Object.values(items).every(
    (item) =>
      isRecord(item) &&
      typeof item['marker'] === 'string' &&
      typeof item['path'] === 'string' &&
      ['renderHash', 'checkedAt', 'fetchedAt', 'query'].every(
        (key) => item[key] === undefined || typeof item[key] === 'string'
      ) &&
      (item['commentsComplete'] === undefined || typeof item['commentsComplete'] === 'boolean') &&
      (item['sha256'] === undefined ||
        (typeof item['sha256'] === 'string' && /^[a-f0-9]{64}$/.test(item['sha256'])))
  );
}

/** A server change marker cannot tell whether an agent has edited the exported file. */
export async function exportFileState(
  fs: LassiFs,
  path: string,
  marker: string,
  before: ExportEntry | undefined,
  renderHash?: string
): Promise<'write' | 'unchanged'> {
  if (!(await fs.exists(path))) return 'write';
  const hash = createHash('sha256')
    .update(await fs.readBytes(path))
    .digest('hex');
  if (before?.sha256 === undefined || hash !== before.sha256) {
    const reason =
      before?.sha256 === undefined ? 'has no recorded content hash' : 'has local edits';
    throw new LassiError('conflict', `${path} ${reason}; preserved`);
  }
  return marker !== '' &&
    before.marker === marker &&
    (renderHash === undefined || before.renderHash === renderHash)
    ? 'unchanged'
    : 'write';
}

export function assertNoExportConflicts(
  conflicts: ReadonlyMap<string, string>,
  summary: string
): void {
  if (conflicts.size === 0) return;
  const files = `${conflicts.size} local file${conflicts.size === 1 ? '' : 's'}`;
  throw new LassiError('conflict', `${summary.trim()}; ${files} preserved`, {
    errorMessages: [...conflicts.values()],
    hint: 'back up the preserved files, remove only their export copies, then rerun export; use get --out to create a separately tracked working copy for edits',
  });
}

export async function readExportManifest(
  fs: LassiFs,
  dir: string
): Promise<ExportManifest | undefined> {
  const path = pathApi(dir).join(dir, EXPORT_MANIFEST_FILE);
  if (!(await fs.exists(path))) return undefined;
  let parsed: ExportManifest;
  try {
    parsed = JSON.parse(await fs.readFile(path)) as ExportManifest;
  } catch (err) {
    // Preserve the state so a repaired manifest can still distinguish an untouched export from
    // a local edit. Treating damage as an absent manifest would discard those baselines.
    if (err instanceof SyntaxError) {
      throw new LassiError(
        'usage',
        `${path} is not valid JSON, so this export cannot tell what it already wrote`,
        {
          hint: 'restore the manifest from version control, or move the export directory aside and export into a fresh directory',
          cause: err,
        }
      );
    }
    throw err;
  }
  // A valid schema number alone says nothing about the file baselines inside the manifest.
  if (!isExportManifest(parsed)) {
    throw new LassiError(
      'usage',
      `${path} is not a schema-1 export manifest, so this export cannot tell what it already wrote`,
      {
        hint: 'restore the manifest from version control, or move the export directory aside and export into a fresh directory',
      }
    );
  }
  return parsed;
}

export async function writeExportManifest(
  fs: LassiFs,
  dir: string,
  manifest: ExportManifest
): Promise<void> {
  const path = pathApi(dir).join(dir, EXPORT_MANIFEST_FILE);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.rename(temporary, path);
  } finally {
    if (await fs.exists(temporary)) await fs.unlink(temporary);
  }
}

export interface ExportStats {
  total: number;
  written: number;
  unchanged: number;
  failed: number;
  truncated: boolean;
}

export function exportSummary(what: string, dir: string, stats: ExportStats): string {
  const parts = [`${stats.unchanged} unchanged`, `${stats.written} written`];
  if (stats.failed > 0) parts.push(`${stats.failed} failed`);
  const note = stats.truncated ? '; stopped at the --limit' : '';
  return `exported ${stats.total} ${what} to ${dir} (${parts.join(', ')})${note}\n`;
}

export function exportRenderHash(
  product: ExportManifest['product'],
  comments: boolean,
  aliases: Record<string, string> = {}
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        renderer: 1,
        product,
        comments,
        aliases: Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b)),
      })
    )
    .digest('hex');
}

type ActiveExport = ExportManifest & {
  source: string;
  mode: 'archive';
  queries: string[];
  lastRun: ExportRun;
};

/** An export directory accumulates an archive from one server, never an implied live query snapshot. */
export async function beginExport(
  fs: LassiFs,
  dir: string,
  previous: ExportManifest | undefined,
  input: {
    product: ExportManifest['product'];
    source: string;
    query: string;
    limit: number;
    now: string;
  }
): Promise<ActiveExport> {
  if (
    previous &&
    (previous.product !== input.product ||
      (previous.source !== undefined && previous.source !== input.source))
  ) {
    throw new LassiError('usage', 'the export directory belongs to another product or server', {
      hint: 'use a separate --out-dir for each server and product',
    });
  }
  // Older manifests can be adopted only when their files identify the same server.
  if (previous && previous.source === undefined) {
    const prefix =
      input.product === 'jira'
        ? `${input.source}/browse/`
        : `${input.source}/pages/viewpage.action?`;
    for (const key of Object.keys(previous.items)) {
      if (!/^[A-Za-z0-9_-]+$/.test(key))
        throw new LassiError('usage', 'invalid identifier in export manifest');
      const path = pathApi(dir).join(dir, `${key}.md`);
      if (!(await fs.exists(path))) continue;
      const { data } = splitFrontmatter(await fs.readFile(path));
      const readonly = data?.['readonly'];
      if (
        !isRecord(readonly) ||
        typeof readonly['url'] !== 'string' ||
        !readonly['url'].startsWith(prefix)
      ) {
        throw new LassiError('conflict', `cannot verify the source of ${path}; preserved`, {
          hint: 'keep these files and use a fresh --out-dir for this server',
        });
      }
    }
  }
  return {
    schema: 1,
    mode: 'archive',
    source: input.source,
    product: input.product,
    query: previous?.query ?? input.query,
    queries: [
      ...new Set([...(previous?.queries ?? (previous ? [previous.query] : [])), input.query]),
    ],
    exportedAt: input.now,
    items: { ...previous?.items },
    runs: [...(previous?.runs ?? []), ...(previous?.lastRun ? [previous.lastRun] : [])].slice(-20),
    lastRun: {
      query: input.query,
      startedAt: input.now,
      limit: input.limit,
      keys: [],
      failed: Object.create(null) as Record<string, string>,
      truncated: false,
      complete: false,
    },
  };
}

export function finishExport(manifest: ActiveExport, stats: ExportStats, now: string): void {
  manifest.lastRun.finishedAt = now;
  manifest.lastRun.truncated = stats.truncated;
  manifest.lastRun.complete = stats.failed === 0 && !stats.truncated;
}
