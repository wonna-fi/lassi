import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { assertAlphaVersion } from '../release-version.mjs';

export function inspectArtifact(file) {
  const tarball = resolve(file);
  const bytes = readFileSync(tarball);
  // A relative archive name also works with tar implementations that treat Windows drive letters as hosts.
  const tar = (args) => execFileSync('tar', args, { cwd: dirname(tarball), encoding: 'utf8' });
  const list = (flag) =>
    tar([flag, basename(tarball)])
      .trim()
      .split(/\r?\n/);
  const files = list('-tzf');
  assert.ok(
    list('-tvzf').every((line) => line.startsWith('-')),
    'The package must contain only regular files'
  );
  assert.equal(new Set(files).size, files.length, 'Duplicate archive entries');
  assert.ok(
    files.every((name) =>
      /^package\/(?:package\.json|README\.md|LICENSE|build-info\.json|bin\/lassi\.js|dist\/main\.js|skills\/(?:jira|confluence|jira-review)\/(?:SKILL\.md|references\/[a-z-]+\.md))$/.test(
        name
      )
    ),
    'Unexpected package contents'
  );
  for (const required of [
    'package.json',
    'README.md',
    'LICENSE',
    'build-info.json',
    'bin/lassi.js',
    'dist/main.js',
    'skills/jira/SKILL.md',
    'skills/confluence/SKILL.md',
  ]) {
    assert.ok(files.includes(`package/${required}`), `Missing package asset ${required}`);
  }
  const read = (name) => tar(['-xOf', basename(tarball), `package/${name}`]);
  const manifest = JSON.parse(read('package.json'));
  const buildInfo = JSON.parse(read('build-info.json'));
  assert.equal(manifest.name, '@wonna/lassi');
  assertAlphaVersion(manifest.version);
  assert.notEqual(manifest.private, true);
  assert.deepEqual(manifest.bin, { lassi: './bin/lassi.js' });
  assert.deepEqual(manifest.publishConfig, {
    access: 'public',
    tag: 'alpha',
    registry: 'https://registry.npmjs.org/',
  });
  assert.equal(manifest.repository?.url, 'git+https://github.com/wonna-fi/lassi.git');
  assert.equal(
    manifest.scripts,
    undefined,
    'The standalone package must not run lifecycle scripts'
  );
  assert.ok(Object.keys(manifest.dependencies ?? {}).every((name) => !name.startsWith('@wonna/')));
  assert.equal(buildInfo.version, manifest.version);
  assert.equal(buildInfo.distribution, true);
  return {
    tarball,
    files,
    manifest,
    buildInfo,
    read,
    sha512: createHash('sha512').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
}
