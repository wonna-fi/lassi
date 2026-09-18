import { matchesGlob } from 'node:path';

/** Strip directory components so a hostile filename cannot escape the target directory. */
export function safeFilename(name: string): string {
  const base = name.replace(/[\\/]+/g, '_').replace(/^\.+/, '_');
  return base.length > 0 ? base : 'attachment';
}

export function selectAttachments<T extends { filename: string }>(
  list: T[],
  only: string | undefined
): T[] {
  if (!only) return list;
  return list.filter((a) => matchesGlob(a.filename, only));
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  json: 'application/json',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  log: 'text/plain',
};

/** A content type when the extension is well known; otherwise the server sniffs it. */
export function mimeFor(filename: string): string | undefined {
  const ext = filename.toLowerCase().split('.').pop();
  return ext === undefined ? undefined : MIME_BY_EXTENSION[ext];
}
