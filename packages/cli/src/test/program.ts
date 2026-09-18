import {
  fakeFetch,
  memFs,
  type FakeFetch,
  type MemFs,
  type Route,
} from '@wonna/lassi-core/testing';
import type { CliDeps } from '../deps.js';
import { runCli } from '../run.js';

export interface TestProgram {
  run(argv: string[]): Promise<number>;
  stdout(): string;
  stderr(): string;
  deps: CliDeps;
  fetch: FakeFetch;
  fs: MemFs;
}

export interface TestProgramOptions {
  routes?: Route[];
  env?: Record<string, string | undefined>;
  files?: Record<string, string>;
  cwd?: string;
  homedir?: string;
  platform?: NodeJS.Platform;
  builtAt?: string;
  /** Piped stdin content; when given, `isTTY` is false. */
  stdin?: string;
  /** Fake Entra ID token provider (default: resolves `aad-token-123`). */
  azureToken?: (scope: string, opts: { timeoutMs: number }) => Promise<string>;
}

/** A fully injected CLI: in-memory fs, fake fetch, captured stdout/stderr, fixed clock. */
export function makeTestProgram(opts: TestProgramOptions = {}): TestProgram {
  const out: string[] = [];
  const err: string[] = [];
  const fetch = fakeFetch(opts.routes ?? []);
  const fs = memFs(opts.files ?? {});
  const deps: CliDeps = {
    fetch,
    stdin: { isTTY: opts.stdin === undefined, read: async () => opts.stdin ?? '' },
    env: opts.env ?? {},
    cwd: opts.cwd ?? '/home/u/proj',
    homedir: opts.homedir ?? '/home/u',
    platform: opts.platform ?? 'linux',
    fs,
    stdout: { write: (t) => void out.push(t) },
    stderr: { write: (t) => void err.push(t) },
    now: () => new Date('2026-09-04T10:00:00.000Z'),
    random: () => 0,
    sleep: async () => {},
    buildInfo: {
      version: '0.0.0-test',
      sha: 'testsha',
      ...(opts.builtAt ? { builtAt: opts.builtAt } : {}),
    },
    repoRoot: '/repo',
    azureToken: opts.azureToken ?? (async () => 'aad-token-123'),
  };
  return {
    run: (argv) => runCli(argv, deps),
    stdout: () => out.join(''),
    stderr: () => err.join(''),
    deps,
    fetch,
    fs,
  };
}

/** Env that configures both products through variables only (no files needed). */
export const BOTH_PRODUCTS_ENV = {
  LASSI_JIRA_URL: 'https://jira.example.internal',
  LASSI_JIRA_TOKEN: 'jira-secret-token',
  LASSI_CONFLUENCE_URL: 'https://confluence.example.internal',
  LASSI_CONFLUENCE_TOKEN: 'confluence-secret-token',
};

export function lastJsonLine(text: string): unknown {
  const lines = text.trim().split('\n');
  return JSON.parse(lines[lines.length - 1] as string);
}
