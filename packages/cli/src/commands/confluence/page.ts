import type { Command } from 'commander';
import { LassiError, displayPath, resolvePath } from '@wonna/lassi-core';
import type { CliDeps } from '../../deps.js';
import { renderEntity } from '../../output/entity.js';
import { attach, type Session } from '../../run-command.js';
import { registerPageExport } from './export.js';
import { registerPageWrites } from './page-write.js';
import { confluenceClient, group, resolvePage } from './shared.js';
import { buildPageDocument, savePageWorkingFile, type PageDocument } from './workfile.js';

/** The `--axi` view of a page: identity, read-only facts and counts flat, then the body. */
function pageAxi(doc: PageDocument): Record<string, unknown> {
  const { readonly, counts, lassi, ...rest } = doc.frontmatter;
  const out: Record<string, unknown> = {
    page: { ...rest, ...readonly, counts, format: lassi.format },
    body: doc.description,
  };
  let hidden = 0;
  if (doc.comments) {
    out['comments'] = doc.comments.map((c) => ({
      id: c.id,
      author: c.author?.username ?? null,
      created: c.created ?? null,
      body: doc.converter.toMarkdown(c.storage).trimEnd(),
    }));
  } else hidden += counts.comments;
  if (doc.attachments) {
    out['attachments'] = doc.attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      size: a.size,
      mediaType: a.mediaType,
    }));
  } else hidden += counts.attachments;
  out['hidden'] = hidden;
  return out;
}

interface GetOptions {
  out?: string;
  format?: string;
  comments?: boolean;
  attachments?: boolean;
}

export function registerPage(confluence: Command, deps: CliDeps, session: Session): Command {
  const page = group(confluence, 'page', 'read, create, update and validate pages');

  const get = page
    .command('get <ID|"SPACE:Title">')
    .description(
      'page as markdown with frontmatter; counts of children, comments and attachments are always shown'
    )
    .option(
      '--out <file>',
      'write the working file (and cache the original storage) instead of printing'
    )
    .option(
      '--format <md|storage|view>',
      'md (default), the raw storage XHTML, or the rendered view as markdown (read-only)',
      'md'
    )
    .option('--comments', 'include footer comments')
    .option('--attachments', 'include the attachment table');
  attach<[string], GetOptions>(get, deps, session, {
    kind: 'read',
    async run(ctx, [ref], opts) {
      const format = opts.format ?? 'md';
      if (format !== 'md' && format !== 'storage' && format !== 'view') {
        throw new LassiError('usage', `--format must be md, storage or view, got "${format}"`);
      }
      const client = await confluenceClient(ctx);
      const fetched = await resolvePage(ctx, client, ref);
      if (format === 'storage') {
        const storage = fetched.body?.storage?.value ?? '';
        if (opts.out) {
          const outPath = resolvePath(deps.cwd, opts.out);
          await deps.fs.writeFile(outPath, storage);
          return {
            markdown: `wrote ${opts.out} (storage, no cache)\n`,
            data: {
              path: displayPath(deps.cwd, outPath),
              id: fetched.id,
              version: fetched.version?.number,
            },
          };
        }
        return {
          markdown: storage.endsWith('\n') ? storage : `${storage}\n`,
          data: { id: fetched.id, version: fetched.version?.number, storage },
        };
      }
      const doc = await buildPageDocument(
        ctx,
        client,
        fetched,
        { comments: Boolean(opts.comments), attachments: Boolean(opts.attachments) },
        format
      );
      const trailer = doc.trailer ? { trailer: doc.trailer } : {};
      if (opts.out) {
        const saved = await savePageWorkingFile(ctx, fetched, doc, opts.out);
        const cacheNote = saved.cachePath
          ? ` (cache: ${displayPath(deps.cwd, saved.cachePath)})`
          : ' (view format: read-only, no storage cache)';
        return {
          markdown: `wrote ${opts.out}${cacheNote}\n`,
          ...trailer,
          data: {
            path: saved.outPath,
            cache: saved.cachePath,
            frontmatter: doc.frontmatter,
            body: doc.body,
          },
          axi: {
            data: {
              path: displayPath(deps.cwd, saved.outPath),
              cache: saved.cachePath ? displayPath(deps.cwd, saved.cachePath) : null,
              id: doc.frontmatter.id,
              title: doc.frontmatter.title,
              version: doc.frontmatter.readonly.version,
              counts: doc.frontmatter.counts,
            },
          },
        };
      }
      return {
        markdown: renderEntity(doc.frontmatter as unknown as Record<string, unknown>, doc.body),
        ...trailer,
        data: { frontmatter: doc.frontmatter, body: doc.body },
        axi: { data: pageAxi(doc) },
      };
    },
  });
  registerPageWrites(page, deps, session);
  registerPageExport(page, deps, session);
  return page;
}
