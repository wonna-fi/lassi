import { createJiraClient } from '@wonna/lassi-jira';
import type { Check } from '../types.js';
import { productState } from '../types.js';

/**
 * which createmeta shape the installed Jira serves (needs a project to probe).
 * Only the issue-type list is fetched: field metadata costs one slow request per type.
 */
export const createmetaCheck: Check = async (ctx, shared) => {
  const name = 'Jira createmeta';
  const state = await productState(ctx, shared, 'jira');
  if (!state.client) return [{ name, status: 'SKIP', detail: 'Jira not configured' }];
  if (shared.unreachable.has('jira'))
    return [{ name, status: 'SKIP', detail: 'unreachable (see connectivity)' }];
  const project = ctx.config.jira.defaultProject;
  if (!project)
    return [
      { name, status: 'SKIP', detail: 'set jira.defaultProject to probe the createmeta shape' },
    ];
  const client = createJiraClient({ baseUrl: state.client.baseUrl, http: state.client.http });
  try {
    const meta = await client.issueTypes(project);
    return [
      {
        name,
        status: 'PASS',
        detail: `${meta.mode} (${meta.issueTypes.length} issue types in ${project})`,
      },
    ];
  } catch (err) {
    return [
      {
        name,
        status: 'WARN',
        detail: `could not read createmeta for ${project}: ${(err as Error).message}`,
      },
    ];
  }
};
