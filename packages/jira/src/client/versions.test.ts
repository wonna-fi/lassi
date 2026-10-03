import { describe, expect, it } from 'vitest';
import type { JiraVersion } from './types.js';
import { allowedVersions, fixVersionsUpdate, resolveVersions } from './versions.js';

const VERSIONS: JiraVersion[] = [
  { id: '100', name: '1.0', archived: true, released: true },
  { id: '101', name: '2.0', archived: false, released: true, releaseDate: '2026-08-01' },
  { id: '102', name: '2.1', archived: false, released: false },
];

describe('allowedVersions', () => {
  it('keeps released and unreleased versions and drops archived ones', () => {
    expect(allowedVersions(VERSIONS).map((v) => v.name)).toEqual(['2.0', '2.1']);
  });
});

describe('resolveVersions', () => {
  it('matches names in any case, once each, in the order given', () => {
    expect(resolveVersions(VERSIONS, ['2.1', '2.0', '2.1'], 'PROJ').map((v) => v.id)).toEqual([
      '102',
      '101',
    ]);
  });

  it('refuses an unknown version with not_found and the allowed names', () => {
    expect(() => resolveVersions(VERSIONS, ['2.1', '3.0'], 'PROJ')).toThrow(
      expect.objectContaining({
        code: 'not_found',
        message: 'no version "3.0" in PROJ; allowed: 2.0, 2.1',
        hint: 'run `lassi jira project version list PROJ`',
      })
    );
  });

  it('refuses an archived version with validation', () => {
    expect(() => resolveVersions(VERSIONS, ['1.0'], 'PROJ')).toThrow(
      expect.objectContaining({
        code: 'validation',
        message: 'version "1.0" in PROJ is archived; allowed: 2.0, 2.1',
      })
    );
  });
});

describe('fixVersionsUpdate', () => {
  it('replaces the list with set and adds to it with add, by id', () => {
    const picked = [{ id: '101' }, { id: '102' }];
    expect(fixVersionsUpdate('set', picked)).toEqual({
      fields: { fixVersions: [{ id: '101' }, { id: '102' }] },
    });
    expect(fixVersionsUpdate('add', picked)).toEqual({
      update: { fixVersions: [{ add: { id: '101' } }, { add: { id: '102' } }] },
    });
  });
});
