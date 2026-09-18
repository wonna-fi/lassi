import { LassiError, resolvePath } from '@wonna/lassi-core';
import type { CliDeps } from '../deps.js';

export interface BodySource {
  body?: string;
  file?: string;
}

/**
 * `(--body <md> | --file <md> | stdin)`. `--body` wins, then `--file`; `--file -` reads
 * stdin explicitly. Implicit stdin is used only for a required body and only when stdin is not a
 * terminal: an optional body must never block a caller whose stdin merely happens to be open.
 */
export async function readBodyInput(
  deps: CliDeps,
  source: BodySource,
  opts: { required: boolean }
): Promise<string | undefined> {
  if (source.body !== undefined && source.file !== undefined) {
    throw new LassiError('usage', 'pass either --body or --file, not both');
  }
  if (source.body !== undefined) return source.body;
  if (source.file === '-') return deps.stdin.read();
  if (source.file !== undefined) {
    try {
      return await deps.fs.readFile(resolvePath(deps.cwd, source.file));
    } catch (err) {
      throw new LassiError('usage', `cannot read ${source.file}: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }
  if (opts.required && !deps.stdin.isTTY) {
    const text = await deps.stdin.read();
    if (text.length > 0) return text;
  }
  if (opts.required) {
    throw new LassiError(
      'usage',
      'provide --body <markdown>, --file <path> or pipe markdown on stdin'
    );
  }
  return undefined;
}
