import type { Command } from 'commander';
import {
  attachAliases,
  exitCodeFor,
  isLassiError,
  pickHint,
  toStderr,
  LassiError,
} from '@wonna/lassi-core';
import { buildContext, type Context, type GlobalFlags } from './context.js';
import type { CliDeps } from './deps.js';
import { assertWriteAllowed } from './guard-write.js';
import { renderAxi, type AxiPayload } from './output/axi.js';
import { toJsonDocument } from './output/json.js';
import { suggestionsFor } from './output/suggestions.js';

export interface Session {
  exitCode: number;
}

export type CommandKind = 'read' | 'write';

export interface CommandResult {
  /** Printed as one JSON document under `--json`. */
  data?: unknown;
  /** Printed as-is otherwise. */
  markdown?: string;
  /** Extra stdout line after the markdown (e.g. the counts trailer). */
  trailer?: string;
  /** Compact payload for `--axi`; when absent, `data` is encoded as is. */
  axi?: AxiPayload;
  exitCode?: number;
  /** A batch may report successful items on stdout and still fail through the error contract. */
  error?: LassiError;
}

/** `lassi jira issue get` → `jira issue get`: the key the suggestion table is indexed by. */
export function commandPath(command: Command): string {
  const names: string[] = [];
  for (let c: Command | null = command; c && c.parent; c = c.parent) names.unshift(c.name());
  return names.join(' ');
}

export interface CommandSpec<A extends unknown[], O> {
  kind: CommandKind;
  run(ctx: Context, args: A, opts: O): Promise<CommandResult | undefined>;
}

/** Fills hint-relevant facts the thrower could not know (config paths, aliases) before rendering. */
export function enrichError(err: LassiError, ctx: Context | undefined): LassiError {
  if (ctx) {
    const product = err.context.product;
    if (product && err.context.tokenFile === undefined) {
      const tokenFile = ctx.config[product].tokenFile;
      if (tokenFile) err.context.tokenFile = tokenFile;
    }
    const aliases = ctx.config.jira.fields;
    if (Object.keys(aliases).length > 0) attachAliases(err, aliases);
  }
  if (err.hint === undefined) {
    const hint = pickHint(err);
    if (hint !== undefined) err.hint = hint;
  }
  return err;
}

/**
 * The single wrapper every command runs through: builds the context, refuses writes under
 * read-only before the handler runs, prints the result, and renders every failure through the error
 * contract with the right exit code.
 */
export function attach<A extends unknown[], O extends object>(
  cmd: Command,
  deps: CliDeps,
  session: Session,
  spec: CommandSpec<A, O>
): void {
  cmd.action(async (...actionArgs: unknown[]) => {
    const command = actionArgs[actionArgs.length - 1] as Command;
    const opts = command.optsWithGlobals<O>();
    const args = actionArgs.slice(0, -2) as A;
    let ctx: Context | undefined;
    try {
      ctx = await buildContext(deps, opts as GlobalFlags);
      if (spec.kind === 'write') assertWriteAllowed(ctx);
      const result = (await spec.run(ctx, args, opts)) ?? {};
      // Every byte on stdout passes the redactor too: a server may echo a token into an error.
      if (ctx.format === 'json') {
        if (result.data !== undefined) deps.stdout.write(ctx.redact(toJsonDocument(result.data)));
      } else if (ctx.format === 'axi') {
        // Never empty: an agent reading AXI always gets a document and a next step.
        const payload = result.axi ?? { data: result.data ?? { ok: true } };
        const help =
          payload.help ??
          suggestionsFor(commandPath(command), {
            args: args as unknown[],
            opts: opts as Record<string, unknown>,
            data: payload.data,
          });
        deps.stdout.write(ctx.redact(renderAxi({ data: payload.data, help })));
      } else {
        if (result.markdown !== undefined) deps.stdout.write(ctx.redact(result.markdown));
        if (result.trailer !== undefined) deps.stdout.write(ctx.redact(`${result.trailer}\n`));
      }
      if (result.error) throw result.error;
      session.exitCode = result.exitCode ?? 0;
    } catch (err) {
      const failure = isLassiError(err)
        ? err
        : new LassiError('internal', err instanceof Error ? err.message : String(err), {
            cause: err,
          });
      enrichError(failure, ctx);
      deps.stderr.write(toStderr(failure, ctx?.redact ?? ((s) => s)));
      session.exitCode = exitCodeFor(failure.code);
    }
  });
}
