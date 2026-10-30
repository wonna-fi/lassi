import type { Command } from 'commander';
import { labelUpdate, planLabelChange } from '@wonna/lassi-jira';
import type { CliDeps } from '../../deps.js';
import { guardWrite } from '../../guard-write.js';
import { dryRunData, type DryRunPreview } from '../../output/dry-run.js';
import { attach, type Session } from '../../run-command.js';
import { resolveIssueKey } from './issue-key.js';
import { group, jiraClient } from './shared.js';

export function registerIssueLabel(issue: Command, deps: CliDeps, session: Session): void {
  const label = group(
    issue,
    'label',
    'add or remove issue labels; issue update --field labels=… replaces the whole list'
  );
  for (const mode of ['add', 'remove'] as const) {
    const command = label
      .command(`${mode} <KEY> <LABEL...>`)
      .description(
        mode === 'add'
          ? 'add case-sensitive labels, keeping the others; existing labels are unchanged'
          : 'remove case-sensitive labels, keeping the others; absent labels are unchanged'
      );
    attach<[string, string[]], Record<string, never>>(command, deps, session, {
      kind: 'write',
      async run(ctx, [keyArg, labels]) {
        const key = await resolveIssueKey(ctx, keyArg);
        const client = await jiraClient(ctx);
        const issue = await client.getIssue(key, { fields: ['labels'], expand: [] });
        const plan = planLabelChange(mode, labels, issue.fields.labels ?? []);
        const data = {
          key,
          ...(mode === 'add' ? { added: plan.changed } : { removed: plan.changed }),
          unchanged: plan.unchanged,
        };
        const unchanged =
          plan.unchanged.length === 0
            ? ''
            : `unchanged labels (already ${mode === 'add' ? 'present' : 'absent'}): ${plan.unchanged.join(', ')}\n`;
        if (plan.changed.length === 0) {
          return { markdown: `no changes for ${key}\n${unchanged}`, data };
        }

        const body = labelUpdate(mode, plan.changed);
        const preview: DryRunPreview = {
          method: 'PUT',
          path: `/rest/api/2/issue/${key}`,
          payloadLabel: 'update (json)',
          payload: JSON.stringify(body, null, 2),
          note: `${mode === 'add' ? 'adds' : 'removes'} labels ${plan.changed.join(', ')} ${mode === 'add' ? 'to' : 'from'} ${key}${unchanged ? `\n${unchanged.trimEnd()}` : ''}`,
        };
        if (guardWrite(ctx, preview) === 'dry-run') {
          return { data: { ...dryRunData(preview), key, unchanged: plan.unchanged } };
        }
        await client.updateIssue(key, body);
        return {
          markdown: `${mode === 'add' ? 'added' : 'removed'} labels ${plan.changed.join(', ')} ${mode === 'add' ? 'to' : 'from'} ${key}\n${unchanged}`,
          data,
        };
      },
    });
  }
}
