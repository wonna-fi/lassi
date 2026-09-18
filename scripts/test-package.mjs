import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspectArtifact } from './releasing/artifact.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli, 'Run this verifier through npm run test:package');
const temp = mkdtempSync(join(tmpdir(), 'lassi-package-'));
const installation = join(temp, 'installation');
const working = join(temp, 'work');
const home = join(temp, 'home');
for (const dir of [installation, working, home]) mkdirSync(dir, { recursive: true });
const jsonFile = (path, data) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
};
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const runNpm = (args, cwd) =>
  execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8' });
assert.ok(process.argv.length <= 3, 'Usage: npm run test:package -- [TARBALL]');
let tarball = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!tarball) {
  const packed = JSON.parse(
    runNpm(['pack', './release', '--pack-destination', temp, '--json', '--ignore-scripts'], root)
  )[0];
  tarball = join(temp, packed.filename);
}
const artifact = inspectArtifact(tarball);
const manifest = artifact.manifest;
assert.equal(manifest.version, readJson(join(root, 'packages/cli/package.json')).version);
const dependency = `file:${tarball.replaceAll('\\', '/')}`;
const project = {
  name: 'lassi-package-verification',
  private: true,
  dependencies: { '@wonna/lassi': dependency },
};
jsonFile(join(installation, 'package.json'), project);
// Reuse the already downloaded resolutions, not registry metadata. npm ci caches tarballs but
// need not cache the package metadata that a fresh npm install would otherwise request.
const sourceLock = readJson(join(root, 'package-lock.json'));
const packages = Object.fromEntries(
  Object.entries(sourceLock.packages).filter(
    ([path]) => path.startsWith('node_modules/') && !path.startsWith('node_modules/@wonna/lassi')
  )
);
packages[''] = project;
packages['node_modules/@wonna/lassi'] = {
  ...manifest,
  resolved: dependency,
  integrity: artifact.integrity,
};
jsonFile(join(installation, 'package-lock.json'), {
  name: project.name,
  lockfileVersion: 3,
  requires: true,
  packages,
});
runNpm(
  ['ci', '--offline', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'],
  installation
);
assert.deepEqual(readdirSync(join(installation, 'node_modules/@wonna')), ['lassi']);
const installed = join(installation, 'node_modules', '@wonna', 'lassi');
const fixture = pathToFileURL(join(root, 'scripts/package-fixture.mjs')).href;
const requestLog = join(temp, 'requests.jsonl');
writeFileSync(requestLog, '');
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(?:PATH|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR)$/i.test(key)
  )
);
Object.assign(env, { LASSI_TEST_HOME: home, LASSI_TEST_REQUESTS: requestLog });
function cli(args, overrides = {}, status = 0) {
  const result = spawnSync(
    process.execPath,
    ['--import', fixture, join(installed, 'bin/lassi.js'), ...args],
    {
      cwd: working,
      env: { ...env, ...overrides },
      encoding: 'utf8',
      timeout: 30_000,
    }
  );
  assert.equal(result.status, status, `${args.join(' ')}: ${result.error ?? result.stderr}`);
  return result.stdout;
}
assert.ok(cli(['--version']).startsWith(`lassi ${manifest.version} (`));
assert.match(cli(['help', '--all']), /lassi jira issue get/);
assert.ok(readFileSync(join(installed, 'README.md'), 'utf8').includes('not production-ready'));

// Configuration, exports and indexes share the documented home-directory defaults.
jsonFile(join(home, '.lassi.json'), {
  jira: { url: 'https://jira.example.internal' },
  embeddings: {
    url: 'https://embeddings.example.internal/v1',
    model: 'fixture-model',
    minScore: 0,
  },
});
for (const dir of [
  join(home, '.lassi/export/jira'),
  join(home, '.lassi/index'),
  join(working, '.lassi/cache'),
])
  mkdirSync(dir, { recursive: true });
Object.assign(env, {
  LASSI_JIRA_TOKEN: 'fixture-jira-token',
  LASSI_EMBEDDINGS_API_KEY: 'fixture-embedding-key',
});
const config = cli(['config', 'show', '--json']);
assert.ok(!config.includes('fixture-jira-token') && !config.includes('fixture-embedding-key'));
const issue = JSON.parse(cli(['jira', 'issue', 'get', 'PROJ-1', '--all', '--json']));
assert.equal(issue.commentCoverage.complete, true);
assert.match(issue.body, /Retry a failed deployment/);
const attachments = JSON.parse(cli(['jira', 'attach', 'get', 'PROJ-1', '--json']));
assert.equal(attachments.saved, 1);
assert.equal(readFileSync(join(working, attachments.files[0].path), 'utf8'), 'demo');
cli(['jira', 'issue', 'export', 'project = PROJ', '--comments']);
const exportPath = join(home, '.lassi/export/jira/PROJ-1.md');
assert.match(readFileSync(exportPath, 'utf8'), /lassi:/);
cli(['search', 'index']);
const index = join(home, '.lassi/index/default');
const hash = () =>
  createHash('sha256')
    .update(readFileSync(join(index, 'vectors.f32')))
    .digest('hex');
const vectorsBefore = hash();
assert.match(cli(['search', 'query', 'deployment retry']), /PROJ-1/);
assert.equal(hash(), vectorsBefore, 'Querying must not rebuild or move the index');
const countEmbeddings = () =>
  readFileSync(requestLog, 'utf8')
    .split('\n')
    .filter((line) => line.includes('/v1/embeddings')).length;
const beforeIncremental = countEmbeddings();
cli(['search', 'index']);
assert.equal(countEmbeddings(), beforeIncremental, 'Unchanged exports must not be re-embedded');
const lock = join(index, '.lassi-write.lock');
writeFileSync(lock, '{}');
cli(['search', 'index'], {}, 6);
assert.equal(countEmbeddings(), beforeIncremental, 'A storage lock must block embedding requests');

const beforeWrite = readFileSync(requestLog, 'utf8');
cli(['jira', 'comment', 'add', 'PROJ-1', '--body', 'blocked'], { LASSI_READ_ONLY: '1' }, 7);
assert.equal(
  readFileSync(requestLog, 'utf8'),
  beforeWrite,
  'Read-only must block before any request'
);
cli(['skills', 'install', '--only', 'jira']);
const skillDir = join(home, '.agents/skills/jira');
assert.match(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), /lassi jira/);
assert.match(
  readFileSync(join(skillDir, 'references/commands.md'), 'utf8'),
  /lassi jira issue get/
);
const skill = join(skillDir, 'SKILL.md');
writeFileSync(skill, readFileSync(skill, 'utf8') + '\nLocal customization.\n');
cli(['skills', 'install', '--only', 'jira'], {}, 5);
assert.match(readFileSync(skill, 'utf8'), /Local customization/);
assert.ok(readdirSync(home).includes('.lassi'), 'Shared storage belongs in the home directory');
console.log(
  `Installed package passed: issue/comments, attachments, export, index/query, incremental reuse, locks, read-only and skills. ${artifact.files.length} packed files.`
);
assert.equal(
  inspectArtifact(tarball).sha512,
  artifact.sha512,
  'Package verification modified the tarball'
);
console.log(`Verification artifacts: ${temp}`);
