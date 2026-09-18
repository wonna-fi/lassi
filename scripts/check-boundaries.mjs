// Dependency directions:
//   core       -> nothing internal
//   jira       -> core only
//   confluence -> core only
//   search     -> core only
//   cli        -> core, jira, confluence, search
//   nothing    -> cli
// Checks both package.json dependencies and actual import specifiers in src/**/*.ts.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = '@wonna/lassi-';
const ALLOWED = {
  core: new Set(),
  jira: new Set(['core']),
  confluence: new Set(['core']),
  search: new Set(['core']),
  cli: new Set(['core', 'jira', 'confluence', 'search']),
};

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const problems = [];
for (const [pkg, allowed] of Object.entries(ALLOWED)) {
  const pkgDir = join(root, 'packages', pkg);
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
    if (
      dep === '@wonna/lassi' ||
      (dep.startsWith(SCOPE) && !allowed.has(dep.slice(SCOPE.length)))
    ) {
      problems.push(`${pkg}/package.json depends on ${dep}`);
    }
  }
  let files = [];
  try {
    files = walk(join(pkgDir, 'src'));
  } catch {
    // package has no src yet
  }
  const importRe =
    /from\s+['"](@wonna\/lassi(?:-[a-z]+)?)(?:\/[^'"]*)?['"]|import\(\s*['"](@wonna\/lassi(?:-[a-z]+)?)/g;
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(importRe)) {
      const spec = m[1] ?? m[2];
      const target = spec === '@wonna/lassi' ? 'cli' : spec.slice(SCOPE.length);
      if (target !== pkg && !allowed.has(target)) {
        problems.push(`${relative(root, file)} imports ${spec}`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error('dependency boundary violations:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('boundaries: ok');
