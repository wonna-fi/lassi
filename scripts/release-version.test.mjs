import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertAlphaVersion,
  checkVersions,
  planVersion,
  versionPaths,
} from './release-version.mjs';

function fixture() {
  const version = '0.1.0-alpha.1';
  const files = Object.fromEntries(
    versionPaths.map((file) => [
      file,
      { version, private: true, dependencies: { example: '^2.0.0' } },
    ])
  );
  files['package-lock.json'] = {
    version,
    lockfileVersion: 3,
    packages: {
      ...Object.fromEntries(
        versionPaths.map((file) => [
          file === 'package.json' ? '' : file.slice(0, -'/package.json'.length),
          { version },
        ])
      ),
      'node_modules/example': { version: '2.3.4', integrity: 'fixture-integrity' },
    },
  };
  return files;
}

describe('release versions', () => {
  it('updates all owned versions without changing dependency resolutions or the input', () => {
    const before = fixture();
    const next = planVersion(before, '0.2.0-alpha.3');
    expect(checkVersions(next)).toBe('0.2.0-alpha.3');
    expect(checkVersions(before)).toBe('0.1.0-alpha.1');
    expect(next['package-lock.json'].packages['node_modules/example']).toEqual(
      before['package-lock.json'].packages['node_modules/example']
    );
    expect(next['packages/cli/package.json'].dependencies).toEqual({ example: '^2.0.0' });
  });

  it.each([
    'latest',
    '1.0.0',
    'v0.1.0-alpha.1',
    '0.1.0-beta.1',
    '0.1.0-alpha.01',
    '../escape',
    undefined,
  ])('rejects unsupported version %s', (version) => {
    expect(() => assertAlphaVersion(version)).toThrow(/explicit alpha version/);
  });

  it('refuses to update inconsistent manifests or lockfile entries', () => {
    for (const file of versionPaths) {
      const files = fixture();
      files[file].version = '0.1.0-alpha.2';
      expect(() => planVersion(files, '0.1.0-alpha.3')).toThrow(/version differs/);
    }
    const files = fixture();
    delete files['package-lock.json'].packages['packages/search'];
    expect(() => checkVersions(files)).toThrow(/Lockfile version differs/);
  });

  it('keeps workspace packages protected from accidental publication', () => {
    const files = fixture();
    files['packages/cli/package.json'].private = false;
    expect(() => checkVersions(files)).toThrow(/must remain private/);
  });
});

it('executes version checks and updates through the CLI entry point', () => {
  const root = mkdtempSync(join(tmpdir(), 'lassi-version-'));
  try {
    const script = join(root, 'scripts/release-version.mjs');
    mkdirSync(dirname(script), { recursive: true });
    copyFileSync(new URL('./release-version.mjs', import.meta.url), script);
    for (const [file, value] of Object.entries(fixture())) {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(value));
    }
    const run = (arg) => execFileSync(process.execPath, [script, arg], { encoding: 'utf8' });
    expect(run('--check')).toContain('Versions agree: 0.1.0-alpha.1');
    expect(run('0.2.0-alpha.3')).toContain('Set all workspace and lockfile versions');
    expect(run('--check')).toContain('Versions agree: 0.2.0-alpha.3');
    const manifest = join(root, 'packages/cli/package.json');
    const data = JSON.parse(readFileSync(manifest, 'utf8'));
    writeFileSync(manifest, JSON.stringify({ ...data, version: '0.3.0-alpha.1' }));
    const failed = spawnSync(process.execPath, [script, '--check'], { encoding: 'utf8' });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('version differs');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
