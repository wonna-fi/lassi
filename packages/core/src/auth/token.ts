import type { Product } from '../errors/lassi-error.js';
import { normalizeSecret, resolveSecret } from './secret.js';

export interface TokenResolution {
  token: string;
  source: 'env' | 'file';
  path?: string;
}

/** Strips a UTF-8 BOM and surrounding whitespace/newlines. */
export function normalizeToken(raw: string): string {
  return normalizeSecret(raw);
}

const ENV_NAME: Record<Product, string> = {
  jira: 'LASSI_JIRA_TOKEN',
  confluence: 'LASSI_CONFLUENCE_TOKEN',
};

/** `LASSI_*_TOKEN` wins over `tokenFile`; an empty or missing file is an auth error (exit 3). */
export async function resolveToken(input: {
  product: Product;
  envToken?: string;
  tokenFile?: string;
  readFile: (path: string) => Promise<string>;
}): Promise<TokenResolution> {
  const resolved = await resolveSecret({
    ...(input.envToken === undefined ? {} : { envValue: input.envToken }),
    ...(input.tokenFile === undefined ? {} : { file: input.tokenFile }),
    readFile: input.readFile,
    context: { product: input.product },
    messages: {
      missing: `no token configured for ${input.product}: set ${input.product}.tokenFile in ~/.lassi.json or ${ENV_NAME[input.product]}`,
      unreadable: (path) => `token file not readable: ${path}`,
      empty: (path) => `token file is empty: ${path}`,
      malformed: (path) =>
        path === undefined
          ? `the ${input.product} token (${ENV_NAME[input.product]} or ${input.product}.token) contains a line break or another control character`
          : `token file has a line break or another control character inside the token: ${path}`,
    },
  });
  return {
    token: resolved.value,
    source: resolved.source,
    ...(resolved.path === undefined ? {} : { path: resolved.path }),
  };
}
