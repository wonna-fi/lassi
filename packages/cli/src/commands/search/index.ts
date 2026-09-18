import type { Command } from 'commander';
import {
  LassiError,
  displayPath,
  expandHome,
  isLassiError,
  pathApi,
  resolvePath,
} from '@wonna/lassi-core';
import {
  buildIndex,
  chunkDocument,
  indexMismatch,
  indexMismatchOf,
  isIndexDamaged,
  planIndex,
  queryIndex,
  readIndex,
  readIndexManifest,
  sha256,
  writeIndex,
  type ChunkedDocument,
  type DocProduct,
  type LoadedIndex,
  type IndexManifest,
} from '@wonna/lassi-search';
import type { CliDeps } from '../../deps.js';
import { guardWrite } from '../../guard-write.js';
import { markNamespace } from '../../help/lassi-help.js';
import { truncate } from '../../output/axi.js';
import { dryRunData } from '../../output/dry-run.js';
import { renderTable } from '../../output/table.js';
import { attach, type Session } from '../../run-command.js';
import { lassiDirs } from '../../workfile/index.js';
import { assertIndexTarget, assertStorageIdle, withStorageLock } from '../shared/storage.js';
import { DEFAULT_INDEX_NAME, embeddingsClient } from './shared.js';
import { collectCorpus, corpusStatus, corpusLines, hasRelativePaths } from './corpus.js';

interface IndexOptions {
  name?: string;
  rebuild?: boolean;
}

interface QueryOptions {
  limit?: string;
  index?: string;
  product?: string;
}

/**
 * One wording for every output mode. `queryIndex` keeps a score equal to the floor, so this says
 * "at least", and the number is printed as configured rather than rounded: it is the value the
 * reader is being told to lower.
 */
function noMatchesLine(name: string, chunks: number, minScore: number): string {
  return `no matches scoring at least ${minScore} in index "${name}" (${chunks} chunks); try other words, lower embeddings.minScore, or export more and run \`lassi search index\``;
}

/** Following this verbatim must repair the index that failed, not the default one. */
function rebuildHint(name: string): string {
  const flag = name === DEFAULT_INDEX_NAME ? '' : ` --name ${name}`;
  return `run \`lassi search index --rebuild${flag}\` to embed every document again`;
}

/** Every index name reaches a path and a copy-pasteable command, so none of them may be creative. */
function assertIndexName(name: string, flag: '--name' | '--index'): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(name) || name === '.' || name === '..')
    throw new LassiError('usage', `${flag} must be letters, digits, ., _ or -, got "${name}"`);
}

function assertSharedPaths(manifest: IndexManifest, name: string): void {
  if (hasRelativePaths(manifest)) {
    throw new LassiError('usage', `index "${name}" has legacy workspace-relative paths`, {
      hint: `from the original workspace, run lassi search index <original-source-directory> --name ${name} --rebuild; old paths cannot be resolved from another directory`,
    });
  }
}

/**
 * An index whose files disagree cannot be read, and until `--rebuild` existed the only way out was
 * deleting the directory by hand; every command that reads one says so now. A filesystem that will
 * not answer is not damage: telling the reader to re-embed the corpus would cost them real money
 * and then fail again on the same file, so that failure keeps its own category and gains a hint
 * about the thing actually at fault.
 */
function explainIndexFailure(
  deps: CliDeps,
  dir: string,
  name: string,
  err: unknown,
  opts: { retryRead?: boolean } = {}
): never {
  const where = displayPath(deps.cwd, dir);
  if (isIndexDamaged(err))
    throw new LassiError(
      'validation',
      `index "${name}" at ${where} cannot be read: ${err.message}`,
      {
        hint: opts.retryRead
          ? `retry this read after any index update finishes; if it still fails with no writer active, ${rebuildHint(name)}`
          : rebuildHint(name),
        cause: err,
      }
    );
  if (isLassiError(err)) throw err;
  throw new LassiError(
    'internal',
    `index "${name}" at ${where} could not be read: ${errorText(err)}`,
    {
      hint: 'this is a filesystem failure rather than a damaged index; check that the index directory and its files are readable',
      cause: err,
    }
  );
}

