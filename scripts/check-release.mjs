import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectArtifact } from './releasing/artifact.mjs';
import { assertPublishContext, assertPublicSource } from './releasing/policy.mjs';
import { checkVersions, readVersionFiles } from './release-version.mjs';

const [file, expectedHash, mode, ...extra] = process.argv.slice(2);
assert.ok(
  file &&
    /^[a-f0-9]{128}$/.test(expectedHash ?? '') &&
    (mode === undefined || mode === '--publish') &&
    extra.length === 0,
  'Usage: npm run release:check -- TARBALL SHA512 [--publish]'
);
const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const artifact = inspectArtifact(file);
const version = checkVersions(readVersionFiles(root));
const commit = git('rev-parse', 'HEAD');
assert.equal(artifact.sha512, expectedHash, 'The artifact differs from the tested tarball');
assert.equal(artifact.manifest.version, version, 'Package version differs from source');
assert.equal(artifact.buildInfo.commit, commit, 'Package source differs from checkout');
if (mode === '--publish') {
  assertPublishContext({
    env: process.env,
    version,
    commit,
    buildInfo: artifact.buildInfo,
    clean: git('status', '--porcelain') === '',
    taggedCommit: git('rev-parse', `refs/tags/v${version}^{commit}`),
  });
  assert.ok(
    !artifact.read('README.md').includes('npm installation is forthcoming'),
    'Update the README publication notice before tagging a release'
  );
  await assertPublicSource({ version, commit }, fetch);
  console.log(
    `Public source verified: https://github.com/wonna-fi/lassi/tree/v${version} (${commit})`
  );
}
console.log(`Verified ${artifact.manifest.name}@${version}; SHA-512 ${artifact.sha512}`);
