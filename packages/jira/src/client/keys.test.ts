import { describe, expect, it } from 'vitest';
import { compileBranchPattern, issueKeyFromBranch } from './keys.js';

describe('issueKeyFromBranch', () => {
  it('finds the first key in a branch name, whatever its case', () => {
    expect(issueKeyFromBranch('feature/PROJ-123-login')).toBe('PROJ-123');
    expect(issueKeyFromBranch('proj-7')).toBe('PROJ-7');
    expect(issueKeyFromBranch('jsmith/dev-12-and-proj-9')).toBe('DEV-12');
  });

  it('prefers the default project when the branch names several keys', () => {
    expect(issueKeyFromBranch('release/v2-1/DEV-7-then-PROJ-9', { project: 'PROJ' })).toBe(
      'PROJ-9'
    );
    expect(issueKeyFromBranch('release/v2-1', { project: 'PROJ' })).toBe('V2-1');
    expect(issueKeyFromBranch('fix/PROJ-3', { project: 'DEV' })).toBe('PROJ-3');
    expect(issueKeyFromBranch('feature_PROJ-9_fix', { project: 'PROJ' })).toBe('PROJ-9');
    expect(issueKeyFromBranch('xPROJ-9', { project: 'PROJ' })).toBe('XPROJ-9');
  });

  it('uses the capture group of a configured pattern', () => {
    const pattern = String.raw`^(?:feature|fix)/([a-z]+-\d+)`;
    expect(issueKeyFromBranch('fix/proj-42-x', { pattern })).toBe('PROJ-42');
    expect(issueKeyFromBranch('main', { pattern })).toBeUndefined();
    expect(issueKeyFromBranch('feature/PROJ-1', { pattern: '^feature/(.*)$' })).toBe('PROJ-1');
    expect(issueKeyFromBranch('feature/not a key', { pattern: '^feature/(.*)$' })).toBeUndefined();
  });

  it('is undefined for branches without a key', () => {
    expect(issueKeyFromBranch('main')).toBeUndefined();
    expect(issueKeyFromBranch('feature/login-page')).toBeUndefined();
    // Anything shaped like a key is one; Jira answers 404 when it is not.
    expect(issueKeyFromBranch('feature/login-500')).toBe('LOGIN-500');
  });
});

describe('compileBranchPattern', () => {
  it('rejects a pattern that does not compile or has no capture group', () => {
    expect(() => compileBranchPattern('(')).toThrow(/not a valid regular expression/);
    expect(() => compileBranchPattern('^feature/[a-z]+-\\d+')).toThrow(/capture group/);
    expect(compileBranchPattern('^feature/([a-z]+-\\d+)').flags).toBe('i');
  });
});
