import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectArtifact } from './releasing/artifact.mjs';
import { checkVersions, readVersionFiles } from './release-version.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const version = checkVersions(readVersionFiles(root));
const artifact = inspectArtifact(join(root, 'artifacts', `wonna-lassi-${version}.tgz`));
assert.ok(process.env.npm_execpath, 'Run through npm run release:rehearse');
const npm = (...args) =>
  execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd: root,
    stdio: 'inherit',
  });
npm('run', 'test:package', '--', artifact.tarball);
npm('run', 'release:check', '--', artifact.tarball, artifact.sha512);
npm(
  'publish',
  artifact.tarball,
  '--access',
  'public',
  '--tag',
  'alpha',
  '--registry',
  'https://registry.npmjs.org/',
  '--ignore-scripts',
  '--dry-run'
);
assert.equal(
  inspectArtifact(artifact.tarball).sha512,
  artifact.sha512,
  'Rehearsal modified the tarball'
);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `tarball=${basename(artifact.tarball)}\nsha512=${artifact.sha512}\nversion=${version}\n`
  );
}
console.log(
  'Release rehearsal passed. No package was published. Registry authentication remains unverified.'
);
