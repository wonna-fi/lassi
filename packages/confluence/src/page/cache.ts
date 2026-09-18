/**
 * Sidecar next to `.lassi/cache/confluence/<id>.v<n>.xml` (the exact storage body): the generated
 * sections appended to the working file and the fetch metadata `page update` checks.
 */
export interface PageCache {
  schema: 1;
  id: string;
  version: number;
  fetchedAt: string;
  format: 'md' | 'view';
  sections: string;
  storageSha256: string;
  /**
   * What each working file was written from, keyed by its path from the workspace root. A page may
   * have several files at once (`page get --out`, `page export`, different `--comments` choices),
   * and each one must be diffed against its own fetch: a single per-page record would be clobbered
   * by the next fetch and `page update` would then strip the wrong text off the body.
   */
  files: Record<string, PageFileState>;
}

/** One working file's fetch: the generated sections and the server state they came from. */
export interface PageFileState {
  sections: string;
  version: number;
  /** Parent when the file was written; a later difference is the user's edit, not a server move. */
  parent: string | null;
  fetchedAt: string;
  storageSha256: string;
  format: 'md' | 'view';
}
