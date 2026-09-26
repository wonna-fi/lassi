import {
  LassiError,
  createHttpClient,
  createLogger,
  createRedactor,
  loadConfig,
  resolveSecret,
  resolveToken,
  type LassiConfig,
  type HttpClient,
  type LoadedConfig,
  type Logger,
  type LogLevel,
  type Product,
  type TokenResolution,
} from '@wonna/lassi-core';
import type { CliDeps } from './deps.js';
import { isReadOnly } from './guard-write.js';

export type OutputFormat = 'markdown' | 'json' | 'axi';

export interface GlobalFlags {
  json?: boolean;
  axi?: boolean;
  dryRun?: boolean;
  config?: string;
  quiet?: boolean;
  verbose?: boolean;
}

export interface ProductClient {
  product: Product;
  baseUrl: string;
  http: HttpClient;
  token: TokenResolution;
}

export type EmbeddingsAuth = LassiConfig['embeddings']['auth'];

/** Which header carries the credential for each `embeddings.auth`; tsc keeps it complete. */
const AUTH_SCHEME: Record<EmbeddingsAuth, 'bearer' | 'api-key'> = {
  bearer: 'bearer',
  'api-key': 'api-key',
  'azure-ad': 'bearer',
};

/** The configured OpenAI-compatible embeddings endpoint. */
export interface EmbeddingsClientConfig {
  http: HttpClient;
  auth: EmbeddingsAuth;
  model: string;
  apiVersion?: string;
  dimensions?: number;
  batchSize: number;
  chunkChars: number;
  chunkOverlap: number;
  minScore: number;
}

export interface Context {
  deps: CliDeps;
  config: LassiConfig;
  loaded: LoadedConfig;
  logger: Logger;
  redact: (text: string) => string;
  /** Decided once per run from `output.json` / `output.axi` and the flags. */
  format: OutputFormat;
  dryRun: boolean;
  readOnly: boolean;
  /** Lazily resolves the token and builds the HTTP client for a product (memoised). */
  product(name: Product): Promise<ProductClient>;
  /** Lazily resolves the API key and builds the HTTP client for `embeddings` (memoised). */
  embeddings(): Promise<EmbeddingsClientConfig>;
}

function logLevel(flags: GlobalFlags): LogLevel {
  if (flags.quiet) return 'error';
  if (flags.verbose) return 'debug';
  return 'warn';
}

const ENV_URL: Record<Product, string> = {
  jira: 'LASSI_JIRA_URL',
  confluence: 'LASSI_CONFLUENCE_URL',
};

