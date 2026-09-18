import { LassiError, findGitHead } from '@wonna/lassi-core';
import { assertIssueKey, issueKeyFromBranch } from '@wonna/lassi-jira';
import type { Context } from '../../context.js';

/** In place of an issue key: the issue named by the current git branch. */
export const BRANCH_KEY = '.';

const fromBranch = new WeakMap<Context, Promise<string>>();

async function keyFromBranch(ctx: Context): Promise<string> {
  const found = await findGitHead(ctx.deps.fs, ctx.deps.cwd);
  const intro = `"${BRANCH_KEY}" names the issue on the current git branch, but`;
  if (found.kind === 'unreadable') {
    throw new LassiError('usage', `${intro} ${found.path} could not be read`, {
      hint: 'check the permissions on the repository, or pass the issue key instead, e.g. PROJ-123',
    });
  }
  if (found.kind === 'malformed') {
    throw new LassiError('usage', `${intro} ${found.path} is not valid git metadata`, {
      hint: 'the file was read but says nothing usable (a stale worktree marker, say); pass the issue key instead, e.g. PROJ-123',
    });
  }
  if (found.kind === 'absent') {
    throw new LassiError('usage', `${intro} ${ctx.deps.cwd} is not inside a git repository`, {
      hint: 'pass the issue key instead, e.g. PROJ-123',
    });
  }
  const head = found.head;
  if (head.branch === undefined) {
    throw new LassiError('usage', `${intro} HEAD is detached (no branch checked out)`, {
      hint: 'pass the issue key instead, e.g. PROJ-123',
    });
  }
  const key = issueKeyFromBranch(head.branch, {
    ...(ctx.config.jira.branchPattern === undefined
      ? {}
      : { pattern: ctx.config.jira.branchPattern }),
    ...(ctx.config.jira.defaultProject === undefined
      ? {}
      : { project: ctx.config.jira.defaultProject }),
  });
  if (key === undefined) {
    throw new LassiError('usage', `branch "${head.branch}" contains no issue key`, {
      hint: 'pass the key, or set jira.branchPattern (a regular expression with one capture group) in .lassi.json',
    });
  }
  ctx.logger.info(`resolved ${BRANCH_KEY} to ${key} (branch ${head.branch})`);
  return key;
}

/**
 * Every command that takes an issue key goes through this first, before any filesystem or network
 * work: `.` resolves from the branch (read once per run), anything else must already be a key.
 */
export async function resolveIssueKey(ctx: Context, arg: string): Promise<string> {
  if (arg !== BRANCH_KEY) return assertIssueKey(arg);
  let pending = fromBranch.get(ctx);
  if (!pending) {
    pending = keyFromBranch(ctx);
    fromBranch.set(ctx, pending);
  }
  return pending;
}