/** Never assumes an Error: an injected `LassiFs` may reject with anything. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Writers already own the lock; readers must distinguish publication from persistent damage. */
async function readIndexData<T>(
  deps: CliDeps,
  dir: string,
  name: string,
  read: () => Promise<T>,
  opts: { readOnly?: boolean; ignoreDamage?: boolean }
): Promise<T | undefined> {
  for (let attempt = 0; ; attempt++) {
    if (opts.readOnly) await assertStorageIdle(deps.fs, dir);
    try {
      const value = await read();
      if (opts.readOnly) await assertStorageIdle(deps.fs, dir);
      return value;
    } catch (err) {
      if (opts.readOnly) {
        await assertStorageIdle(deps.fs, dir);
        // Publication may acquire and release its lock entirely during the read.
        if (attempt === 0 && isIndexDamaged(err)) continue;
      }
      // --rebuild may replace damaged data, but a filesystem failure is never permission to do so.
      if (opts.ignoreDamage && isIndexDamaged(err)) return undefined;
      explainIndexFailure(deps, dir, name, err, { retryRead: opts.readOnly });
    }
  }
}

const NO_INDEX_HINT =
  'export first (`lassi jira issue export "<JQL>"` or `lassi confluence page export --space <KEY>`), then run `lassi search index`';

async function loadIndex(deps: CliDeps, dir: string, name: string): Promise<LoadedIndex> {
  const index = await readIndexData(deps, dir, name, () => readIndex(deps.fs, dir), {
    readOnly: true,
  });
  if (!index) {
    throw new LassiError('usage', `no index "${name}" at ${displayPath(deps.cwd, dir)}`, {
      hint: NO_INDEX_HINT,
    });
  }
  assertSharedPaths(index.manifest, name);
  return index;
}

