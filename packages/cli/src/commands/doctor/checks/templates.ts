import { createJiraClient, fieldIdFor } from '@wonna/lassi-jira';
import type { Check, CheckResult } from '../types.js';
import { productState } from '../types.js';

/** Every `jira.templates` entry: its file exists, its fields resolve, its type is in its project. */
export const templatesCheck: Check = async (ctx, shared) => {
  const name = 'Jira issue templates';
  const entries = Object.entries(ctx.config.jira.templates);
  if (entries.length === 0) return [{ name, status: 'SKIP', detail: 'no templates configured' }];
  const state = await productState(ctx, shared, 'jira');
  const unreachable = shared.unreachable.has('jira');
  const client =
    state.client && !unreachable
      ? createJiraClient({ baseUrl: state.client.baseUrl, http: state.client.http })
      : undefined;
  const typesByProject = new Map<string, Promise<string[] | undefined>>();
  const typesIn = (project: string): Promise<string[] | undefined> => {
    let pending = typesByProject.get(project);
    if (!pending) {
      pending = client
        ? client
            .issueTypes(project)
            .then((list) => list.issueTypes.map((t) => t.name))
            .catch(() => undefined)
        : Promise.resolve(undefined);
      typesByProject.set(project, pending);
    }
    return pending;
  };
  const out: CheckResult[] = [];
  for (const [templateName, t] of entries) {
    const problems: string[] = [];
    if (t.descriptionFile !== undefined) {
      // Read it rather than `exists`: a directory or an unreadable file also "exists".
      try {
        await ctx.deps.fs.readFile(t.descriptionFile);
      } catch (err) {
        problems.push(
          `cannot read description file ${t.descriptionFile}: ${(err as Error).message}`
        );
      }
    }
    for (const key of Object.keys(t.fields)) {
      const id = fieldIdFor(ctx.config.jira.fields, key);
      if (id === undefined) problems.push(`unknown field "${key}"`);
      else if (id === 'description' || id === 'project' || id === 'issuetype')
        problems.push(`"${key}" belongs in the template's type/project/description, not in fields`);
    }
    const project = t.project ?? ctx.config.jira.defaultProject;
    const typeNote = t.type ?? 'any type';
    // A row never claims to have verified something nothing looked at. Unconfigured and
    // unreachable are both SKIP, and the detail says which; a reachable instance whose createmeta
    // failed is a WARN, because that is the one the user can act on from here.
    let unverified: string | undefined;
    if (t.type !== undefined && project === undefined) {
      // Nothing to look the type up in: no `project` on the template and no `jira.defaultProject`.
      unverified = `type "${t.type}" not verified (no project: set jira.defaultProject or the template's project)`;
    } else if (t.type !== undefined && project !== undefined) {
      const types = client === undefined ? undefined : await typesIn(project);
      if (types === undefined) {
        // `client` is undefined whenever no request could be made: unconfigured, unreachable, or
        // configured with credentials that would not resolve (a URL and no token, an unreadable
        // tokenFile). Only a client that existed and whose createmeta was refused is a problem this
        // row can ask the user to act on; the rest are "this run did not look", which every sibling
        // check reports as SKIP with the FAIL living on its own row.
        const why = !state.configured
          ? 'Jira is not configured'
          : unreachable
            ? 'unreachable (see connectivity)'
            : client === undefined
              ? 'Jira credentials could not be resolved (see the config and credentials rows)'
              : 'createmeta failed';
        unverified = `type "${t.type}" not verified (${why})`;
        if (client !== undefined) problems.push(unverified);
      } else if (!types.some((n) => n.toLowerCase() === t.type?.toLowerCase())) {
        problems.push(`type "${t.type}" is not available in ${project}`);
      }
    }
    const name = `template ${templateName}`;
    const summary = `${typeNote} in ${project ?? '(project from --project)'}, ${Object.keys(t.fields).length} field(s)`;
    if (problems.length > 0) {
      out.push({
        name,
        status: 'WARN',
        detail: problems.join('; '),
        hint: 'fix jira.templates in .lassi.json; run `lassi jira fields` and `lassi jira issue createmeta <P>`',
      });
    } else if (unverified !== undefined) {
      out.push({ name, status: 'SKIP', detail: `${summary}; ${unverified}` });
    } else {
      out.push({ name, status: 'PASS', detail: summary });
    }
  }
  return out;
};
