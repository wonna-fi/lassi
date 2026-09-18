import { LassiError, splitFrontmatter, type LassiFs } from '@wonna/lassi-core';
import type { WorkingFile } from './schema.js';

export async function readWorkingFile(path: string, fs: LassiFs): Promise<WorkingFile> {
  let text: string;
  try {
    text = await fs.readFile(path);
  } catch (err) {
    throw new LassiError('usage', `working file not found: ${path}`, { cause: err });
  }
  const { data, body } = splitFrontmatter(text);
  if (data === undefined) {
    throw new LassiError(
      'usage',
      `${path} has no YAML frontmatter; use \`get --out\` to create working files`
    );
  }
  return { frontmatter: data, body };
}
