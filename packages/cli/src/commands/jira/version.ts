import type { Command } from 'commander';
import { LassiError } from '@wonna/lassi-core';
import {
  allowedVersions,
  assertProjectKey,
  fixVersionsUpdate,
  resolveVersions,
} from '@wonna/lassi-jira';
import type { CliDeps } from '../../deps.js';
import { guardWrite } from '../../guard-write.js';
import { dryRunData, type DryRunPreview } from '../../output/dry-run.js';
import { renderTable } from '../../output/table.js';
import { attach, type Session } from '../../run-command.js';
import { resolveIssueKey } from './issue-key.js';
import { group, jiraClient, withProjectHints } from './shared.js';

const joined = (names: string[]): string => (names.length === 0 ? 'none' : names.join(', '));

/** `jira version …`: the versions of a project. */
export function registerVersion(jira: Command, deps: CliDeps, session: Session): void {
  const version = group(jira, 'version', 'project versions');

  const list = version
    .command('list <PROJECT>')
    .description('the versions an issue can take as a fix version: every one not archived');
  attach<[string], Record<string, never>>(list, deps, session, {
    kind: 'read',
    async run(ctx, [projectArg]) {
      const project = assertProjectKey(projectArg);
      const client = await jiraClient(ctx);
      const versions = allowedVersions(
        await withProjectHints(project, () => client.listVersions(project))
      );
      const rows = versions.map((v) => ({
        name: v.name,
        released: v.released ? 'yes' : 'no',
        releaseDate: v.releaseDate,
        id: v.id,
      }));
      const table = renderTable(
        [
          { key: 'name', header: 'Name' },
          { key: 'released', header: 'Released' },
          { key: 'releaseDate', header: 'Release date' },
          { key: 'id', header: 'Id' },
        ],
        rows
      );
      return {
        markdown:
          versions.length === 0
            ? `no versions to set in ${project} (none, or all archived)\n`
            : `# ${project} fix versions\n\n${table}`,
        data: { project, versions },
        axi: { data: { project, count: rows.length, versions: rows } },
      };
    },
  });
}

/** `jira issue fix-version …`: an issue's fix versions, always versions of its project. */
export function registerIssueFixVersion(issue: Command, deps: CliDeps, session: Session): void {
  const fixVersion = group(issue, 'fix-version', "an issue's fix versions");

  const set = fixVersion
    .command('set <KEY> <VERSION...>')
    .description(
      "replace the issue's fix versions with these (--add keeps the ones it has); each must be a version `jira version list` shows"
    )
    .option('--add', 'add to the fix versions the issue has instead of replacing them');
  attach<[string, string[]], { add?: boolean }>(set, deps, session, {
    kind: 'write',
    async run(ctx, [keyArg, names], opts) {
      const key = await resolveIssueKey(ctx, keyArg);
      const client = await jiraClient(ctx);
      const issue = await client.getIssue(key, { fields: ['project', 'fixVersions'], expand: [] });
      const project = issue.fields.project?.key;
      if (project === undefined) {
        throw new LassiError('internal', `Jira returned ${key} without its project`);
      }
      const versions = await withProjectHints(project, () => client.listVersions(project));
      const wanted = resolveVersions(versions, names, project);
      const current = issue.fields.fixVersions ?? [];
      const currentIds = new Set(current.map((v) => v.id));
      const currentNames = current.map((v) => v.name);
      const noChanges = {
        markdown: `no changes for ${key} (fix versions: ${joined(currentNames)})\n`,
        data: { key, fixVersions: currentNames, added: [] },
      };

      let body: ReturnType<typeof fixVersionsUpdate>;
      let note: string;
      let result: { fixVersions: string[]; added: string[] };
      if (opts.add) {
        const fresh = wanted.filter((v) => !currentIds.has(v.id));
        if (fresh.length === 0) return noChanges;
        body = fixVersionsUpdate('add', fresh);
        const added = fresh.map((v) => v.name);
        note = `adds fix version ${joined(added)} to ${key}`;
        result = { fixVersions: [...currentNames, ...added], added };
      } else {
        const wantedIds = new Set(wanted.map((v) => v.id));
        if (
          wantedIds.size === currentIds.size &&
          [...wantedIds].every((id) => currentIds.has(id))
        ) {
          return noChanges;
        }
        // Replacing drops an archived version the issue has, and it cannot be set again.
        const archived = new Set(versions.filter((v) => v.archived).map((v) => v.id));
        const lost = current.filter(
          (v) => v.id !== undefined && !wantedIds.has(v.id) && archived.has(v.id)
        );
        if (lost.length > 0) {
          ctx.logger.warn(
            `${key} loses archived fix version ${joined(lost.map((v) => v.name))}, which cannot be set again; use --add to keep it`
          );
        }
        body = fixVersionsUpdate('set', wanted);
        const names = wanted.map((v) => v.name);
        note = `sets ${key} fix versions to ${joined(names)} (was: ${joined(currentNames)})`;
        result = { fixVersions: names, added: names.filter((n) => !currentNames.includes(n)) };
      }

      const preview: DryRunPreview = {
        method: 'PUT',
        path: `/rest/api/2/issue/${key}`,
        payloadLabel: opts.add ? 'update (json)' : 'fields (json)',
        payload: JSON.stringify(body, null, 2),
        note,
      };
      if (guardWrite(ctx, preview) === 'dry-run') return { data: dryRunData(preview) };
      await client.updateIssue(key, body);
      return {
        markdown: opts.add
          ? `added fix version ${joined(result.added)} to ${key}\n`
          : `set ${key} fix versions: ${joined(result.fixVersions)}\n`,
        data: { key, ...result },
      };
    },
  });
}
