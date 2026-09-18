import type { Command } from 'commander';
import type { CliDeps } from '../../deps.js';
import { attach, type Session } from '../../run-command.js';
import { configCheck } from './checks/config.js';
import { connectivityCheck } from './checks/connectivity.js';
import { createmetaCheck } from './checks/createmeta.js';
import { credentialsCheck } from './checks/credentials.js';
import { fieldAliasesCheck } from './checks/field-aliases.js';
import { proxyCheck } from './checks/proxy.js';
import { staleBuildCheck } from './checks/stale-build.js';
import { templatesCheck } from './checks/templates.js';
import { tokenPermissionsCheck } from './checks/token-permissions.js';
import { versionsCheck } from './checks/versions.js';
import { workspaceSecretsCheck } from './checks/workspace-secrets.js';
import { renderDoctor } from './render.js';
import type { Check, CheckResult, DoctorShared } from './types.js';

/** order; later checks reuse the clients the earlier ones resolved. */
export const CHECKS: Check[] = [
  configCheck,
  tokenPermissionsCheck,
  proxyCheck,
  connectivityCheck,
  credentialsCheck,
  versionsCheck,
  createmetaCheck,
  staleBuildCheck,
  workspaceSecretsCheck,
  fieldAliasesCheck,
  templatesCheck,
];

export function registerDoctor(program: Command, deps: CliDeps, session: Session): void {
  const doctor = program
    .command('doctor')
    .description('check config, tokens, TLS, reachability, versions and build freshness');
  attach<[], { json?: boolean }>(doctor, deps, session, {
    kind: 'read',
    async run(ctx) {
      const shared: DoctorShared = { products: new Map(), versions: {}, unreachable: new Set() };
      const results: CheckResult[] = [];
      for (const check of CHECKS) results.push(...(await check(ctx, shared)));
      const failed = results.some((r) => r.status === 'FAIL');
      const count = (status: string): number => results.filter((r) => r.status === status).length;
      return {
        markdown: renderDoctor(results),
        data: results,
        axi: {
          data: {
            summary: {
              pass: count('PASS'),
              warn: count('WARN'),
              fail: count('FAIL'),
              skip: count('SKIP'),
            },
            checks: results,
          },
        },
        exitCode: failed ? 1 : 0,
      };
    },
  });
}
