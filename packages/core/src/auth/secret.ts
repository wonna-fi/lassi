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
  /** A line break or another control character inside the value; no `path` for an inline value. */
  malformed: (path?: string) => string;
}

/** Strips a UTF-8 BOM and surrounding whitespace/newlines. */
export function normalizeSecret(raw: string): string {
  return raw.replace(/^\uFEFF/, '').trim();
}

/**
 * `fetch` rejects a header value with a line break in an error that quotes the whole value, and
 * once that message has its newline collapsed or JSON-escaped the redactor's exact match no longer
 * finds the secret. No real token contains one, so such a value is refused before it is sent.
 */
const CONTROL_CHARACTER = /\p{Cc}/u;

/**
 * The one way a secret reaches the CLI: an environment value wins, otherwise a file whose content
 * is trimmed. Missing, unreadable, empty or multi-line is an auth error (exit 3). Shared by the product tokens
 * and the embeddings API key so the messages, the BOM handling and the redaction stay identical.
 */
export async function resolveSecret(input: {
  envValue?: string;
  file?: string;
  readFile: (path: string) => Promise<string>;
  messages: SecretMessages;
  context?: HintContext;
}): Promise<SecretResolution> {
  const context = input.context ?? {};
  const fromEnv = input.envValue === undefined ? '' : normalizeSecret(input.envValue);
  if (fromEnv.length > 0) {
    if (CONTROL_CHARACTER.test(fromEnv)) {
      throw new LassiError('auth', input.messages.malformed(), { context });
    }
    return { value: fromEnv, source: 'env' };
  }
  const path = input.file;
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
  if (CONTROL_CHARACTER.test(value)) {
    throw new LassiError('auth', input.messages.malformed(path), {
      context: { ...context, tokenFile: path },
      hint: `keep only the secret in ${path}, on a single line`,
    });
  }
  return { value, source: 'file', path };
}
