import type { Command } from 'commander';
import { LassiError } from '@wonna/lassi-core';
import type { CliDeps } from '../deps.js';
import { renderCommandTree } from '../help/markdown.js';
import type { Session } from '../run-command.js';

/** `lassi help [command...]` and `lassi help --all` (full tree as markdown, ). */
export function registerHelp(program: Command, deps: CliDeps, session: Session): void {
  program
    .command('help [command...]')
    .description('show help for a command, or --all for the whole tree as markdown')
    .option('--all', 'dump every command and flag as markdown')
    .action((path: string[], opts: { all?: boolean }) => {
      if (opts.all) {
        deps.stdout.write(renderCommandTree(program));
        session.exitCode = 0;
        return;
      }
      let cmd: Command = program;
      for (const name of path) {
        const next = cmd.commands.find((c) => c.name() === name || c.aliases().includes(name));
        if (!next) {
          const err = new LassiError('usage', `unknown command: ${[...path].join(' ')}`);
          deps.stderr.write(
            `error: ${err.message}\n${JSON.stringify({ code: err.code, message: err.message })}\n`
          );
          session.exitCode = 2;
          return;
        }
        cmd = next;
      }
      cmd.outputHelp();
      session.exitCode = 0;
    });
}
