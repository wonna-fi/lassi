import type { Command } from 'commander';
import type { CliDeps } from '../../deps.js';
import { markNamespace } from '../../help/lassi-help.js';
import type { Session } from '../../run-command.js';
import { registerAttach } from './attach.js';
import { registerComment } from './comment.js';
import { registerDigest } from './digest.js';
import { registerIssue } from './issue.js';
import { registerReference } from './reference.js';
import { registerTemplates } from './templates.js';
import { registerTransition } from './transition.js';

/** `lassi jira …` namespace: issues, comments, transitions, attachments and links. */
export function registerJira(program: Command, deps: CliDeps, session: Session): Command {
  const jira = program
    .command('jira')
    .description(
      'Jira Data Center: issues, comments, transitions, attachments, links; "." as a KEY means the issue named by the current git branch'
    );
  markNamespace(jira);
  registerIssue(jira, deps, session);
  registerReference(jira, deps, session);
  registerComment(jira, deps, session);
  registerTransition(jira, deps, session);
  registerAttach(jira, deps, session);
  registerDigest(jira, deps, session);
  registerTemplates(jira, deps, session);
  return jira;
}
