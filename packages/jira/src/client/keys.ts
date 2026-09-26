import { LassiError, escapeRegExp } from '@wonna/lassi-core';

/** an uppercase project key (underscore allowed), a dash, digits. */
export const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

/** The same shape anywhere in a string, any case: branch names are usually lowercase. */
const KEY_ANYWHERE = /[A-Z][A-Z0-9_]+-\d+/i;

export function isIssueKey(value: string): boolean {
  return ISSUE_KEY.test(value);
}

export function assertIssueKey(value: string): string {
  if (!isIssueKey(value)) {
    throw new LassiError('usage', `not a Jira issue key: ${value} (expected e.g. PROJ-123)`);
  }
  return value;
}

/** Comment ids are decimal; `..` would otherwise resolve `…/comment/..` to the issue itself. */
export function assertCommentId(value: string): string {
  if (!/^\d+$/.test(value)) {
    throw new LassiError(
      'usage',
      `not a Jira comment id: ${value} (expected a number, e.g. 10001)`
    );
  }
  return value;
}

export interface BranchKeyOptions {
  /** `jira.branchPattern`: a regular expression whose first capture group is the key. */
  pattern?: string;
  /** `jira.defaultProject`: tried first, so `release/v2-1` never turns into `V2-1`. */
  project?: string;
}

/** Compiles `jira.branchPattern`; a pattern that does not compile or has no capture group is a usage error. */
export function compileBranchPattern(pattern: string): RegExp {
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, 'i');
  } catch (err) {
    throw new LassiError(
      'usage',
      `jira.branchPattern is not a valid regular expression: ${(err as Error).message}`
    );
  }
  // An empty alternative always matches, and the match array's length exposes the group count.
  const groups = (new RegExp(`${pattern}|`, 'i').exec('')?.length ?? 1) - 1;
  if (groups < 1) {
    throw new LassiError(
      'usage',
      'jira.branchPattern needs a capture group around the issue key, e.g. "^feature/([a-z]+-\\\\d+)"'
    );
  }
  return compiled;
}

/** The issue key named by a branch such as `feature/PROJ-123-login`, upper-cased; undefined when there is none. */
export function issueKeyFromBranch(
  branch: string,
  opts: BranchKeyOptions = {}
): string | undefined {
  let candidate: string | undefined;
  if (opts.pattern !== undefined) {
    candidate = compileBranchPattern(opts.pattern).exec(branch)?.[1];
  } else {
    if (opts.project) {
      // Not `\b`: `_` is a word character, and `feature_PROJ-9_fix` must still find PROJ-9.
      candidate = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(opts.project)}-\\d+(?!\\d)`, 'i').exec(
        branch
      )?.[0];
    }
    candidate ??= KEY_ANYWHERE.exec(branch)?.[0];
  }
  if (candidate === undefined) return undefined;
  const key = candidate.toUpperCase();
  return isIssueKey(key) ? key : undefined;
}
