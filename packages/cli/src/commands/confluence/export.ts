import type { Command } from 'commander';
import {
  LassiError,
  displayPath,
  expandHome,
  isLassiError,
  pathApi,
  quoteLiteral,
  resolvePath,
  portablePath,
} from '@wonna/lassi-core';
import { serverContentId } from '../shared/identifiers.js';
import type { CliDeps } from '../../deps.js';
import { attach, type Session } from '../../run-command.js';
import { lassiDirs } from '../../workfile/index.js';
import { withStorageLock } from '../shared/storage.js';
import {
  assertNoExportConflicts,
  beginExport,
  finishExport,
  exportRenderHash,
  exportFileState,
  exportSummary,
  readExportManifest,
  writeExportManifest,
} from '../shared/export-manifest.js';
import { confluenceClient } from './shared.js';
import { buildPageDocument, savePageWorkingFile } from './workfile.js';

interface ExportOptions {
  space?: string;
  outDir?: string;
  limit?: string;
}

const EXPORT_CAP = 5000;

/**
 * `lassi confluence page export (--space KEY | <CQL>)`: every matching page as a working file with
 * its storage cache; unchanged pages (same version) are skipped.
 */
export function registerPageExport(page: Command, deps: CliDeps, session: Session): void {
  const cmd = page
    .command('export [CQL]')
    .description(
      'write every matching page as a working file (<dir>/<ID>.md) for offline reading and `lassi search index`'
    )
    .option('--space <KEY>', 'every page of the space (instead of a CQL)')
    .option(
      '--out-dir <dir>',
      'target directory (default: ~/.lassi/export/confluence; storage.exportDir/confluence)'
    )
    .option('--limit <N>', `stop after N pages (default ${EXPORT_CAP})`);
  attach<[string | undefined], ExportOptions>(cmd, deps, session, {
    kind: 'read',
    async run(ctx, [cqlArg], opts) {
      if (cqlArg !== undefined && opts.space !== undefined)
        throw new LassiError('usage', 'pass either a CQL or --space, not both');
      const space =
        opts.space ?? (cqlArg === undefined ? ctx.config.confluence.defaultSpace : undefined);
      const cql =
        cqlArg ??
        (space
          ? `space = ${quoteLiteral(space)} and type = page order by lastmodified desc`
          : undefined);
      if (!cql)
        throw new LassiError(
          'usage',
          'pass a CQL or --space <KEY> (or set confluence.defaultSpace)'
        );
      const limit = opts.limit === undefined ? EXPORT_CAP : Number(opts.limit);
      if (!Number.isSafeInteger(limit) || limit <= 0)
        throw new LassiError(
          'usage',
          `--limit must be a positive whole number, got "${opts.limit}"`
        );
      const client = await confluenceClient(ctx);
      const dir = opts.outDir
        ? resolvePath(deps.cwd, expandHome(opts.outDir, deps.homedir))
        : lassiDirs(deps.cwd, ctx.config, ctx.loaded.workspaceStateDir).export('confluence');
      const api = pathApi(dir);
      return withStorageLock(ctx, dir, async () => {
        const previous = await readExportManifest(deps.fs, dir);
        const manifest = await beginExport(deps.fs, dir, previous, {
          product: 'confluence',
          source: client.baseUrl,
          query: cql,
          limit,
          now: deps.now().toISOString(),
        });
        const renderHash = exportRenderHash('confluence', false);
        await writeExportManifest(deps.fs, dir, manifest);
        const stats = { total: 0, written: 0, unchanged: 0, failed: 0, truncated: false };
        const conflicts = new Map<string, string>();
        const files: string[] = [];
        const results = client.searchIter(cql, { max: limit, expand: ['version'] });
        for (;;) {
          const step = await results.next().catch(async (err: unknown) => {
            // A retry must recognize the files written before this page request failed.
            manifest.lastRun.failed['pagination'] = ctx.redact(
              err instanceof Error ? err.message : String(err)
            );
            manifest.lastRun.finishedAt = deps.now().toISOString();
            await writeExportManifest(deps.fs, dir, manifest);
            throw err;
          });
          if (step.done) {
            stats.truncated = step.value.truncated;
            break;
          }
          const hit = step.value;
          if (hit.type !== undefined && hit.type !== 'page') continue;
          stats.total += 1;
          try {
            // The id names the file, and it is the server's value, not the user's.
            const path = api.join(dir, `${serverContentId(hit.id)}.md`);
            const marker = String(hit.version?.number ?? '');
            const before = manifest.items[hit.id];
            if (!manifest.lastRun.keys.includes(hit.id)) manifest.lastRun.keys.push(hit.id);
            if (
              (await exportFileState(deps.fs, path, marker, before, renderHash)) === 'unchanged'
            ) {
              stats.unchanged += 1;
              if (before) {
                before.checkedAt = deps.now().toISOString();
                before.path = portablePath(path);
              }
              continue;
            }
            const fetched = await client.getPage(hit.id);
            const doc = await buildPageDocument(ctx, client, fetched, {
              comments: false,
              attachments: true,
            });
            // Fetching and converting can take time; an edit made during those reads must survive too.
            await exportFileState(deps.fs, path, marker, before, renderHash);
            const { sha256 } = await savePageWorkingFile(ctx, fetched, doc, path);
            stats.written += 1;
            files.push(displayPath(deps.cwd, path));
            manifest.items[hit.id] = {
              marker: String(fetched.version?.number ?? marker),
              path: portablePath(path),
              sha256,
              renderHash,
              checkedAt: deps.now().toISOString(),
              fetchedAt: deps.now().toISOString(),
              query: cql,
            };
          } catch (err) {
            stats.failed += 1;
            manifest.lastRun.failed[hit.id] = ctx.redact(
              err instanceof Error ? err.message : String(err)
            );
            if (isLassiError(err) && err.code === 'conflict') {
              conflicts.set(hit.id, err.message);
              continue;
            }
            ctx.logger.warn(
              `page ${hit.id}: ${isLassiError(err) ? err.message : String(err)}; skipped`
            );
          }
        }
        if (stats.truncated)
          ctx.logger.warn(`stopped at ${stats.total} pages; raise --limit to export more`);
        finishExport(manifest, stats, deps.now().toISOString());
        await writeExportManifest(deps.fs, dir, manifest);
        const shown = opts.outDir ? displayPath(deps.cwd, dir) : dir;
        assertNoExportConflicts(conflicts, exportSummary('pages', shown, stats));
        if (stats.failed > 0)
          throw new LassiError('validation', `${stats.failed} items could not be exported`, {
            errorMessages: Object.values(manifest.lastRun.failed),
            hint: 'inspect manifest.json lastRun.failed and retry the export',
          });
        const data = {
          mode: 'archive',
          source: manifest.source,
          coverage: manifest.lastRun,
          queries: manifest.queries,
          dir: shown,
          cql,
          ...stats,
          files,
        };
        return {
          markdown: exportSummary('pages', shown, stats),
          data,
          axi: {
            data: {
              mode: 'archive',
              dir: shown,
              cql,
              ...stats,
              complete: manifest.lastRun.complete,
              queries: manifest.queries,
            },
          },
        };
      });
    },
  });
}
