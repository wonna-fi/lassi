import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DefaultAzureCredential } from '@azure/identity';
import { nodeFs, type LassiFs } from '@wonna/lassi-core';
import { readBuildInfo, type BuildInfo } from './build-info.js';

export interface StdinDep {
  /** True on an interactive terminal, where implicit reads would hang waiting for input. */
  isTTY: boolean;
  /** The whole of stdin as UTF-8. */
  read(): Promise<string>;
}

/** Everything the CLI touches in the outside world, so tests can replace all of it. */
export interface CliDeps {
  fetch: typeof fetch;
  stdin: StdinDep;
  env: Record<string, string | undefined>;
  cwd: string;
  homedir: string;
  platform: NodeJS.Platform;
  fs: LassiFs;
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  now: () => Date;
  random: () => number;
  sleep: (ms: number) => Promise<void>;
  buildInfo: BuildInfo;
  /** Repository root (holds `skills/` and `packages/`); resolved from this file's location. */
  repoRoot: string;
  /** An Entra ID access token for `scope` (DefaultAzureCredential: `az login` and friends). */
  azureToken: (scope: string, opts: { timeoutMs: number }) => Promise<string>;
}

/** Refresh this long before Entra's expiry so a token never dies mid-batch. */
const TOKEN_SKEW_MS = 2 * 60_000;

interface CachedToken {
  scope: string;
  token: string;
  expiresOnTimestamp: number;
}

let azureCredential: DefaultAzureCredential | undefined;
let cachedToken: CachedToken | undefined;

/**
 * One credential chain per process and one token per scope until shortly before it expires:
 * DefaultAzureCredential walks the whole chain (an IMDS probe, an `az` subprocess) on every
 * `getToken`, so without this cache each embeddings batch and retry would pay for it. The
 * process timeout and the abort signal keep a wedged `az` from hanging the CLI forever.
 */
async function azureToken(scope: string, opts: { timeoutMs: number }): Promise<string> {
  if (
    cachedToken &&
    cachedToken.scope === scope &&
    cachedToken.expiresOnTimestamp - TOKEN_SKEW_MS > Date.now()
  ) {
    return cachedToken.token;
  }
  // Loaded on demand: MSAL is heavy and only `embeddings.auth: azure-ad` needs it.
  const identity = await import('@azure/identity');
  azureCredential ??= new identity.DefaultAzureCredential({ processTimeoutInMs: opts.timeoutMs });
  const result = await azureCredential.getToken(scope, {
    abortSignal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!result?.token) throw new Error(`no token returned for scope ${scope}`);
  cachedToken = { scope, token: result.token, expiresOnTimestamp: result.expiresOnTimestamp };
  return result.token;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function realDeps(): CliDeps {
  const buildInfo = readBuildInfo();
  return {
    fetch: globalThis.fetch,
    stdin: { isTTY: process.stdin.isTTY === true, read: readStdin },
    env: process.env,
    cwd: process.cwd(),
    homedir: homedir(),
    platform: process.platform,
    fs: nodeFs(),
    stdout: { write: (t) => void process.stdout.write(t) },
    stderr: { write: (t) => void process.stderr.write(t) },
    now: () => new Date(),
    random: Math.random,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    buildInfo,
    // A distribution keeps its skill assets beside package.json; a source checkout keeps them at the workspace root.
    repoRoot: resolve(
      fileURLToPath(new URL(buildInfo.distribution ? '..' : '../../..', import.meta.url))
    ),
    azureToken,
  };
}