export async function buildContext(deps: CliDeps, flags: GlobalFlags): Promise<Context> {
  const secrets = new Set<string>();
  const redact = (text: string): string => createRedactor(secrets)(text);
  const logger = createLogger({ level: logLevel(flags), write: deps.stderr.write, redact });
  if (flags.json && flags.axi) {
    throw new LassiError('usage', '--json and --axi are mutually exclusive');
  }
  // A flag beats a file default in both directions: `--axi` turns a configured `output.json` off.
  const outputFlags = flags.json
    ? { 'output.json': true, 'output.axi': false }
    : flags.axi
      ? { 'output.axi': true, 'output.json': false }
      : {};

  const loaded = await loadConfig({
    env: deps.env,
    cwd: deps.cwd,
    homedir: deps.homedir,
    ...(flags.config === undefined ? {} : { explicitPath: flags.config }),
    flags: outputFlags,
    fs: deps.fs,
  });
  for (const s of loaded.secrets) secrets.add(s);

  const clients = new Map<Product, Promise<ProductClient>>();
  const build = async (name: Product): Promise<ProductClient> => {
    const section = loaded.config[name];
    if (!section.url) {
      throw new LassiError(
        'usage',
        `${name}.url is not configured; set it in ~/.lassi.json or ${ENV_URL[name]}`,
        {
          context: { product: name },
        }
      );
    }
    const token = await resolveToken({
      product: name,
      ...(section.token === undefined ? {} : { envToken: section.token }),
      ...(section.tokenFile === undefined ? {} : { tokenFile: section.tokenFile }),
      readFile: (p) => deps.fs.readFile(p),
    });
    secrets.add(token.token);
    const http = createHttpClient({
      baseUrl: section.url,
      token: token.token,
      fetch: deps.fetch,
      timeoutMs: loaded.config.http.timeoutMs,
      retry: { maxAttempts: loaded.config.http.retries },
      logger,
      product: name,
      random: deps.random,
      sleep: deps.sleep,
    });
    return { product: name, baseUrl: section.url, http, token };
  };

  let embeddings: Promise<EmbeddingsClientConfig> | undefined;
  const buildEmbeddings = async (): Promise<EmbeddingsClientConfig> => {
    const section = loaded.config.embeddings;
    if (!section.url || !section.model) {
      throw new LassiError(
        'usage',
        'embeddings are not configured: set embeddings.url and embeddings.model in ~/.lassi.json',
        {
          hint: 'any OpenAI-compatible /embeddings endpoint works, e.g. { "embeddings": { "url": "https://embeddings.example.internal/v1", "model": "text-embedding-3-small", "apiKeyFile": "~/.lassi/tokens/embeddings.txt" } }; Azure OpenAI behind `az login` uses "auth": "azure-ad" instead of a key',
        }
      );
    }
    let token: string | (() => Promise<string>);
    if (section.auth === 'azure-ad') {
      // Entra ID: a fresh token per request through DefaultAzureCredential (`az login` on a laptop).
      token = async () => {
        try {
          const value = await deps.azureToken(section.azureScope, {
            timeoutMs: loaded.config.http.timeoutMs,
          });
          secrets.add(value);
          return value;
        } catch (err) {
          // DefaultAzureCredential reports one line per credential it tried; the first line is the
          // human line of the contract, the rest travel in errorMessages.
          const lines = (err instanceof Error ? err.message : String(err))
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
          throw new LassiError(
            'auth',
            `Azure credential failed for ${section.azureScope}: ${lines[0] ?? 'unknown error'}`,
            {
              ...(lines.length > 1 ? { errorMessages: lines.slice(1) } : {}),
              hint: 'run `az login` (DefaultAzureCredential picks the Azure CLI up); set AZURE_TOKEN_CREDENTIALS=dev to skip the managed-identity probe on a laptop',
              cause: err,
            }
          );
        }
      };
    } else {
      const key = await resolveSecret({
        ...(section.apiKey === undefined ? {} : { envValue: section.apiKey }),
        ...(section.apiKeyFile === undefined ? {} : { file: section.apiKeyFile }),
        readFile: (p) => deps.fs.readFile(p),
        messages: {
          missing:
            'no embeddings API key configured: set embeddings.apiKeyFile in ~/.lassi.json or LASSI_EMBEDDINGS_API_KEY (or embeddings.auth: "azure-ad" for az login)',
          unreadable: (path) => `embeddings API key file not readable: ${path}`,
          empty: (path) => `embeddings API key file is empty: ${path}`,
          malformed: (path) =>
            path === undefined
              ? 'the embeddings API key (LASSI_EMBEDDINGS_API_KEY or embeddings.apiKey) contains a line break or another control character'
              : `embeddings API key file has a line break or another control character inside the key: ${path}`,
        },
      });
      secrets.add(key.value);
      token = key.value;
    }
    const http = createHttpClient({
      baseUrl: section.url,
      token,
      authScheme: AUTH_SCHEME[section.auth],
      fetch: deps.fetch,
      timeoutMs: loaded.config.http.timeoutMs,
      retry: { maxAttempts: loaded.config.http.retries },
      logger,
      random: deps.random,
      sleep: deps.sleep,
    });
    return {
      http,
      auth: section.auth,
      model: section.model,
      ...(section.apiVersion === undefined ? {} : { apiVersion: section.apiVersion }),
      ...(section.dimensions === undefined ? {} : { dimensions: section.dimensions }),
      batchSize: section.batchSize,
      chunkChars: section.chunkChars,
      chunkOverlap: section.chunkOverlap,
      minScore: section.minScore,
    };
  };

  return {
    deps,
    config: loaded.config,
    loaded,
    logger,
    redact,
    format: loaded.config.output.axi ? 'axi' : loaded.config.output.json ? 'json' : 'markdown',
    dryRun: flags.dryRun === true,
    readOnly: isReadOnly(deps.env),
    product(name) {
      let pending = clients.get(name);
      if (!pending) {
        pending = build(name);
        clients.set(name, pending);
      }
      return pending;
    },
    embeddings() {
      embeddings ??= buildEmbeddings();
      return embeddings;
    },
  };
}
