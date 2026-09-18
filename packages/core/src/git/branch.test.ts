import { describe, expect, it } from 'vitest';
import { memFs } from '../testing/mem-fs.js';
import { branchFromHead, findGitHead, readGitBranch, readGitHead } from './branch.js';

const SHA = 'a'.repeat(40);

describe('branchFromHead', () => {
  it('extracts the branch from a symbolic ref, tolerating CRLF and nested names', () => {
    expect(branchFromHead('ref: refs/heads/main\n')).toBe('main');
    expect(branchFromHead('ref: refs/heads/feature/PROJ-123-login\r\n')).toBe(
      'feature/PROJ-123-login'
    );
  });

  it('is undefined for a detached HEAD or garbage', () => {
    expect(branchFromHead(`${SHA}\n`)).toBeUndefined();
    expect(branchFromHead('ref: refs/tags/v1')).toBeUndefined();
    expect(branchFromHead('')).toBeUndefined();
  });
});

describe('readGitHead', () => {
  it('walks up to the nearest .git directory and reads HEAD', async () => {
    const fs = memFs({ '/home/u/proj/.git/HEAD': 'ref: refs/heads/feature/PROJ-123-login\n' });
    expect(await readGitBranch(fs, '/home/u/proj/packages/x')).toBe('feature/PROJ-123-login');
    expect(await readGitHead(fs, '/home/u/proj')).toEqual({
      gitDir: '/home/u/proj/.git',
      branch: 'feature/PROJ-123-login',
    });
  });

  it('follows an absolute gitdir: file (worktree)', async () => {
    const fs = memFs({
      '/home/u/wt/.git': 'gitdir: /home/u/proj/.git/worktrees/wt\n',
      '/home/u/proj/.git/worktrees/wt/HEAD': 'ref: refs/heads/fix/DEV-7\n',
      '/home/u/proj/.git/HEAD': 'ref: refs/heads/main\n',
    });
    expect(await readGitHead(fs, '/home/u/wt/src')).toEqual({
      gitDir: '/home/u/proj/.git/worktrees/wt',
      branch: 'fix/DEV-7',
    });
  });

  it('resolves a relative gitdir: against the directory holding the file (submodule)', async () => {
    const fs = memFs({
      '/home/u/proj/sub/.git': 'gitdir: ../.git/modules/sub\n',
      '/home/u/proj/.git/modules/sub/HEAD': 'ref: refs/heads/sub-branch\n',
      '/home/u/proj/.git/HEAD': 'ref: refs/heads/main\n',
    });
    expect(await readGitBranch(fs, '/home/u/proj/sub')).toBe('sub-branch');
  });

  it('reports a detached HEAD as a repository without a branch', async () => {
    const fs = memFs({ '/home/u/proj/.git/HEAD': `${SHA}\n` });
    expect(await readGitHead(fs, '/home/u/proj')).toEqual({ gitDir: '/home/u/proj/.git' });
    expect(await readGitBranch(fs, '/home/u/proj')).toBeUndefined();
  });

  it('is undefined outside a repository, for a gitdir file without a target, or a missing HEAD', async () => {
    expect(
      await readGitHead(memFs({ '/home/u/proj/README.md': '' }), '/home/u/proj')
    ).toBeUndefined();
    expect(
      await readGitHead(memFs({ '/home/u/proj/.git': 'nonsense\n' }), '/home/u/proj')
    ).toBeUndefined();
    expect(
      await readGitHead(memFs({ '/home/u/proj/.git': 'gitdir: /nowhere\n' }), '/home/u/proj')
    ).toBeUndefined();
    // A `.git` file that reads fine and says nothing usable is not a read failure, so the caller
    // must not be told to check permissions it already has.
    expect(await findGitHead(memFs({ '/home/u/proj/.git': 'nonsense\n' }), '/home/u/proj')).toEqual(
      {
        kind: 'malformed',
        path: '/home/u/proj/.git',
      }
    );
    expect(
      await findGitHead(memFs({ '/home/u/proj/.git/HEAD': '' }), '/home/u/proj')
    ).toMatchObject({ kind: 'malformed' });
    // Corruption that is not empty still reaches the caller as data. Reporting it as a detached
    // HEAD would describe a state the repository is not in; git rejects it outright.
    expect(
      await findGitHead(memFs({ '/home/u/proj/.git/HEAD': 'nonsense\n' }), '/home/u/proj')
    ).toEqual({ kind: 'malformed', path: '/home/u/proj/.git/HEAD' });
    // A symbolic ref that is not a branch is valid metadata, just not a branch name.
    // Checked against `git check-ref-format` 2.53 rather than against a guess at its rules.
    for (const target of ['refs/tags/v1', 'refs/remotes/origin/main', 'refs/heads']) {
      expect(
        await findGitHead(memFs({ '/home/u/proj/.git/HEAD': `ref: ${target}\n` }), '/home/u/proj')
      ).toEqual({ kind: 'found', head: { gitDir: '/home/u/proj/.git' } });
    }
    // A dot inside a component is fine, and this one does name a branch.
    expect(
      await findGitHead(
        memFs({ '/home/u/proj/.git/HEAD': 'ref: refs/heads/a.b\n' }),
        '/home/u/proj'
      )
    ).toEqual({ kind: 'found', head: { gitDir: '/home/u/proj/.git', branch: 'a.b' } });
    // Symbolic data git would refuse as a HEAD target: not under refs/, a reserved character, a
    // component starting with a dot, or the .lock suffix.
    for (const target of [
      'nonsense',
      'refs/tags/foo.lock',
      'refs/heads/.hidden',
      'refs/heads/a~b',
      'refs/heads/x@{1}',
      'refs/tags/../x',
      'refs/heads/foo.',
      'refs/heads//x',
      '@',
      // `check-ref-format` accepts this as a refname; `symbolic-ref` refuses it as a HEAD target.
      'foo/bar',
    ]) {
      expect(
        await findGitHead(memFs({ '/home/u/proj/.git/HEAD': `ref: ${target}\n` }), '/home/u/proj')
      ).toMatchObject({ kind: 'malformed' });
    }
    // The ordinary stale worktree marker: the pointer parses, and what it points at is gone.
    expect(
      await findGitHead(memFs({ '/home/u/proj/.git': 'gitdir: /nowhere\n' }), '/home/u/proj')
    ).toEqual({ kind: 'malformed', path: '/nowhere/HEAD' });
    // A repository the process may not read still says so, and still stops the walk.
    const base = memFs({ '/home/u/proj/.git/HEAD': 'ref: refs/heads/main\n' });
    const locked = {
      ...base,
      readFile: async (path: string) => {
        if (path.endsWith('/HEAD'))
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return base.readFile(path);
      },
    };
    expect(await findGitHead(locked, '/home/u/proj')).toEqual({
      kind: 'unreadable',
      path: '/home/u/proj/.git/HEAD',
    });
  });

  it('is undefined when the gitdir pointer file itself cannot be read', async () => {
    const base = memFs({ '/home/u/proj/.git': 'gitdir: /elsewhere\n' });
    const fs = {
      ...base,
      readFile: async (path: string) => {
        if (path.endsWith('/.git')) throw new Error('EACCES');
        return base.readFile(path);
      },
    };
    expect(await readGitHead(fs, '/home/u/proj')).toBeUndefined();
  });

  it('stops at an unreadable nested .git instead of resolving the parent repository', async () => {
    const base = memFs({
      '/home/u/.git/HEAD': 'ref: refs/heads/dotfiles\n',
      '/home/u/proj/.git/HEAD': 'ref: refs/heads/main\n',
    });
    const fs = {
      ...base,
      stat: async (path: string) => {
        if (path === '/home/u/proj/.git')
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return base.stat(path);
      },
    };
    expect(await readGitHead(fs, '/home/u/proj/src')).toBeUndefined();
    // The reason survives now: `undefined` alone made a permissions problem indistinguishable from
    // "there is no repository here", and the CLI said the latter.
    expect(await findGitHead(fs, '/home/u/proj/src')).toEqual({
      kind: 'unreadable',
      path: '/home/u/proj/.git',
    });
    expect(await findGitHead(memFs({ '/home/u/proj/README.md': '' }), '/home/u/proj')).toEqual({
      kind: 'absent',
    });
  });

  it('stops at the first .git even when a parent is also a repository', async () => {
    const fs = memFs({
      '/home/u/.git/HEAD': 'ref: refs/heads/dotfiles\n',
      '/home/u/proj/.git/HEAD': 'ref: refs/heads/main\n',
    });
    expect(await readGitBranch(fs, '/home/u/proj/src')).toBe('main');
    expect(await readGitBranch(fs, '/home/u/other')).toBe('dotfiles');
  });
});
