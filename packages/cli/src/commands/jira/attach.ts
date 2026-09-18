import type { Command } from 'commander';
import {
  LassiError,
  displayPath,
  isLassiError,
  pathApi,
  resolvePath,
  toErrorJson,
  type ErrorJson,
} from '@wonna/lassi-core';
import type { DownloadResult, JiraAttachment } from '@wonna/lassi-jira';
import type { CliDeps } from '../../deps.js';
import { guardWrite } from '../../guard-write.js';
import { dryRunData } from '../../output/dry-run.js';
import { renderTable } from '../../output/table.js';
import { attach, enrichError, type Session } from '../../run-command.js';
import { lassiDirs } from '../../workfile/index.js';
import { mimeFor, selectAttachments } from '../shared/attachments.js';
import { resolveIssueKey } from './issue-key.js';
import { attachmentName } from './attachment-name.js';
import { group, jiraClient } from './shared.js';

interface GetOptions {
  out?: string;
  only?: string;
  maxSize?: string;
}

export function registerAttach(jira: Command, deps: CliDeps, session: Session): void {
  const att = group(jira, 'attach', 'attachments (files on disk, never in the context window)');
  const get = att
    .command('get <KEY>')
    .description('download attachments as <ID>-<filename>; preserve existing local content')
    .option('--out <dir>', 'target directory (default: .lassi/<KEY>/)')
    .option('--only <glob>', 'only filenames matching the glob, e.g. "*.png"')
    .option('--max-size <MB>', 'skip files larger than this (default: attachments.maxSizeMb)');
  attach<[string], GetOptions>(get, deps, session, {
    kind: 'read',
    async run(ctx, [keyArg], opts) {
      const key = await resolveIssueKey(ctx, keyArg);
      const client = await jiraClient(ctx);
      const maxMb =
        opts.maxSize === undefined ? ctx.config.attachments.maxSizeMb : Number(opts.maxSize);
      if (!Number.isFinite(maxMb) || maxMb <= 0)
        throw new LassiError(
          'usage',
          `--max-size must be a positive number of MB, got "${opts.maxSize}"`
        );
      const maxBytes = Math.floor(maxMb * 1024 * 1024);
      const dir = opts.out
        ? resolvePath(deps.cwd, opts.out)
        : lassiDirs(deps.cwd, ctx.config, ctx.loaded.workspaceStateDir).attachments(key);
      const api = pathApi(dir);
      const all = await client.listAttachments(key);
      const selected = selectAttachments(all, opts.only);
      const rows: Array<{
        id: string;
        file: string;
        path: string;
        size: number;
        mime: string;
        status: 'saved' | 'unchanged' | 'skipped' | 'failed' | 'preserved';
        reason?: string;
        error?: ErrorJson;
      }> = [];
      let firstError: LassiError | undefined;
      for (const a of selected) {
        let dest = '';
        let result: DownloadResult;
        try {
          dest = api.join(dir, attachmentName(a.id, a.filename));
          result = await client.downloadAttachment(a, dest, { maxBytes, preserveExisting: true });
        } catch (err) {
          const failure = enrichError(
            isLassiError(err)
              ? err
              : new LassiError('internal', err instanceof Error ? err.message : String(err)),
            ctx
          );
          firstError ??= failure;
          rows.push({
            id: a.id,
            file: a.filename,
            path: dest ? displayPath(deps.cwd, dest) : '',
            size: a.size,
            mime: a.mimeType,
            status: failure.code === 'conflict' ? 'preserved' : 'failed',
            reason: failure.message,
            error: toErrorJson(failure),
          });
          continue;
        }
        if (result.status === 'skipped') {
          rows.push({
            id: a.id,
            file: a.filename,
            path: '',
            size: a.size,
            mime: a.mimeType,
            status: 'skipped',
            reason: `${a.size} B > ${maxBytes} B`,
          });
        } else {
          rows.push({
            id: a.id,
            file: a.filename,
            path: displayPath(deps.cwd, dest),
            size: result.bytes,
            mime: result.mimeType,
            status: result.status,
          });
        }
      }
      const table = renderTable(
        [
          { key: 'id', header: 'Id' },
          { key: 'file', header: 'File' },
          { key: 'path', header: 'Path' },
          { key: 'size', header: 'Bytes' },
          { key: 'mime', header: 'MIME' },
          { key: 'status', header: 'Status' },
          { key: 'reason', header: 'Detail' },
        ],
        rows.map((row) => (row.error ? { ...row, reason: JSON.stringify(row.error) } : row))
      );
      const header =
        selected.length === 0
          ? `no attachments${opts.only ? ` matching ${opts.only}` : ''} on ${key}\n`
          : '';
      const summary = {
        key,
        saved: rows.filter((r) => r.status === 'saved').length,
        unchanged: rows.filter((r) => r.status === 'unchanged').length,
        skipped: rows.filter((r) => r.status === 'skipped').length,
        failed: rows.filter((r) => r.error !== undefined).length,
        complete: rows.every((r) => r.status === 'saved' || r.status === 'unchanged'),
        files: rows,
      };
      return {
        markdown: `${header}${selected.length > 0 ? `# ${key} attachments\n\n${table}` : ''}`,
        data: summary,
        axi: { data: summary },
        ...(firstError
          ? {
              error: new LassiError(
                firstError.code,
                `${summary.failed} of ${selected.length} attachments failed; ${summary.saved} saved, ${summary.unchanged} unchanged`,
                {
                  ...(firstError.http === undefined ? {} : { http: firstError.http }),
                  ...(firstError.request === undefined ? {} : { request: firstError.request }),
                  ...(firstError.errors === undefined ? {} : { errors: firstError.errors }),
                  errorMessages: rows.flatMap((r) =>
                    r.error ? (r.error.errorMessages ?? [r.error.message]) : []
                  ),
                  hint: 'inspect files[].error and retry only failed attachments with --only, or use another --out directory for preserved files',
                  context: { product: 'jira', issueKey: key },
                }
              ),
            }
          : {}),
      };
    },
  });

  const upload = att
    .command('upload <KEY> <file...>')
    .description('upload files as attachments (multipart with X-Atlassian-Token: no-check)');
  attach<[string, string[]], Record<string, never>>(upload, deps, session, {
    kind: 'write',
    async run(ctx, [keyArg, files]) {
      const key = await resolveIssueKey(ctx, keyArg);
      const client = await jiraClient(ctx);
      const maxMb = ctx.config.attachments.maxSizeMb;
      const maxBytes = Math.floor(maxMb * 1024 * 1024);
      const planned: Array<{ arg: string; path: string; name: string; size: number }> = [];
      // Every file is checked before the first upload: a multi-file call must not stop halfway
      // because of a typo in the last argument.
      for (const arg of files) {
        const path = resolvePath(deps.cwd, arg);
        let size: number;
        try {
          const stat = await deps.fs.stat(path);
          if (stat.isDirectory) throw new LassiError('usage', `${arg} is a directory`);
          size = stat.size;
        } catch (err) {
          if (isLassiError(err)) throw err;
          throw new LassiError('usage', `file not found: ${arg}`, { cause: err });
        }
        if (size > maxBytes) {
          throw new LassiError(
            'usage',
            `${arg} is ${size} bytes, above attachments.maxSizeMb (${maxMb} MB)`,
            { hint: 'raise attachments.maxSizeMb in .lassi.json or split the file' }
          );
        }
        planned.push({ arg, path, name: pathApi(path).basename(path), size });
      }
      const preview = {
        method: 'POST' as const,
        path: `/rest/api/2/issue/${key}/attachments`,
        payloadLabel: 'files (multipart)',
        payload: planned.map((p) => `${p.name} (${p.size} B)`).join('\n'),
      };
      if (guardWrite(ctx, preview) === 'dry-run') return { data: dryRunData(preview) };
      const rows: Array<{ file: string; id: string; size: number; mime: string }> = [];
      for (const [i, p] of planned.entries()) {
        let uploaded: JiraAttachment[];
        try {
          const mime = mimeFor(p.name);
          uploaded = await client.uploadAttachment(key, {
            data: await deps.fs.readBytes(p.path),
            filename: p.name,
            ...(mime === undefined ? {} : { contentType: mime }),
          });
        } catch (err) {
          // Uploads are not idempotent, so the run stops here and says what already landed.
          if (isLassiError(err) && i > 0) {
            err.message = `uploaded ${i} of ${planned.length} files, then ${p.arg} failed: ${err.message}`;
          }
          throw err;
        }
        const first = uploaded[0];
        rows.push({
          file: p.name,
          id: first?.id ?? '',
          size: first?.size ?? p.size,
          mime: first?.mimeType ?? mimeFor(p.name) ?? '',
        });
      }
      const table = renderTable(
        [
          { key: 'file', header: 'File' },
          { key: 'id', header: 'Id' },
          { key: 'size', header: 'Bytes' },
          { key: 'mime', header: 'MIME' },
        ],
        rows
      );
      return {
        markdown: `uploaded ${rows.length} file${rows.length === 1 ? '' : 's'} to ${key}\n\n${table}`,
        data: { key, files: rows },
      };
    },
  });
}
