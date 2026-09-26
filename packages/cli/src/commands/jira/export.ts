import type { Command } from 'commander';
import {
  LassiError,
  displayPath,
  expandHome,
  isLassiError,
  pathApi,
  resolvePath,
  portablePath,
} from '@wonna/lassi-core';
import type { JiraIssue } from '@wonna/lassi-jira';
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
import { serverIssueKey } from '../shared/identifiers.js';
import { jiraClient } from './shared.js';
import { buildIssueDocument, loadIssueComments, saveIssueWorkingFile } from './workfile.js';

interface ExportOptions {
  outDir?: string;
  limit?: string;
  comments?: boolean;
}

const EXPORT_PAGE = 100;
const EXPORT_CAP = 5000;

/**
 * `lassi jira issue export <JQL>`: every matching issue as a working file plus its cache, streamed
 * page by page so memory stays flat; unchanged issues (same `updated`) are skipped.
 */
export function registerIssueExport(issue: Command, deps: CliDeps, session: Session): void {
  const cmd = issue
    .command('export <JQL>')
    .description(
      'write every matching issue as a working file (<dir>/<KEY>.md) for offline reading and `lassi search index`'
    )
    .option(
      '--out-dir <dir>',
      'target directory (default: ~/.lassi/export/jira; storage.exportDir/jira)'
    )
    .option('--limit <N>', `stop after N issues (default ${EXPORT_CAP})`)
    .option('--comments', 'include the comments section in every file');
  attach<[string], ExportOptions>(cmd, deps, session, {
    kind: 'read',
    async run(ctx, [jql], opts) {
      const limit = opts.limit === undefined ? EXPORT_CAP : Number(opts.limit);
      if (!Number.isSafeInteger(limit) || limit <= 0)
        throw new LassiError(
          'usage',
          `--limit must be a positive whole number, got "${opts.limit}"`
        );
      const client = await jiraClient(ctx);
      const dir = opts.outDir
        ? resolvePath(deps.cwd, expandHome(opts.outDir, deps.homedir))
        : lassiDirs(deps.cwd, ctx.config, ctx.loaded.workspaceStateDir).export('jira');
      const api = pathApi(dir);
      return withStorageLock(ctx, dir, async () => {
        const previous = await readExportManifest(deps.fs, dir);
        const manifest = await beginExport(deps.fs, dir, previous, {
          product: 'jira',
          source: client.baseUrl,
          query: jql,
          limit,
          now: deps.now().toISOString(),
        });
        const renderHash = exportRenderHash('jira', opts.comments === true, ctx.config.jira.fields);
        await writeExportManifest(deps.fs, dir, manifest);
        const stats = { total: 0, written: 0, unchanged: 0, failed: 0, truncated: false };
        const conflicts = new Map<string, string>();
        const files: string[] = [];
        const pages = client.searchPages({
          jql,
          fields: ['*all'],
          expand: ['names', 'schema'],
          pageSize: Math.min(EXPORT_PAGE, limit),
          cap: limit,
        });
        for (;;) {
          const step = await pages.next().catch(async (err: unknown) => {
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
          const page = step.value;
          for (const raw of page.issues) {
            // Names and schema arrive once per page; the frontmatter builder expects them per issue.
            const fetched: JiraIssue = {
              ...raw,
              ...((raw.names ?? page.names) ? { names: raw.names ?? page.names } : {}),
              ...((raw.schema ?? page.schema) ? { schema: raw.schema ?? page.schema } : {}),
            };
            stats.total += 1;
            try {
              // The key names the file, and it is the server's value, not the user's.
              const path = api.join(dir, `${serverIssueKey(fetched.key)}.md`);
              const marker = fetched.fields.updated ?? '';
              const before = manifest.items[fetched.key];
              if (!manifest.lastRun.keys.includes(fetched.key))
                manifest.lastRun.keys.push(fetched.key);
              const state = await exportFileState(deps.fs, path, marker, before, renderHash);
              if (state === 'unchanged' && (!opts.comments || before?.commentsComplete === true)) {
                stats.unchanged += 1;
                if (before) {
                  before.checkedAt = deps.now().toISOString();
                  before.path = portablePath(path);
                }
                continue;
              }
              const expanded = await loadIssueComments(
                client,
                fetched,
                opts.comments ? 'all' : undefined
              );
              if (expanded.fields.comment?.incomplete)
                throw new LassiError(
                  'validation',
                  `comments for ${fetched.key} were incomplete; retry the export`
                );
              const doc = buildIssueDocument(ctx, client, expanded, {
                comments: opts.comments ? 'all' : undefined,
                attachments: true,
                links: true,
              });
              await exportFileState(deps.fs, path, marker, before, renderHash);
              const { sha256 } = await saveIssueWorkingFile(ctx, expanded, doc, path);
              stats.written += 1;
              files.push(displayPath(deps.cwd, path));
              manifest.items[fetched.key] = {
                marker,
                path: portablePath(path),
                sha256,
                renderHash,
                checkedAt: deps.now().toISOString(),
                fetchedAt: deps.now().toISOString(),
                query: jql,
                commentsComplete: opts.comments === true,
              };
            } catch (err) {
              stats.failed += 1;
              manifest.lastRun.failed[fetched.key] = ctx.redact(
                err instanceof Error ? err.message : String(err)
              );
              if (isLassiError(err) && err.code === 'conflict') {
                conflicts.set(fetched.key, err.message);
                continue;
              }
              ctx.logger.warn(
                `${fetched.key}: ${isLassiError(err) ? err.message : String(err)}; skipped`
              );
            }
          }
        }
        if (stats.truncated)
          ctx.logger.warn(`stopped at ${stats.total} issues; raise --limit to export more`);
        finishExport(manifest, stats, deps.now().toISOString());
        await writeExportManifest(deps.fs, dir, manifest);
        const shown = opts.outDir ? displayPath(deps.cwd, dir) : dir;
        assertNoExportConflicts(conflicts, exportSummary('issues', shown, stats));
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
          jql,
          ...stats,
          files,
        };
        return {
          markdown: exportSummary('issues', shown, stats),
          data,
          axi: {
            data: {
              mode: 'archive',
              dir: shown,
              jql,
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
