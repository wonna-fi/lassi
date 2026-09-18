import { LassiError } from '@wonna/lassi-core';
import { safeFilename } from '../shared/attachments.js';

function bytePrefix(text: string, limit: number): string {
  let result = '';
  let bytes = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(character);
    if (bytes > limit) break;
    result += character;
  }
  return result;
}

/** Leave room for the stable ID on filesystems with a 255-byte component limit. */
export function attachmentName(id: string, filename: string): string {
  if (!/^\d+$/.test(id) || id.length > 250)
    throw new LassiError('validation', 'Jira returned an invalid attachment id');
  const name = safeFilename(filename)
    // oxlint-disable-next-line no-control-regex -- Server filenames must be safe on Windows too.
    .replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_')
    .replace(/[. ]+$/, '_');
  const budget = 255 - id.length - 1;
  let shortened = name;
  if (Buffer.byteLength(name) > budget) {
    const dot = name.lastIndexOf('.');
    const suffix = dot > 0 ? name.slice(dot) : '';
    const extension = Buffer.byteLength(suffix) <= Math.min(32, budget - 1) ? suffix : '';
    shortened =
      bytePrefix(
        name.slice(0, extension ? dot : name.length),
        budget - Buffer.byteLength(extension)
      ) + extension;
  }
  return `${id}-${shortened.replace(/[. ]+$/, '_')}`;
}
