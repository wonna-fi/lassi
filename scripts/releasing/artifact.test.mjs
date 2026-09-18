import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectArtifact } from './artifact.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(extra = {}, mutate = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lassi-release-test-'));
  dirs.push(dir);
  const manifest = {
    name: '@wonna/lassi',
    version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
    bin: { lassi: './bin/lassi.js' },
    publishConfig: { access: 'public', tag: 'alpha', registry: 'https://registry.npmjs.org/' },
    repository: { url: 'git+https://github.com/wonna-fi/lassi.git' },
    dependencies: {},
  };
  mutate(manifest);
  const files = {
    'package/package.json': JSON.stringify(manifest),
    'package/build-info.json': JSON.stringify({ version: manifest.version, distribution: true }),
    'package/README.md': 'Example package',
    'package/LICENSE': 'MIT',
    'package/bin/lassi.js': '',
    'package/dist/main.js': '',
    'package/skills/jira/SKILL.md': '',
    'package/skills/confluence/SKILL.md': '',
    ...extra,
  };
  for (const [name, bytes] of Object.entries(files)) {
    const file = join(dir, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  const tarball = join(dir, 'candidate.tgz');
  execFileSync('tar', ['-czf', 'candidate.tgz', ...Object.keys(files)], { cwd: dir });
  return tarball;
}

describe('release artifacts', () => {
  it('reads metadata and hashes from the supplied tarball', () => {
    const tarball = fixture();
    const before = readFileSync(tarball);
    const artifact = inspectArtifact(tarball);
    expect(artifact.files).toHaveLength(8);
    expect(artifact.sha512).toBe(createHash('sha512').update(before).digest('hex'));
    expect(artifact.integrity).toBe(
      `sha512-${createHash('sha512').update(before).digest('base64')}`
    );
    expect(readFileSync(tarball)).toEqual(before);
  });
  it('rejects unexpected files even if other metadata is correct', () => {
    expect(() => inspectArtifact(fixture({ 'package/.env': 'EXAMPLE=value' }))).toThrow(
      /Unexpected package contents/
    );
  });
  it('rejects the wrong registry, source repository, or lifecycle scripts', () => {
    expect(() =>
      inspectArtifact(
        fixture({}, (m) => {
          m.publishConfig.registry = 'https://registry.example.internal/';
        })
      )
    ).toThrow();
    expect(() =>
      inspectArtifact(
        fixture({}, (m) => {
          m.repository.url = 'git+https://github.com/example/lassi.git';
        })
      )
    ).toThrow();
    expect(() =>
      inspectArtifact(
        fixture({}, (m) => {
          m.scripts = { prepublishOnly: 'unexpected' };
        })
      )
    ).toThrow(/lifecycle scripts/);
  });
  it('rejects an artifact whose checksum differs before attempting publication checks', () => {
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/check-release.mjs'), fixture(), '0'.repeat(128), '--publish'],
      { encoding: 'utf8' }
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('differs from the tested tarball');
  });
});
