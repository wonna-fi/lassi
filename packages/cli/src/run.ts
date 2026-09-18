import { CommanderError } from 'commander';
import { LassiError, toErrorJson } from '@wonna/lassi-core';
import { createProgram } from './cli.js';
import type { CliDeps } from './deps.js';
import type { Session } from './run-command.js';

const HELP_CODES = new Set(['commander.helpDisplayed', 'commander.version', 'commander.help']);

/** Parses user arguments (without node/script) and returns the exit code; never calls process.exit. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const session: Session = { exitCode: 0 };
  const program = createProgram(deps, session);
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      if (HELP_CODES.has(err.code)) return 0;
      // commander already wrote its human line; add the JSON line of the contract.
      const message = err.message.replace(/^error:\s*/, '');
      deps.stderr.write(`${JSON.stringify(toErrorJson(new LassiError('usage', message)))}\n`);
      return 2;
    }
    const failure = new LassiError('internal', err instanceof Error ? err.message : String(err), {
      cause: err,
    });
    deps.stderr.write(`error: ${failure.message}\n${JSON.stringify(toErrorJson(failure))}\n`);
    return 1;
  }
  return session.exitCode;
}
