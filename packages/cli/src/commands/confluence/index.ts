import type { Command } from 'commander';
import type { CliDeps } from '../../deps.js';
import { markNamespace } from '../../help/lassi-help.js';
import type { Session } from '../../run-command.js';
import { registerAttach } from './attach.js';
import { registerComment } from './comment.js';
import { registerPage } from './page.js';
import { registerSearch } from './search.js';
import { registerStats } from './stats.js';

/** `lassi confluence …` (alias `conf`) namespace: pages, search, tree, comments, attachments. */
export function registerConfluence(program: Command, deps: CliDeps, session: Session): Command {
  const confluence = program
    .command('confluence')
    .alias('conf')
    .description('Confluence Data Center: pages, search, comments, attachments');
  markNamespace(confluence);
  registerPage(confluence, deps, session);
  registerSearch(confluence, deps, session);
  registerComment(confluence, deps, session);
  registerAttach(confluence, deps, session);
  registerStats(confluence, deps, session);
  return confluence;
}