/** `lassi search index|query|show`: local semantic search over exported working files. */
export function registerSearch(program: Command, deps: CliDeps, session: Session): Command {
  const search = program
    .command('search')
    .description(
      'semantic search over exported issues and pages (local index, configured embeddings)'
    );
  markNamespace(search);

  const index = search
    .command('index [dir...]')
    .description(
      'chunk and embed every *.md under the directories (default: the global export directories) into ~/.lassi/index/<name> (storage.indexDir)'
    )
    .option('--name <index>', `index name (default ${DEFAULT_INDEX_NAME})`)
    .option(
      '--rebuild',
      'ignore the existing index and embed every document again (after a model change, or to repair one that cannot be read)'
    );
  attach<[string[]], IndexOptions>(index, deps, session, {
    kind: 'write',
    async run(ctx, [dirArgs], opts) {
      const name = opts.name ?? DEFAULT_INDEX_NAME;
      assertIndexName(name, '--name');
      const dirs = lassiDirs(deps.cwd, ctx.config, ctx.loaded.workspaceStateDir);
      const indexDir = dirs.index(name);
      let sources = (dirArgs ?? []).map((d) => resolvePath(deps.cwd, expandHome(d, deps.homedir)));
      await assertIndexTarget(deps.fs, indexDir, [
        dirs.export('jira'),
        dirs.export('confluence'),
        ...sources,
      ]);
      return withStorageLock(
        ctx,
        indexDir,
        async () => {
          const readOptions = { readOnly: ctx.dryRun, ignoreDamage: opts.rebuild };
          const previous = await readIndexData(
            deps,
            indexDir,
            name,
            () => readIndex(deps.fs, indexDir),
            readOptions
          );
          let metadata = previous?.manifest;
          if (opts.rebuild && !metadata) {
            metadata = await readIndexData(
              deps,
              indexDir,
              name,
              () => readIndexManifest(deps.fs, indexDir),
              readOptions
            );
          }
          if (metadata && !(opts.rebuild && sources.length > 0)) assertSharedPaths(metadata, name);
          if (sources.length === 0 && metadata?.corpus) sources = metadata.corpus.sources;
          if (
            sources.length === 0 &&
            (metadata || (await deps.fs.exists(pathApi(indexDir).join(indexDir, 'manifest.json'))))
          ) {
            throw new LassiError('usage', `index "${name}" has no recoverable source directories`, {
              hint: `pass the original directories to lassi search index${opts.rebuild ? ' --rebuild' : ''} --name ${name}`,
            });
          }
          if (sources.length === 0) {
            for (const product of ['jira', 'confluence'] as const) {
              const dir = dirs.export(product);
              if (await deps.fs.exists(dir)) sources.push(dir);
            }
            if (sources.length === 0) {
              throw new LassiError(
                'usage',
                'nothing to index: no export directory exists and no directory was given',
                {
                  hint: NO_INDEX_HINT,
                }
              );
            }
          }
          sources = [...new Set(sources)];
          await assertIndexTarget(deps.fs, indexDir, sources);
          const corpus = await collectCorpus(deps.fs, sources);
          const docs = corpus.docs;
          if (docs.length === 0) {
            throw new LassiError(
              'usage',
              `no markdown files under ${sources.map((s) => displayPath(deps.cwd, s)).join(', ')}`,
              { hint: NO_INDEX_HINT }
            );
          }
          const embeddings = await ctx.embeddings();
          // Chunking is the expensive pure step and both the preview and the build need it, so each
          // document is chunked once: with `--rebuild` that is the whole corpus rather than a few files.
          const chunked = new Map<string, ChunkedDocument>();
          const chunk = (markdown: string, rel: string): ChunkedDocument => {
            let doc = chunked.get(rel);
            if (!doc) {
              doc = chunkDocument(markdown, {
                maxChars: embeddings.chunkChars,
                overlap: embeddings.chunkOverlap,
                fallbackRef: rel,
              });
              chunked.set(rel, doc);
            }
            return doc;
          };
          // Judged before anything is previewed or sent, so a run that cannot work costs nothing and a
          // dry run says so rather than costing out a write the command would refuse. The rule itself
          // lives in the library; what this layer adds is the flag that resolves it.
          const mismatch =
            opts.rebuild || !previous
              ? undefined
              : indexMismatch(previous.manifest, {
                  model: embeddings.model,
                  ...(embeddings.dimensions === undefined
                    ? {}
                    : { dimensions: embeddings.dimensions }),
                });
          if (mismatch) {
            const why =
              mismatch.kind === 'model'
                ? `it was built with ${mismatch.was}; the configuration now says ${mismatch.now}`
                : `it holds ${mismatch.was}-dimensional vectors; the configuration now asks for ${mismatch.now}`;
            throw new LassiError(
              'validation',
              `index "${name}" cannot take this configuration: ${why}`,
              {
                hint: `${rebuildHint(name)}, or index under another --name`,
              }
            );
          }
          const chunkFingerprint = sha256(
            JSON.stringify({
              revision: 1,
              maxChars: embeddings.chunkChars,
              overlap: embeddings.chunkOverlap,
            })
          );
          const plan = planIndex(previous, docs, {
            rebuild: opts.rebuild === true,
            chunkFingerprint,
          });
          const byRel = new Map(docs.map((d) => [d.rel, d]));
          let chunksToEmbed = 0;
          let chars = 0;
          for (const rel of plan.embed) {
            const doc = byRel.get(rel);
            if (!doc) continue;
            for (const c of chunk(doc.markdown, rel).chunks) {
              chunksToEmbed += 1;
              chars += c.embedText.length;
            }
          }
          const preview = {
            method: 'POST' as const,
            path: `${embeddings.http.baseUrl}/embeddings`,
            payloadLabel: 'documents',
            payload: [
              `${docs.length} documents from ${sources.map((s) => displayPath(deps.cwd, s)).join(', ')}`,
              `${plan.embed.length} to embed (${chunksToEmbed} chunks, ~${chars} characters), ${plan.reuse.length} unchanged, ${plan.drop.length} to drop`,
              `model ${embeddings.model}, index ${displayPath(deps.cwd, indexDir)}`,
            ].join('\n'),
            note: opts.rebuild
              ? 'rebuilding: every document is embedded again and the existing index is replaced; the text of the chunks is sent to the configured endpoint, and nothing leaves this machine under --dry-run'
              : 'the text of the chunks to embed is sent to the configured endpoint; nothing leaves this machine under --dry-run',
          };
          if (guardWrite(ctx, preview) === 'dry-run') return { data: dryRunData(preview) };
          const client = await embeddingsClient(ctx);
          const { index: built, stats } = await buildIndex({
            name,
            model: client.model,
            ...(embeddings.dimensions === undefined ? {} : { dimensions: embeddings.dimensions }),
            ...(opts.rebuild === true ? { rebuild: true } : {}),
            previous,
            docs,
            corpus: corpus.provenance,
            chunkFingerprint,
            // The preview above already hashed the corpus; buildIndex would otherwise do it again.
            plan,
            chunk,
            embed: (texts) => client.embed(texts),
            now: () => deps.now(),
          }).catch((err: unknown) => {
            // Only "these vectors cannot be mixed" earns the flag, and only the endpoint's own width
            // can raise it this late. Every other failure keeps the hint its own layer wrote.
            if (isLassiError(err) && indexMismatchOf(err))
              err.hint = `${rebuildHint(name)}, or index under another --name`;
            throw err;
          });
          // The manifest can retain the index's identity even when its vectors cannot be reused.
          if (!previous && typeof metadata?.createdAt === 'string')
            built.manifest.createdAt = metadata.createdAt;
          await writeIndex(deps.fs, indexDir, built);
          const shown = indexDir;
          return {
            markdown: `indexed ${stats.documents} documents (${stats.embedded} embedded, ${stats.reused} reused, ${stats.dropped} dropped; ${stats.chunks} chunks) into ${shown}\n`,
            data: {
              name,
              dir: shown,
              model: client.model,
              dimensions: built.manifest.dimensions,
              sources: corpus.provenance.sources,
              exports: corpus.provenance.exports,
              ...stats,
            },
          };
        },
        { dryRun: ctx.dryRun }
      );
    },
  });

  const query = search
    .command('query <text>')
    .description('the closest exported issues and pages to a question (one row per document)')
    .option('--limit <N>', 'rows to show (default 10)')
    .option('--index <name>', `index name (default ${DEFAULT_INDEX_NAME})`)
    .option('--product <jira|confluence>', 'only one product');
  attach<[string], QueryOptions>(query, deps, session, {
    kind: 'read',
    async run(ctx, [text], opts) {
      const limit = opts.limit === undefined ? 10 : Number(opts.limit);
      if (!Number.isFinite(limit) || limit <= 0)
        throw new LassiError('usage', `--limit must be a positive number, got "${opts.limit}"`);
      if (opts.product !== undefined && opts.product !== 'jira' && opts.product !== 'confluence')
        throw new LassiError(
          'usage',
          `--product must be jira or confluence, got "${opts.product}"`
        );
      const name = opts.index ?? DEFAULT_INDEX_NAME;
      assertIndexName(name, '--index');
      const indexDir = lassiDirs(deps.cwd, ctx.config, ctx.loaded.workspaceStateDir).index(name);
      const loaded = await loadIndex(deps, indexDir, name);
      const coverage = await corpusStatus(deps.fs, loaded.manifest);
      const client = await embeddingsClient(ctx);
      const { minScore, dimensions } = await ctx.embeddings();
      // The same rule as the one `index` applies, caught before the question is sent.
      const mismatch = indexMismatch(loaded.manifest, {
        model: client.model,
        ...(dimensions === undefined ? {} : { dimensions }),
      });
      if (mismatch) {
        const why =
          mismatch.kind === 'model'
            ? `it was built with ${mismatch.was}; the configuration now says ${mismatch.now}`
            : `it holds ${mismatch.was}-dimensional vectors; the configuration now asks for ${mismatch.now}`;
        throw new LassiError('validation', `index "${name}" cannot answer this query: ${why}`, {
          hint: `${rebuildHint(name)}, or restore the previous setting`,
        });
      }
      const [vector] = await client.embed([text]);
      if (!vector)
        throw new LassiError(
          'validation',
          'the embeddings endpoint returned no vector for the query'
        );
      // The check above uses the configured width; without one pinned, the endpoint's own width is
      // only known here, so this path needs the same hint the `index` path attaches.
      let hits;
      try {
        hits = queryIndex(loaded, vector, {
          limit,
          minScore,
          ...(opts.product === undefined ? {} : { product: opts.product as DocProduct }),
        });
      } catch (err) {
        if (isLassiError(err) && indexMismatchOf(err))
          err.hint = `${rebuildHint(name)}, or restore the previous setting`;
        throw err;
      }
      const evidence = hits.map((h) => ({
        ...h,
        indexedAt: loaded.manifest.docs[h.doc]?.indexedAt,
        origin: loaded.manifest.docs[h.doc]?.origin ?? null,
      }));
      const rows = evidence.map((h) => ({
        score: h.score.toFixed(2),
        source: `${h.product} ${h.ref}`,
        title: h.title,
        where: h.heading || '-',
        path: h.doc,
        snippet: truncate(h.text, 120),
        url: h.url ?? null,
        indexedAt: h.indexedAt,
        origin: h.origin,
      }));
      const empty = noMatchesLine(name, loaded.manifest.chunkCount, minScore);
      const table = renderTable(
        [
          { key: 'score', header: 'Score' },
          { key: 'source', header: 'Source' },
          { key: 'title', header: 'Title' },
          { key: 'where', header: 'Where' },
          { key: 'path', header: 'Path' },
          { key: 'snippet', header: 'Snippet' },
        ],
        rows
      );
      const provenance = evidence
        .map((h) => {
          const changed = h.origin?.locallyModified;
          return `- ${h.ref}: ${h.url ?? 'source URL unknown'}\n  Indexed: ${h.indexedAt ?? 'unknown'}; Fetched: ${h.origin?.fetchedAt ?? 'unknown'}; Checked: ${h.origin?.checkedAt ?? 'unknown'}; Modified: ${changed === true ? 'yes' : changed === false ? 'no' : 'unknown'}`;
        })
        .join('\n');
      return {
        markdown:
          (rows.length === 0 ? `${empty}\n` : `${table}\n${provenance}\n`) +
          '\n' +
          corpusLines(coverage),
        // `minScore` travels with the result: in --json the prose above is never printed, so it is
        // the only way to tell "nothing indexed" from "the floor suppressed real hits".
        data: { index: name, query: text, minScore, coverage, hits: evidence },
        axi: {
          data: { index: name, query: text, minScore, coverage, shown: rows.length, hits: rows },
          help:
            rows.length === 0
              ? [`${empty}.`]
              : [
                  'Open a hit with `lassi jira issue get <KEY>` or `lassi confluence page get <ID>`, or read the exported file at Path.',
                ],
        },
      };
    },
  });

  const show = search
    .command('show')
    .description('what an index holds: model, dimensions, documents, chunks, last update')
    .option('--index <name>', `index name (default ${DEFAULT_INDEX_NAME})`);
  attach<[], { index?: string }>(show, deps, session, {
    kind: 'read',
    async run(ctx, _args, opts) {
      const name = opts.index ?? DEFAULT_INDEX_NAME;
      assertIndexName(name, '--index');
      const indexDir = lassiDirs(deps.cwd, ctx.config, ctx.loaded.workspaceStateDir).index(name);
      const loaded = await loadIndex(deps, indexDir, name);
      const m = loaded.manifest;
      const coverage = await corpusStatus(deps.fs, m);
      const byProduct: Record<string, number> = {};
      for (const doc of Object.values(m.docs))
        byProduct[doc.product] = (byProduct[doc.product] ?? 0) + 1;
      const summary = {
        name: m.name,
        dir: indexDir,
        model: m.model,
        dimensions: m.dimensions,
        documents: Object.keys(m.docs).length,
        chunks: m.chunkCount,
        byProduct,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
        chunkFingerprint: m.chunkFingerprint ?? null,
        coverage,
      };
      const lines = [
        `# index ${m.name}`,
        '',
        `- directory: ${summary.dir}`,
        `- model: ${m.model} (${m.dimensions} dimensions)`,
        `- documents: ${summary.documents} (${
          Object.entries(byProduct)
            .map(([p, n]) => `${p}: ${n}`)
            .join(', ') || 'none'
        })`,
        `- chunks: ${m.chunkCount}`,
        `- created: ${m.createdAt}`,
        `- updated: ${m.updatedAt}`,
        '',
      ];
      return { markdown: lines.join('\n') + corpusLines(coverage), data: summary };
    },
  });
  return search;
}
