import type { Command } from 'commander';
import type { CliDeps } from '../../deps.js';
import { markNamespace } from '../../help/lassi-help.js';
import type { Session } from '../../run-command.js';
import { registerAttach } from './attach.js';
import { registerComment } from './comment.js';
import { registerComponent } from './component.js';
import { registerDigest } from './digest.js';
import { registerIssue } from './issue.js';
import { registerIssueLinks } from './link.js';
import { registerReference } from './reference.js';
import { group } from './shared.js';
import { registerTemplates } from './templates.js';
import { registerTransition } from './transition.js';
import { registerVersion } from './version.js';

/** `lassi jira …` namespace: issues, project catalogs, and instance references. */
export function registerJira(program: Command, deps: CliDeps, session: Session): Command {
  const jira = program
    .command('jira')
    .description(
      'Jira Data Center: issues, project catalogs, and instance references; "." as a KEY means the issue named by the current git branch'
    );
  markNamespace(jira);
  const issue = group(jira, 'issue', 'issues, comments, attachments, transitions and links');
  registerIssue(issue, deps, session);
  registerComment(issue, deps, session);
  registerTransition(issue, deps, session);
  registerAttach(issue, deps, session);
  registerIssueLinks(issue, deps, session);

  const project = group(jira, 'project', 'project component and version catalogs');
  registerComponent(project, deps, session);
  registerVersion(project, deps, session);

  registerReference(jira, deps, session);
  registerDigest(jira, deps, session);
  registerTemplates(jira, deps, session);
  return jira;
}
