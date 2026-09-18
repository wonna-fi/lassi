import { Command } from 'commander';
import { formatVersion } from './build-info.js';
import { registerConfigShow } from './commands/config-show.js';
import { registerConfluence } from './commands/confluence/index.js';
import { registerDoctor } from './commands/doctor/index.js';
import { registerHelp } from './commands/help-all.js';
import { registerJira } from './commands/jira/index.js';
import { registerSearch } from './commands/search/index.js';
import { registerSkills } from './commands/skills/install.js';
import type { CliDeps } from './deps.js';
import { LassiHelp } from './help/lassi-help.js';
import type { Session } from './run-command.js';

export function createProgram(deps: CliDeps, session: Session): Command {
  const program = new Command('lassi');
  program
    .description('Jira & Confluence Data Center CLI for coding agents')
    .version(formatVersion(deps.buildInfo), '-V, --version', 'print version and git SHA')
    .option('--json', 'machine-readable output: one JSON document on stdout')
    .option('--axi', 'token-efficient output: one TOON document plus help[n] next steps')
    .option('--dry-run', 'print what a write would send and exit 0 without sending')
    .option('--config <path>', 'explicit global config file (replaces ~/.lassi.json)')
    .option('--quiet', 'only errors on stderr')
    .option('--verbose', 'HTTP trace on stderr (tokens redacted)')
    .helpCommand(false)
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({
      writeOut: (s) => deps.stdout.write(s),
      writeErr: (s) => deps.stderr.write(s),
    })
    .configureHelp({ showGlobalOptions: true, sortSubcommands: false, sortOptions: false });
  program.createHelp = () => new LassiHelp();

  registerJira(program, deps, session);
  registerConfluence(program, deps, session);
  registerSearch(program, deps, session);
  registerDoctor(program, deps, session);
  registerConfigShow(program, deps, session);
  registerSkills(program, deps, session);
  registerHelp(program, deps, session);
  return program;
}
