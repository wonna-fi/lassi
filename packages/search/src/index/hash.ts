import { createHash } from 'node:crypto';

/** One hash for document text and for the index files the manifest points at. */
export function sha256(data: string | Uint8Array): string {
  return typeof data === 'string'
    ? createHash('sha256').update(data, 'utf8').digest('hex')
    : createHash('sha256').update(data).digest('hex');
}
