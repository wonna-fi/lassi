import type { Command } from 'commander';
import {
  LassiError,
  displayPath,
  resolvePath,
  splitFrontmatter,
  stripGeneratedSections,
  type HintContext,
} from '@wonna/lassi-core';
import {
  checkFidelity,
  collectUserKeys,
  createStorageConverter,
  diffEditableFields,
  inferWriterOptions,
  storageSha256,
  type ConfluenceClient,
  type PageCache,
  type PageFileState,
  type StorageWriterOptions,
  type UserDirectory,
} from '@wonna/lassi-confluence';
import type { Context } from '../../context.js';
import type { CliDeps } from '../../deps.js';
import { guardWrite } from '../../guard-write.js';
import { readBodyInput, type BodySource } from '../../input/body.js';
import { dryRunData } from '../../output/dry-run.js';
import { attach, type Session } from '../../run-command.js';
import {
  lassiDirs,
  confluenceCachePath,
  confluencePageCachePath,
  readJsonCache,
  readWorkingFile,
  splitEditable,
} from '../../workfile/index.js';
import { markdownBodyToStorage } from './body.js';
import { confluenceClient } from './shared.js';
import { buildPageDocument, savePageWorkingFile } from './workfile.js';

const BODY_HELP = ['--body <md>', 'page body as markdown'] as const;
const FILE_HELP = [
  '--file <path>',
  'markdown file with the body ("-" reads stdin); YAML frontmatter fills title/space/parent',
] as const;

interface CreateOptions extends BodySource {
  space?: string;
  title?: string;
  parent?: string;
}

interface UpdateOptions {
  file?: string;
  title?: string;
  parent?: string;
  force?: boolean;
  keep?: boolean;
}

/** Frontmatter is optional on a new page's file; a working file's reserved keys are ignored here. */
function splitBody(text: string): { data: Record<string, unknown>; body: string } {
  const { data, body } = splitFrontmatter(text);
  return { data: data ?? {}, body };
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  if (value === undefined || value === null) return undefined;
  return String(value as string | number);
}

interface CachedPage {
  storage: string;
  users: UserDirectory;
  writer: StorageWriterOptions;
  /** The markdown this file was written with; the body is edited only if it differs from this. */
  markdown: string;
}

/** The exact storage the working file was made from, with its users and editor conventions. */
async function loadCachedStorage(
  ctx: Context,
  client: ConfluenceClient,
  id: string,
  state: PageFileState
): Promise<CachedPage | undefined> {
  const path = confluenceCachePath(
    lassiDirs(ctx.deps.cwd, ctx.config, ctx.loaded.workspaceStateDir),
    id,
    state.version
  );
  if (!(await ctx.deps.fs.exists(path))) return undefined;
  const storage = await ctx.deps.fs.readFile(path);
  if (storageSha256(storage) !== state.storageSha256) return undefined;
  const users = await client.resolveUserKeys(collectUserKeys(storage));
  const converter = createStorageConverter({ users });
  const writer = inferWriterOptions(converter.toMdast(storage).shapes);
  return { storage, users, writer, markdown: converter.toMarkdown(storage) };
}

