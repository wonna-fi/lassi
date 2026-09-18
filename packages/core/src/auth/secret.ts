import { LassiError, type HintContext } from '../errors/lassi-error.js';

export interface SecretResolution {
  value: string;
  source: 'env' | 'file';
  path?: string;
}

export interface SecretMessages {
  missing: string;
  unreadable: (path: string) => string;
  empty: (path: string) => string;
}

/** Strips a UTF-8 BOM and surrounding whitespace/newlines. */
export function normalizeSecret(raw: string): string {
  return raw.replace(/^\uFEFF/, '').trim();
}

/**
 * The one way a secret reaches the CLI: an environment value wins, otherwise a file whose content
 * is trimmed. Missing, unreadable or empty is an auth error (exit 3). Shared by the product tokens
 * and the embeddings API key so the messages, the BOM handling and the redaction stay identical.
 */
export async function resolveSecret(input: {
  envValue?: string;
  file?: string;
  readFile: (path: string) => Promise<string>;
  messages: SecretMessages;
  context?: HintContext;
}): Promise<SecretResolution> {
  const fromEnv = input.envValue === undefined ? '' : normalizeSecret(input.envValue);
  if (fromEnv.length > 0) return { value: fromEnv, source: 'env' };
  const path = input.file;
  const context = input.context ?? {};
  if (path === undefined || path.length === 0) {
    throw new LassiError('auth', input.messages.missing, { context });
  }
  let raw: string;
  try {
    raw = await input.readFile(path);
  } catch (err) {
    throw new LassiError('auth', input.messages.unreadable(path), {
      context: { ...context, tokenFile: path },
      cause: err,
    });
  }
  const value = normalizeSecret(raw);
  if (value.length === 0) {
    throw new LassiError('auth', input.messages.empty(path), {
      context: { ...context, tokenFile: path },
    });
  }
  return { value, source: 'file', path };
}
