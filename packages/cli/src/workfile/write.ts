import { createHash } from 'node:crypto';
import type { LassiFs } from '@wonna/lassi-core';
import { renderEntity } from '../output/entity.js';
import type { WorkingFile } from './schema.js';

export async function writeWorkingFile(
  path: string,
  file: WorkingFile,
  fs: LassiFs,
  comments?: Record<string, string>
): Promise<string> {
  const content = renderEntity(file.frontmatter, file.body, comments);
  await fs.writeFile(path, content);
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