export function registerPageWrites(page: Command, deps: CliDeps, session: Session): void {
  const create = page
    .command('create')
    .description('create a page from markdown; prints the new id and URL')
    .option('--space <KEY>', 'space key (default: confluence.defaultSpace or the file frontmatter)')
    .option('--title <T>', 'page title (or the file frontmatter)')
    .option('--parent <ID>', 'parent page id (or the file frontmatter)')
    .option(...BODY_HELP)
    .option(...FILE_HELP);
  attach<[], CreateOptions>(create, deps, session, {
    kind: 'write',
    async run(ctx, _args, opts) {
      const text = (await readBodyInput(deps, opts, { required: true })) ?? '';
      const { data, body } = splitBody(text);
      const space = opts.space ?? stringField(data, 'space') ?? ctx.config.confluence.defaultSpace;
      const title = opts.title ?? stringField(data, 'title');
      const parent = opts.parent ?? stringField(data, 'parent');
      if (!space)
        throw new LassiError('usage', '--space is required (or set confluence.defaultSpace)');
      if (!title)
        throw new LassiError('usage', '--title is required (or a `title:` frontmatter key)');
      const context: HintContext = { product: 'confluence', operation: 'create' };
      const client = await confluenceClient(ctx);
      const { storage } = await markdownBodyToStorage(ctx, client, body);
      const preview = {
        method: 'POST' as const,
        path: '/rest/api/content',
        payloadLabel: 'body (storage)',
        payload: storage,
        note: `title "${title}" in space ${space}${parent ? `, parent ${parent}` : ''}`,
      };
      if (guardWrite(ctx, preview) === 'dry-run') return { data: dryRunData(preview) };
      let created;
      try {
        created = await client.createPage({
          space,
          title,
          ...(parent ? { parentId: parent } : {}),
          storage,
        });
      } catch (err) {
        if (err instanceof LassiError) err.context = { ...context, ...err.context };
        throw err;
      }
      const url = client.pageUrl(created.id);
      return {
        markdown: `created page ${created.id} ${url}\n`,
        data: { id: created.id, title, space, url },
      };
    },
  });

  const validate = page
    .command('validate')
    .description('convert markdown to storage and let the server parse it, sending nothing else')
    .option(...BODY_HELP)
    .option(...FILE_HELP);
  attach<[], BodySource>(validate, deps, session, {
    kind: 'read',
    async run(ctx, _args, opts) {
      const text = (await readBodyInput(deps, opts, { required: true })) ?? '';
      const { body } = splitBody(text);
      const client = await confluenceClient(ctx);
      const { storage } = await markdownBodyToStorage(ctx, client, body);
      // the convert endpoint is the server-side parser; a 400 is its verdict.
      await client.convertBody(storage, 'storage', 'view');
      const bytes = Buffer.byteLength(storage, 'utf8');
      return {
        markdown: `valid: the server accepted ${bytes} bytes of storage\n`,
        data: { valid: true, bytes, storage },
      };
    },
  });

  const update = page
    .command('update [ID]')
    .description(
      'update a page from its working file (body, title, parent) or change title/parent by id'
    )
    .option('--file <md>', 'working file from `page get --out`; its cache guards the round trip')
    .option('--title <T>', 'new title')
    .option('--parent <ID>', 'new parent page id')
    .option(
      '--force',
      'write even when the fidelity gate finds content the dialect cannot preserve'
    )
    .option('--keep', 'do not re-fetch and rewrite the working file afterwards');
  attach<[string | undefined], UpdateOptions>(update, deps, session, {
    kind: 'write',
    async run(ctx, [idArg], opts) {
      if (!opts.file && !idArg) throw new LassiError('usage', 'pass a page id or --file <md>');
      if (!opts.file && opts.title === undefined && opts.parent === undefined) {
        throw new LassiError('usage', 'nothing to update: pass --title, --parent or --file');
      }
      const client = await confluenceClient(ctx);
      let id = idArg;
      let body: string | undefined;
      let editable: Record<string, unknown> = {};
      let fileState: PageFileState | undefined;
      const workingFile = opts.file;
      if (workingFile) {
        const file = await readWorkingFile(resolvePath(deps.cwd, workingFile), deps.fs);
        const split = splitEditable(file.frontmatter);
        if (split.lassi?.format === 'view') {
          throw new LassiError(
            'usage',
            `${workingFile} was fetched with --format view and cannot be written back`,
            { hint: 'fetch the page again without --format view, then edit that file' }
          );
        }
        const fileId = stringField(split.editable, 'id');
        if (fileId === undefined) {
          throw new LassiError('usage', `${workingFile} has no \`id:\` in its frontmatter`);
        }
        if (id !== undefined && id !== fileId) {
          throw new LassiError(
            'usage',
            `${workingFile} is the working file of page ${fileId}, not ${id}`
          );
        }
        id = fileId;
        editable = Object.fromEntries(Object.entries(split.editable).filter(([k]) => k !== 'id'));
        // As in the Jira path: the detail rides on the error rather than a third stderr line.
        let damaged: string | undefined;
        const sidecar = await readJsonCache<PageCache>(
          confluencePageCachePath(
            lassiDirs(deps.cwd, ctx.config, ctx.loaded.workspaceStateDir),
            id
          ),
          deps.fs,
          (p) => {
            damaged = displayPath(deps.cwd, p);
          }
        );
        // The fetch that wrote *this* file decides which trailing sections are generated, which
        // version the edit started from and where the page hung; a per-page record would be
        // clobbered by any later fetch of the same page (an export, a second --comments run).
        fileState = sidecar?.files?.[displayPath(deps.cwd, resolvePath(deps.cwd, workingFile))];
        if (!fileState) {
          throw new LassiError(
            'usage',
            `no record of ${workingFile} for page ${id}; an update diffs the file against the fetch that wrote it`,
            {
              hint:
                damaged === undefined
                  ? `run \`lassi confluence page get ${id} --out ${workingFile}\` first`
                  : `${damaged} is not valid JSON, so the record was ignored; run \`lassi confluence page get ${id} --out ${workingFile}\` again`,
              context: { product: 'confluence', pageId: id, workingFile },
            }
          );
        }
        if (fileState.format === 'view') {
          throw new LassiError(
            'usage',
            `${workingFile} was fetched with --format view and cannot be written back`,
            { hint: 'fetch the page again without --format view, then edit that file' }
          );
        }
        const declared = split.readonly?.['version'];
        if (typeof declared === 'number' && declared !== fileState.version) {
          throw new LassiError(
            'usage',
            `${workingFile} declares version ${declared} but was fetched at version ${fileState.version}`,
            {
              hint: `\`readonly:\` is written by the fetch and never edited; run \`lassi confluence page get ${id} --out ${workingFile}\` again`,
              context: { product: 'confluence', pageId: id, workingFile },
            }
          );
        }
        const stripped = stripGeneratedSections(file.body, fileState.sections);
        if (stripped === undefined) {
          throw new LassiError(
            'usage',
            `the generated sections (## Comments / ## Attachments) in ${workingFile} were edited`,
            {
              hint: `they are never sent, so they must stay exactly as fetched; edit the page body above them, or run \`lassi confluence page get ${id} --out ${workingFile}\` without --comments/--attachments for a file that has none`,
              context: { product: 'confluence', pageId: id, workingFile },
            }
          );
        }
        body = stripped;
      }
      const pageId = id as string;
      const context: HintContext = {
        product: 'confluence',
        pageId,
        operation: 'update',
        ...(workingFile ? { workingFile } : {}),
      };
      const live = await client.getContent(pageId, ['version', 'space', 'ancestors']);
      const liveVersion = live.version?.number ?? 0;
      if (fileState !== undefined && fileState.version !== liveVersion) {
        throw new LassiError(
          'conflict',
          `page ${pageId} changed on the server since the working file was fetched (version ${fileState.version} → ${liveVersion})`,
          { context: { ...context, versionFrom: fileState.version, versionTo: liveVersion } }
        );
      }
      if (opts.title !== undefined) editable['title'] = opts.title;
      if (opts.parent !== undefined) editable['parent'] = opts.parent;
      const diff = diffEditableFields(
        editable,
        live,
        fileState === undefined ? undefined : { parent: fileState.parent }
      );
      if (diff.unknownKeys.length > 0) {
        throw new LassiError(
          'usage',
          `unknown frontmatter key${diff.unknownKeys.length === 1 ? '' : 's'}: ${diff.unknownKeys.join(', ')} (pages have title, space and parent)`,
          { context }
        );
      }
      if (diff.spaceChanged) {
        throw new LassiError('usage', 'moving a page to another space is not supported', {
          context,
        });
      }
      if (diff.parentChanged && diff.parentId === null) {
        throw new LassiError('usage', 'removing the parent is not supported; set a parent id', {
          context,
        });
      }

      const changed: string[] = [];
      if (diff.titleChanged) changed.push('title');
      if (diff.parentChanged) changed.push('parent');
      let storage: string | undefined;
      if (body !== undefined) {
        const cached = fileState
          ? await loadCachedStorage(ctx, client, pageId, fileState)
          : undefined;
        if (!cached) {
          ctx.logger.warn(
            `no cached storage for page ${pageId} (version ${liveVersion}); the fidelity gate is skipped`
          );
        }
        const converted = await markdownBodyToStorage(
          ctx,
          client,
          body,
          cached ? { users: cached.users, writer: cached.writer } : {}
        );
        // Whether the *user* edited the body, which is what decides if anything is sent. Comparing
        // the storage instead would call an untouched body changed on any page the dialect cannot
        // reproduce, so a title-only edit would trip the gate and `--force` would rewrite a body
        // nobody touched. An unsent body needs no gate.
        const bodyChanged = cached === undefined || body.trim() !== cached.markdown.trim();
        if (cached && bodyChanged) {
          // refuse when the untouched parts of the page would not survive the loop.
          const gate = checkFidelity(cached.storage, converted.converter);
          if (!gate.equal) {
            const messages = gate.diffs.map(
              (d) =>
                `${d.path}: ${d.kind}${d.a === undefined ? '' : ` (page: ${d.a})`}${d.b === undefined ? '' : ` (rewrite: ${d.b})`}`
            );
            if (gate.error !== undefined) messages.push(gate.error);
            if (opts.force) {
              for (const m of messages) ctx.logger.warn(`fidelity: ${m}`);
              ctx.logger.warn('--force given: writing despite the fidelity gate');
            } else {
              throw new LassiError(
                'validation',
                `page ${pageId} holds content the markdown dialect cannot preserve (${gate.diffs.length}${gate.truncated ? '+' : ''} node${gate.diffs.length === 1 ? '' : 's'} would change)`,
                {
                  errorMessages: messages,
                  hint: 'keep those regions in ```confluence fences, or pass --force to rewrite them',
                  context,
                }
              );
            }
          }
        }
        if (bodyChanged) {
          changed.push('body');
          storage = converted.storage;
        }
      }
      if (changed.length === 0) {
        return { markdown: `no changes for page ${pageId}\n`, data: { id: pageId, changed: [] } };
      }
      const nextVersion = liveVersion + 1;
      const note = `title "${diff.title}", version ${liveVersion} → ${nextVersion}${diff.parentChanged ? `, parent ${diff.parentId}` : ''}`;
      const preview =
        storage === undefined
          ? {
              method: 'PUT' as const,
              path: `/rest/api/content/${pageId}`,
              payloadLabel: 'fields (json)',
              payload: JSON.stringify(
                { title: diff.title, ...(diff.parentChanged ? { parent: diff.parentId } : {}) },
                null,
                2
              ),
              note,
            }
          : {
              method: 'PUT' as const,
              path: `/rest/api/content/${pageId}`,
              payloadLabel: 'body (storage)',
              payload: storage,
              note,
            };
      if (guardWrite(ctx, preview) === 'dry-run') return { data: dryRunData(preview) };
      await client.updatePage(pageId, {
        title: diff.title,
        currentVersion: liveVersion,
        ...(storage === undefined ? {} : { storage }),
        ...(diff.parentChanged && diff.parentId !== null ? { parentId: diff.parentId } : {}),
      });

      let rewritten: string | undefined;
      if (workingFile && !opts.keep) {
        // re-fetch and rewrite, keeping the sections the file carried; the cache rotates.
        const fresh = await client.getPage(pageId);
        const sections = fileState?.sections ?? '';
        const doc = await buildPageDocument(ctx, client, fresh, {
          comments: sections.includes('## Comments'),
          attachments: sections.includes('## Attachments'),
        });
        await savePageWorkingFile(ctx, fresh, doc, workingFile);
        rewritten = displayPath(deps.cwd, resolvePath(deps.cwd, workingFile));
      }
      return {
        markdown: `updated page ${pageId} to version ${nextVersion} (${changed.join(', ')})${rewritten ? `; rewrote ${rewritten}` : ''}\n`,
        data: {
          id: pageId,
          version: nextVersion,
          changed,
          ...(rewritten ? { file: rewritten } : {}),
        },
      };
    },
  });
}
