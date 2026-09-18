/** Export facts captured by the caller; the search library never reads an Atlassian manifest. */
export interface ExportProvenance {
  path: string;
  sha256: string;
  product: 'jira' | 'confluence';
  source?: string;
  mode: 'archive' | 'legacy';
  queries: string[];
  exportedAt: string;
  lastRun?: {
    query: string;
    startedAt: string;
    finishedAt?: string;
    complete: boolean;
    truncated: boolean;
    failed: number;
  };
}

export interface DocumentOrigin {
  manifest: string;
  fetchedAt?: string;
  checkedAt?: string;
  query?: string;
  /** Null when an older exporter saved no content baseline. */
  locallyModified: boolean | null;
}

export interface CorpusProvenance {
  /** Source paths supplied by the caller; the CLI records absolute paths. */
  sources: string[];
  exports: ExportProvenance[];
}

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const optionalStrings = (v: Record<string, unknown>, keys: string[]): boolean =>
  keys.every((k) => v[k] === undefined || typeof v[k] === 'string');

export function isCorpusProvenance(v: unknown): v is CorpusProvenance {
  if (
    !record(v) ||
    !strings(v['sources']) ||
    v['sources'].length === 0 ||
    !Array.isArray(v['exports'])
  )
    return false;
  return v['exports'].every((e: unknown) => {
    if (
      !record(e) ||
      typeof e['path'] !== 'string' ||
      typeof e['sha256'] !== 'string' ||
      !/^[a-f0-9]{64}$/.test(e['sha256']) ||
      (e['product'] !== 'jira' && e['product'] !== 'confluence') ||
      (e['mode'] !== 'archive' && e['mode'] !== 'legacy') ||
      !strings(e['queries']) ||
      typeof e['exportedAt'] !== 'string' ||
      !optionalStrings(e, ['source'])
    )
      return false;
    const r = e['lastRun'];
    return (
      r === undefined ||
      (record(r) &&
        typeof r['query'] === 'string' &&
        typeof r['startedAt'] === 'string' &&
        optionalStrings(r, ['finishedAt']) &&
        typeof r['complete'] === 'boolean' &&
        typeof r['truncated'] === 'boolean' &&
        Number.isSafeInteger(r['failed']) &&
        (r['failed'] as number) >= 0)
    );
  });
}

export function isDocumentOrigin(v: unknown): v is DocumentOrigin {
  return (
    record(v) &&
    typeof v['manifest'] === 'string' &&
    (v['locallyModified'] === null || typeof v['locallyModified'] === 'boolean') &&
    optionalStrings(v, ['fetchedAt', 'checkedAt', 'query'])
  );
}
