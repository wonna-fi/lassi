import { pathApi } from '../fs/paths.js';

/** The two calls needed to find the checked-out branch; `LassiFs` satisfies it. */
export interface GitFs {
  readFile(path: string): Promise<string>;
  stat(path: string): Promise<{ isDirectory: boolean }>;
}

export interface GitHead {
  /** The directory whose `HEAD` was read: `.git`, or the `gitdir:` a worktree's `.git` file points at. */
  gitDir: string;
  /** Absent when HEAD is detached. */
  branch?: string;
}

/** What a detached HEAD holds: a bare object id, sha-1 or sha-256. */
const DETACHED_HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** A symbolic HEAD: `ref: <target>`, with the target checked below. */
const SYMBOLIC_HEAD = /^ref:\s*(\S+)$/;

const RESERVED = /[~^:?*[\\]/;

/**
 * `git check-ref-format --allow-onelevel=false` plus HEAD's own rule that the target lives under
 * `refs/`, in full rather than as a subset: a refname is
 * slash-separated components, and git refuses one that has an empty component, a component starting
 * with a dot or ending in `.lock`, a `..` or `@{` anywhere, a control character, space, or any of
 * `~ ^ : ? * [ \`, a trailing dot, or the single character `@`. HEAD additionally needs a full ref,
 * so one component is not enough.
 *
 * Written out because the alternative is discovering the rules one review round at a time.
 */
function isRefName(target: string): boolean {
  if (target.endsWith('.') || target.includes('..') || target.includes('@{')) return false;
  if (target === '@' || RESERVED.test(target)) return false;
  for (const ch of target) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x20 || cp === 0x7f) return false;
  }
  // HEAD points inside `refs/` or nowhere: `git symbolic-ref HEAD foo/bar` refuses outright, even
  // though `check-ref-format` accepts `foo/bar` as a refname in its own right.
  if (!target.startsWith('refs/')) return false;
  const parts = target.split('/');
  if (parts.length < 2) return false;
  return parts.every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

function symbolicTarget(line: string): string | undefined {
  const target = SYMBOLIC_HEAD.exec(line)?.[1];
  return target !== undefined && isRefName(target) ? target : undefined;
}

/** `ref: refs/heads/<branch>` → the branch; a bare commit id (detached HEAD) → undefined. */
export function branchFromHead(text: string): string | undefined {
  const first = text.trim().split(/\r?\n/)[0] ?? '';
  const match = /^ref:\s*refs\/heads\/(.+)$/.exec(first);
  const branch = match?.[1]?.trim();
  return branch ? branch : undefined;
}

type Probe = { isDirectory: boolean } | 'absent' | 'unreadable';

/** A path that is simply not there, as opposed to one the process may not look at. */
function isMissing(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Absent is "keep walking"; any other failure is "stop": the nearest repository is unreadable. */
async function probe(fs: GitFs, path: string): Promise<Probe> {
  try {
    return await fs.stat(path);
  } catch (err) {
    return isMissing(err) ? 'absent' : 'unreadable';
  }
}

/**
 * What the walk found. `unreadable` is not the same answer as `absent`: a `.git` that is there and
 * cannot be read means the caller *is* inside a repository, and saying "not inside a git
 * repository" about a permissions problem sends the user looking in the wrong place.
 */
export type GitHeadResult =
  | { kind: 'found'; head: GitHead }
  | { kind: 'absent' }
  | { kind: 'unreadable'; path: string }
  /** Read fine, said nothing usable: a stale worktree marker, a truncated HEAD. */
  | { kind: 'malformed'; path: string };

/**
 * Finds the repository that contains `startDir` without running `git`: walks up to the nearest
 * `.git`, follows a `gitdir:` file (worktrees, submodules) and reads `HEAD`. Never throws.
 */
export async function findGitHead(fs: GitFs, startDir: string): Promise<GitHeadResult> {
  const api = pathApi(startDir);
  let dir = startDir;
  for (;;) {
    const dotGit = api.join(dir, '.git');
    const stat = await probe(fs, dotGit);
    // Walking past an unreadable nested repository would resolve the outer one's branch.
    if (stat === 'unreadable') return { kind: 'unreadable', path: dotGit };
    if (stat !== 'absent') {
      // Past this point the caller is inside a repository, so every remaining failure is one that
      // could not be read rather than one that is not there.
      let gitDir = dotGit;
      if (!stat.isDirectory) {
        let text: string;
        try {
          text = await fs.readFile(dotGit);
        } catch (err) {
          if (isMissing(err)) return { kind: 'malformed', path: dotGit };
          return { kind: 'unreadable', path: dotGit };
        }
        const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(text)?.[1];
        // The read succeeded, so "check the permissions" is the wrong advice: the file is wrong.
        if (!pointer) return { kind: 'malformed', path: dotGit };
        gitDir = api.isAbsolute(pointer) ? api.normalize(pointer) : api.resolve(dir, pointer);
      }
      const headPath = api.join(gitDir, 'HEAD');
      let head: string;
      try {
        head = await fs.readFile(headPath);
      } catch (err) {
        // A `gitdir:` pointing at a directory that is gone is the ordinary stale worktree marker,
        // and a git directory with no HEAD is broken in the same way. Neither is a permissions
        // problem, so neither may be reported as one.
        if (isMissing(err)) return { kind: 'malformed', path: headPath };
        return { kind: 'unreadable', path: headPath };
      }
      // A HEAD is one of the two things git writes: a bare object id, or a symbolic ref to a
      // well-formed target. Anything else is corrupt, and calling it a detached HEAD would describe
      // a state the repository is not in. The target is checked whether or not it names a branch,
      // so `ref: refs/heads/.hidden` cannot slip through on the strength of its prefix.
      const first = head.trim().split(/\r?\n/)[0] ?? '';
      const target = symbolicTarget(first);
      if (target === undefined && !DETACHED_HEAD.test(first)) {
        return { kind: 'malformed', path: headPath };
      }
      const branch = target === undefined ? undefined : branchFromHead(`ref: ${target}`);
      return { kind: 'found', head: branch === undefined ? { gitDir } : { gitDir, branch } };
    }
    const parent = api.dirname(dir);
    if (parent === dir) return { kind: 'absent' };
    dir = parent;
  }
}

/** The head, or `undefined` when there is no repository or it could not be read. */
export async function readGitHead(fs: GitFs, startDir: string): Promise<GitHead | undefined> {
  const found = await findGitHead(fs, startDir);
  return found.kind === 'found' ? found.head : undefined;
}

export async function readGitBranch(fs: GitFs, startDir: string): Promise<string | undefined> {
  return (await readGitHead(fs, startDir))?.branch;
}
