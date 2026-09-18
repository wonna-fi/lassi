import { LassiError, pathApi, portablePath, type LassiFs } from '@wonna/lassi-core';
import {
  sha256,
  type CorpusProvenance,
  type DocInput,
  type IndexManifest,
} from '@wonna/lassi-search';
import {
  isExportCandidate,
  isExportManifest,
  type ExportManifest,
} from '../shared/export-manifest.js';
import { assertStorageIdle } from '../shared/storage.js';

export interface Corpus {
  docs: DocInput[];
  provenance: CorpusProvenance;
}

/** Read all sources before planning removals. An unreadable subtree is never an empty subtree. */
export async function collectCorpus(fs: LassiFs, dirs: string[]): Promise<Corpus> {
  const docs = new Map<string, DocInput>();
  const exports: CorpusProvenance['exports'] = [];
  const visited = new Set<string>();
  const reading = new Set<string>();
  const snapshots: { dir: string; names: string[]; manifest?: string }[] = [];
  const verifySources = async (): Promise<void> => {
    for (const dir of reading) await assertStorageIdle(fs, dir);
    for (const snapshot of snapshots) {
      const names = (await fs.readdir(snapshot.dir)).sort();
      const manifest = names.includes('manifest.json')
        ? sha256(await fs.readFile(pathApi(snapshot.dir).join(snapshot.dir, 'manifest.json')))
        : undefined;
      await assertStorageIdle(fs, snapshot.dir);
      if (
        JSON.stringify(names) !== JSON.stringify(snapshot.names) ||
        manifest !== snapshot.manifest
      ) {
        throw new LassiError('conflict', `index source changed while being read: ${snapshot.dir}`, {
          hint: 'retry after the export finishes; the existing index was preserved',
        });
      }
    }
  };
  const walk = async (dir: string, api = pathApi(dir)): Promise<void> => {
    const pathId = (path: string): string => portablePath(path, api);
    reading.add(dir);
    await assertStorageIdle(fs, dir);
    const real = await fs.realpath(dir);
    if (visited.has(real)) return;
    visited.add(real);
    const names = (await fs.readdir(dir)).sort();
    const snapshot: (typeof snapshots)[number] = { dir, names };
    snapshots.push(snapshot);
    let origin: { path: string; manifest: ExportManifest } | undefined;
    if (names.includes('manifest.json')) {
      const path = api.join(dir, 'manifest.json');
      const raw = await fs.readFile(path);
      snapshot.manifest = sha256(raw);
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        throw new LassiError(
          'validation',
          `cannot inspect source manifest ${pathId(path)}: invalid JSON`
        );
      }
      // Ordinary document folders can contain unrelated JSON manifests.
      if (isExportCandidate(value)) {
        if (!isExportManifest(value))
          throw new LassiError('validation', `invalid export manifest ${pathId(path)}`);
        const manifest = value;
        origin = { path: pathId(path), manifest };
        const run = manifest.lastRun;
        exports.push({
          path: pathId(path),
          sha256: sha256(raw),
          product: manifest.product,
          mode: manifest.mode ?? 'legacy',
          queries: manifest.queries ?? [manifest.query],
          exportedAt: manifest.exportedAt,
          ...(manifest.source === undefined ? {} : { source: manifest.source }),
          ...(run === undefined
            ? {}
            : {
                lastRun: {
                  query: run.query,
                  startedAt: run.startedAt,
                  ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
                  complete: run.complete,
                  truncated: run.truncated,
                  failed: Object.keys(run.failed).length,
                },
              }),
        });
      }
    }
    for (const name of names) {
      const path = api.join(dir, name);
      const stat = await fs.stat(path);
      if (stat.isDirectory) await walk(path, api);
      else if (name.endsWith('.md')) {
        const markdown = await fs.readFile(path);
        // Export filenames are stable IDs; an unrelated Markdown file has no export baseline.
        const item = origin?.manifest.items[name.slice(0, -3)];
        docs.set(pathId(path), {
          rel: pathId(path),
          markdown,
          ...(origin === undefined || item === undefined
            ? {}
            : {
                origin: {
                  manifest: origin.path,
                  locallyModified:
                    item.sha256 === undefined ? null : item.sha256 !== sha256(markdown),
                  ...(item.fetchedAt === undefined ? {} : { fetchedAt: item.fetchedAt }),
                  ...(item.checkedAt === undefined ? {} : { checkedAt: item.checkedAt }),
                  ...(item.query === undefined ? {} : { query: item.query }),
                },
              }),
        });
      }
    }
  };
  try {
    try {
      // Parents first: overlapping roots retain the closest export manifest provenance.
      for (const dir of [...dirs].sort((a, b) => a.length - b.length || a.localeCompare(b)))
        await walk(dir);
    } finally {
      // An export can acquire and release its lock entirely during the scan. Its manifest or
      // directory listing still changes, including when this was the archive's first export.
      await verifySources();
    }
  } catch (err) {
    if (err instanceof LassiError) throw err;
    throw new LassiError(
      'internal',
      `cannot read index sources: ${err instanceof Error ? err.message : String(err)}`,
      {
        hint: 'check every source directory is present and readable; the existing index was preserved',
        cause: err,
      }
    );
  }
  return {
    docs: [...docs.values()].sort((a, b) => a.rel.localeCompare(b.rel)),
    provenance: {
      sources: dirs.map((dir) => portablePath(dir)),
      exports: exports.sort((a, b) => a.path.localeCompare(b.path)),
    },
  };
}

