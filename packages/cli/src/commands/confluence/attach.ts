import type { Command } from 'commander';
import { LassiError, displayPath, pathApi, resolvePath } from '@wonna/lassi-core';
import type { DownloadResult } from '@wonna/lassi-confluence';
import type { CliDeps } from '../../deps.js';
import { renderTable } from '../../output/table.js';
import { attach, type Session } from '../../run-command.js';
import { lassiDirs } from '../../workfile/index.js';
import { safeFilename, selectAttachments } from '../shared/attachments.js';
import { confluenceClient, group } from './shared.js';

interface GetOptions {
  out?: string;
  only?: string;
  maxSize?: string;
}

export function registerAttach(confluence: Command, deps: CliDeps, session: Session): Command {
  const att = group(
    confluence,
    'attach',
    'attachments (files on disk, never in the context window)'
  );
  const get = att
    .command('get <PAGE_ID>')
    .description('download all (or matching) attachments to <dir>/<PAGE_ID>/')
    .option('--out <dir>', 'target directory (default: .lassi/<PAGE_ID>/)')
    .option('--only <glob>', 'only filenames matching the glob, e.g. "*.png"')
    .option('--max-size <MB>', 'skip files larger than this (default: attachments.maxSizeMb)');
  attach<[string], GetOptions>(get, deps, session, {
    kind: 'read',
    async run(ctx, [pageId], opts) {
      const client = await confluenceClient(ctx);
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
        : lassiDirs(deps.cwd, ctx.config, ctx.loaded.workspaceStateDir).attachments(pageId);
      const api = pathApi(dir);
      const all = await client.listAttachments(pageId);
      // `attach get` says it downloads all of them, so a capped walk has to be said out loud.
      if (all.truncated)
        ctx.logger.warn(
          `page ${pageId} has more attachments than one walk returns (1000); only the first are listed`
        );
      const selected = selectAttachments(all.items, opts.only);
      const rows: Array<{
        file: string;
        path: string;
        size: number;
        mime: string;
        status: string;
      }> = [];
      let failures = 0;
      for (const a of selected) {
        const dest = api.join(dir, safeFilename(a.filename));
        let result: DownloadResult;
        try {
          result = await client.downloadAttachment(a, dest, { maxBytes });
        } catch (err) {
          failures += 1;
          ctx.logger.warn(`${a.filename}: ${(err as Error).message}`);
          rows.push({
            file: a.filename,
            path: '',
            size: a.size,
            mime: a.mediaType,
            status: `failed: ${(err as Error).message}`,
          });
          continue;
        }
        if (result.status === 'skipped') {
          rows.push({
            file: a.filename,
            path: '',
            size: a.size,
            mime: a.mediaType,
            status: `skipped (${a.size} B > ${maxBytes} B)`,
          });
        } else {
          rows.push({
            file: a.filename,
            path: displayPath(deps.cwd, dest),
            size: result.bytes,
            mime: result.mimeType,
            status: 'saved',
          });
        }
      }
      const table = renderTable(
        [
          { key: 'file', header: 'File' },
          { key: 'path', header: 'Path' },
          { key: 'size', header: 'Bytes' },
          { key: 'mime', header: 'MIME' },
          { key: 'status', header: 'Status' },
        ],
        rows
      );
      const header =
        selected.length === 0
          ? `no attachments${opts.only ? ` matching ${opts.only}` : ''} on page ${pageId}\n`
          : '';
      return {
        markdown: `${header}${selected.length > 0 ? `# ${pageId} attachments\n\n${table}` : ''}`,
        data: { pageId, files: rows },
        axi: {
          data: {
            pageId,
            saved: rows.filter((r) => r.status === 'saved').length,
            skipped: rows.filter((r) => r.status.startsWith('skipped')).length,
            failed: failures,
            files: rows,
          },
        },
        exitCode: selected.length > 0 && failures === selected.length ? 1 : 0,
      };
    },
  });
  return att;
}
