import { composeBody, displayPath, joinSections, pathApi, resolvePath } from '@wonna/lassi-core';
import {
  pageToFrontmatter,
  pageTrailer,
  renderPageAttachments,
  renderPageComments,
  type ConfluenceClient,
  type ConfluenceAttachment,
  type ConfluenceComment,
  type ConfluencePage,
  type PageCache,
  type PageFileState,
  type PageFrontmatter,
  type StorageConverter,
} from '@wonna/lassi-confluence';
import type { Context } from '../../context.js';
import {
  lassiDirs,
  confluenceCachePath,
  confluencePageCachePath,
  readJsonCache,
  writeJsonCache,
  writeWorkingFile,
} from '../../workfile/index.js';
import { converterFor } from './shared.js';

export interface PageExpansion {
  comments: boolean;
  attachments: boolean;
}

export interface PageDocument {
  frontmatter: PageFrontmatter;
  storage: string;
  description: string;
  sections: string[];
  body: string;
  trailer: string | undefined;
  converter: StorageConverter;
  /** The expanded lists, for `--axi` (the sections above render them as markdown). */
  comments: ConfluenceComment[] | undefined;
  attachments: ConfluenceAttachment[] | undefined;
}

/** Frontmatter, converted body and the requested generated sections of one fetched page. */
export async function buildPageDocument(
  ctx: Context,
  client: ConfluenceClient,
  page: ConfluencePage,
  expansion: PageExpansion,
  format: 'md' | 'view' = 'md'
): Promise<PageDocument> {
  const storage = page.body?.storage?.value ?? '';
  // A capped walk makes a generated section a prefix, and the trailer suppresses the count for a
  // kind that was expanded, so without this the section reads as the whole set.
  const capped = (kind: string): void =>
    ctx.logger.warn(
      `page ${page.id} has more ${kind} than one walk returns (1000); the section below is the first of them`
    );
  const listed = expansion.comments
    ? await client.listComments(page.id)
    : { items: [], truncated: false };
  if (listed.truncated) capped('comments');
  const comments = listed.items;
  const converter = await converterFor(ctx, client, [storage, ...comments.map((c) => c.storage)]);
  const description =
    format === 'view'
      ? converter.viewToMarkdown(await client.convertBody(storage, 'storage', 'view'))
      : converter.toMarkdown(storage);
  const sections: string[] = [];
  if (expansion.comments)
    sections.push(renderPageComments(comments, (s) => converter.toMarkdown(s)));
  const listedFiles = expansion.attachments ? await client.listAttachments(page.id) : undefined;
  if (listedFiles?.truncated) capped('attachments');
  const attachments = listedFiles?.items;
  if (attachments) sections.push(renderPageAttachments(attachments));
  const frontmatter = pageToFrontmatter(page, {
    baseUrl: client.baseUrl,
    fetchedAt: ctx.deps.now().toISOString(),
    format,
  });
  return {
    frontmatter,
    storage,
    description,
    sections,
    body: composeBody(description, sections),
    trailer: pageTrailer(page.counts, expansion),
    converter,
    comments: expansion.comments ? comments : undefined,
    attachments,
  };
}

/**
 * Writes the working file, the exact storage as `<id>.v<n>.xml` (older versions removed) and the
 * sidecar with the generated sections; `outArg` is the path as the user gave it.
 */
export async function savePageWorkingFile(
  ctx: Context,
  page: ConfluencePage,
  doc: PageDocument,
  outArg: string
): Promise<{ outPath: string; cachePath: string | undefined; sha256: string }> {
  const { deps } = ctx;
  const outPath = resolvePath(deps.cwd, outArg);
  const sha256 = await writeWorkingFile(
    outPath,
    { frontmatter: doc.frontmatter as unknown as Record<string, unknown>, body: doc.body },
    deps.fs
  );
  const dirs = lassiDirs(deps.cwd, ctx.config, ctx.loaded.workspaceStateDir);
  const version = page.version?.number ?? 0;
  let cachePath: string | undefined;
  if (doc.frontmatter.lassi.format === 'md') {
    cachePath = confluenceCachePath(dirs, page.id, version);
    await deps.fs.writeFile(cachePath, doc.storage);
    await removeOlderVersions(ctx, page.id, version);
  }
  const sidecarPath = confluencePageCachePath(dirs, page.id);
  const previous = await readJsonCache<PageCache>(sidecarPath, deps.fs);
  const state: PageFileState = {
    sections: joinSections(doc.sections),
    version,
    parent: doc.frontmatter.parent === null ? null : String(doc.frontmatter.parent),
    fetchedAt: doc.frontmatter.lassi.fetchedAt,
    storageSha256: doc.frontmatter.lassi.storageSha256,
    format: doc.frontmatter.lassi.format,
  };
  const sidecar: PageCache = {
    schema: 1,
    id: page.id,
    version,
    fetchedAt: state.fetchedAt,
    format: state.format,
    sections: state.sections,
    storageSha256: state.storageSha256,
    files: { ...previous?.files, [displayPath(deps.cwd, outPath)]: state },
  };
  await writeJsonCache(sidecarPath, sidecar, deps.fs);
  return { outPath, cachePath, sha256 };
}

async function removeOlderVersions(ctx: Context, id: string, keep: number): Promise<void> {
  const dirs = lassiDirs(ctx.deps.cwd, ctx.config, ctx.loaded.workspaceStateDir);
  const api = pathApi(dirs.cache);
  const dir = api.join(dirs.cache, 'confluence');
  let names: string[];
  try {
    names = await ctx.deps.fs.readdir(dir);
  } catch {
    return;
  }
  const pattern = new RegExp(`^${id}\\.v(\\d+)\\.xml$`);
  for (const name of names) {
    const m = pattern.exec(name);
    if (m && Number(m[1]) !== keep) await ctx.deps.fs.unlink(api.join(dir, name));
  }
}
