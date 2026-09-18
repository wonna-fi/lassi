import { build } from 'esbuild';
import { checkVersions, readVersionFiles } from './release-version.mjs';
import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
checkVersions(readVersionFiles(root));
const destination = join(root, 'release');
const cli = JSON.parse(await readFile(join(root, 'packages/cli/package.json'), 'utf8'));
const dependencies = {};
for (const name of ['core', 'jira', 'confluence', 'search', 'cli']) {
  const pkg = JSON.parse(await readFile(join(root, 'packages', name, 'package.json'), 'utf8'));
  for (const [dependency, version] of Object.entries(pkg.dependencies ?? {})) {
    if (dependency.startsWith('@wonna/lassi') || dependency.startsWith('@types/')) continue;
    if (dependencies[dependency] && dependencies[dependency] !== version) {
      throw new Error(`Conflicting dependency versions for ${dependency}`);
    }
    dependencies[dependency] = version;
  }
}

await rm(destination, { recursive: true, force: true });
await mkdir(join(destination, 'bin'), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['packages/cli/dist/main.js'],
  outfile: join(destination, 'dist/main.js'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: Object.keys(dependencies),
  sourcemap: false,
});
await cp(join(root, 'packages/cli/bin/lassi.js'), join(destination, 'bin/lassi.js'));
await chmod(join(destination, 'bin/lassi.js'), 0o755);
// Copy the selected CLI skill assets into the standalone package.
for (const skill of ['jira', 'confluence', 'jira-review']) {
  await cp(join(root, 'skills', skill), join(destination, 'skills', skill), { recursive: true });
}
for (const file of ['README.md', 'LICENSE']) await cp(join(root, file), join(destination, file));
const info = JSON.parse(await readFile(join(root, 'packages/cli/build-info.json'), 'utf8'));
await writeFile(
  join(destination, 'build-info.json'),
  JSON.stringify({ ...info, distribution: true }, null, 2) + '\n'
);
await writeFile(
  join(destination, 'package.json'),
  JSON.stringify(
    {
      name: '@wonna/lassi',
      version: cli.version,
      description: 'Jira and Confluence Data Center CLI for coding agents (alpha)',
      license: 'MIT',
      type: 'module',
      engines: { node: '>=24' },
      bin: { lassi: './bin/lassi.js' },
      files: ['bin/lassi.js', 'dist/main.js', 'skills', 'build-info.json', 'README.md', 'LICENSE'],
      repository: { type: 'git', url: 'git+https://github.com/wonna-fi/lassi.git' },
      homepage: 'https://github.com/wonna-fi/lassi#readme',
      bugs: { url: 'https://github.com/wonna-fi/lassi/issues' },
      publishConfig: { access: 'public', tag: 'alpha', registry: 'https://registry.npmjs.org/' },
      dependencies: Object.fromEntries(
        Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))
      ),
    },
    null,
    2
  ) + '\n'
);
console.log(`Prepared @wonna/lassi@${cli.version} in release/`);