export interface CorpusStatus {
  localState: 'current' | 'changed' | 'unavailable' | 'unknown';
  indexedAt: string;
  sources: string[];
  exports: CorpusProvenance['exports'];
  note: string;
}

/** Old workspace-relative records have no anchor once an index is shared across projects. */
export function hasRelativePaths(manifest: IndexManifest): boolean {
  return [
    ...Object.keys(manifest.docs),
    ...(manifest.corpus?.sources ?? []),
    ...(manifest.corpus?.exports.map((e) => e.path) ?? []),
    ...Object.values(manifest.docs).flatMap((d) => (d.origin ? [d.origin.manifest] : [])),
  ].some((p) => !pathApi(p).isAbsolute(p));
}

/** Compare with local source bytes only; no claim about the live server is possible offline. */
export async function corpusStatus(fs: LassiFs, manifest: IndexManifest): Promise<CorpusStatus> {
  const base = {
    indexedAt: manifest.updatedAt,
    sources: manifest.corpus?.sources ?? [],
    exports: manifest.corpus?.exports ?? [],
  };
  if (!manifest.corpus)
    return {
      ...base,
      localState: 'unknown',
      note: 'legacy index has no recorded sources; pass directories to search index to record coverage',
    };
  try {
    const current = await collectCorpus(fs, manifest.corpus.sources);
    const changed =
      current.docs.length !== Object.keys(manifest.docs).length ||
      current.docs.some((d) => manifest.docs[d.rel]?.sha256 !== sha256(d.markdown)) ||
      JSON.stringify(current.provenance.exports.map((e) => [e.path, e.sha256])) !==
        JSON.stringify(manifest.corpus.exports.map((e) => [e.path, e.sha256]));
    return {
      ...base,
      localState: changed ? 'changed' : 'current',
      note: changed
        ? 'local exports or documents changed after indexing; run search index before relying on coverage'
        : 'matches local sources; live Jira/Confluence changes have not been checked',
    };
  } catch (err) {
    return {
      ...base,
      localState: 'unavailable',
      note: `local sources could not be checked: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function corpusLines(status: CorpusStatus): string {
  return (
    [
      `index built: ${status.indexedAt}; local sources: ${status.localState}`,
      status.note,
      ...status.exports.map(
        (e) =>
          `${e.product} ${e.mode}: ${e.source ?? 'server unknown'}; export attempt ${e.exportedAt}; last run ${e.lastRun === undefined ? 'coverage unknown' : e.lastRun.complete ? 'complete for its query' : `incomplete (${e.lastRun.failed} failures${e.lastRun.truncated ? ', truncated' : ''})`}; queries: ${e.queries.join(' | ')}`
      ),
      'Search covers indexed Markdown only; attachment contents and live server completeness are not implied.',
    ].join('\n') + '\n'
  );
}
