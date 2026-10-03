import type { Command } from 'commander';
import type { CliDeps } from '../../deps.js';
import { markNamespace } from '../../help/lassi-help.js';
import type { Session } from '../../run-command.js';
import { registerAttach } from './attach.js';
import { registerCommentDelete, registerPageComments } from './comment.js';
import { registerPage } from './page.js';
import { registerSearch } from './search.js';
import { group } from './shared.js';
import { registerStats } from './stats.js';

/** `lassi confluence …` (alias `conf`) namespace: pages, search, tree, comments, attachments. */
export function registerConfluence(program: Command, deps: CliDeps, session: Session): Command {
  const confluence = program
    .command('confluence')
    .alias('conf')
    .description('Confluence Data Center: pages, search, comments, attachments');
  markNamespace(confluence);
  const page = group(confluence, 'page', 'pages, footer comments and attachments');
  registerPage(page, deps, session);
  registerPageComments(page, deps, session);
  registerAttach(page, deps, session);

  registerSearch(confluence, deps, session);
  registerCommentDelete(confluence, deps, session);
  registerStats(confluence, deps, session);
  return confluence;
}
