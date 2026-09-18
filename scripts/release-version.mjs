import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const versionPaths = [
  'package.json',
  ...['core', 'jira', 'confluence', 'search', 'cli'].map((name) => `packages/${name}/package.json`),
];

export function assertAlphaVersion(version) {
  assert.match(
    version ?? '',
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.(0|[1-9]\d*)$/,
    'Use an explicit alpha version, for example 0.1.0-alpha.2'
  );
  return version;
}

export function readVersionFiles(root) {
  return Object.fromEntries(
    [...versionPaths, 'package-lock.json'].map((file) => [
      file,
      JSON.parse(readFileSync(join(root, file), 'utf8')),
    ])
  );
}

export function checkVersions(files) {
  const version = assertAlphaVersion(files['package.json'].version);
  const lock = files['package-lock.json'];
  assert.equal(lock.version, version, 'Root lockfile version differs');
  for (const file of versionPaths) {
    const pkg = files[file];
    assert.equal(pkg.version, version, `${file} version differs`);
    assert.equal(pkg.private, true, `${file} must remain private`);
    const key = file === 'package.json' ? '' : file.slice(0, -'/package.json'.length);
    assert.equal(lock.packages[key]?.version, version, `Lockfile version differs for ${file}`);
  }
  return version;
}

export function planVersion(files, version) {
  checkVersions(files);
  assertAlphaVersion(version);
  const next = structuredClone(files);
  for (const file of versionPaths) {
    next[file].version = version;
    const key = file === 'package.json' ? '' : file.slice(0, -'/package.json'.length);
    next['package-lock.json'].packages[key].version = version;
  }
  next['package-lock.json'].version = version;
  return next;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const [arg, ...extra] = process.argv.slice(2);
  assert.equal(extra.length, 0, 'Usage: npm run release:version -- VERSION or --check');
  const files = readVersionFiles(root);
  if (arg === '--check') {
    console.log(`Versions agree: ${checkVersions(files)}`);
  } else {
    const next = planVersion(files, arg);
    for (const [file, data] of Object.entries(next))
      writeFileSync(join(root, file), JSON.stringify(data, null, 2) + '\n');
    console.log(
      `Set all workspace and lockfile versions to ${arg}. Review and commit these changes before releasing.`
    );
  }
}
