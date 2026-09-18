import type { Command } from 'commander';
import { LassiError, displayPath, pathApi, resolvePath, type LassiFs } from '@wonna/lassi-core';
import type { CliDeps } from '../../deps.js';
import { guardWrite } from '../../guard-write.js';
import { dryRunData } from '../../output/dry-run.js';
import { renderTable } from '../../output/table.js';
import { attach, type Session } from '../../run-command.js';
import { GENERATED } from './generated.js';
import { generatedHeader, planInstall } from './plan.js';

const SKILL_NAMES = ['jira', 'confluence'] as const;
type SkillName = (typeof SKILL_NAMES)[number];

async function readTree(fs: LassiFs, root: string, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch {
    return out;
  }
  for (const name of names) {
    const path = pathApi(root).join(root, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = await fs.stat(path);
    if (stat.isDirectory) Object.assign(out, await readTree(fs, path, rel));
    else out[rel] = await fs.readFile(path);
  }
  return out;
}

interface InstallOptions {
  global?: boolean;
  project?: string;
  force?: boolean;
  only?: string;
  json?: boolean;
  dryRun?: boolean;
}

export function registerSkills(program: Command, deps: CliDeps, session: Session): void {
  const skills = program.command('skills').description('install the example agent skills');
  const install = skills
    .command('install')
    .description('copy the jira/confluence skills and render their generated references')
    .option('--global', 'install into ~/.agents/skills/ (the default; not with --project)')
    .option('--project <dir>', 'install into <dir>/.github/skills/ instead')
    .option('--force', 'overwrite hand-written files that differ')
    .option('--only <name>', 'only one skill: jira | confluence');
  attach<[], InstallOptions>(install, deps, session, {
    kind: 'write',
    async run(ctx, _args, opts) {
      if (opts.only !== undefined && !SKILL_NAMES.includes(opts.only as SkillName)) {
        throw new LassiError('usage', `--only must be one of ${SKILL_NAMES.join(', ')}`);
      }
      if (opts.global && opts.project !== undefined) {
        throw new LassiError('usage', '--global and --project are mutually exclusive');
      }
      const names = SKILL_NAMES.filter((n) => opts.only === undefined || n === opts.only);
      const destRoot = opts.project
        // Against the injected cwd, not the process's: a relative --project resolved against
        // process.cwd() and the preview named a path outside the workspace.
        ? resolvePath(deps.cwd, pathApi(opts.project).join(opts.project, '.github', 'skills'))
        : pathApi(deps.homedir).join(deps.homedir, '.agents', 'skills');
      const destApi = pathApi(destRoot);
      const srcRoot = pathApi(deps.repoRoot).join(deps.repoRoot, 'skills');

      const srcFiles: Record<string, string> = {};
      const destFiles: Record<string, string | undefined> = {};
      for (const name of names) {
        const files = await readTree(deps.fs, pathApi(srcRoot).join(srcRoot, name));
        for (const [rel, content] of Object.entries(files)) srcFiles[`${name}/${rel}`] = content;
      }
      if (Object.keys(srcFiles).length === 0) {
        throw new LassiError('usage', `no skills found under ${srcRoot}`);
      }
      const generated = new Set(Object.keys(GENERATED).filter((rel) => names.some((n) => rel.startsWith(`${n}/`))));
      for (const rel of [...Object.keys(srcFiles), ...generated]) {
        const path = destApi.join(destRoot, ...rel.split('/'));
        destFiles[rel] = (await deps.fs.exists(path)) ? await deps.fs.readFile(path) : undefined;
      }
      const plan = planInstall({ srcFiles, destFiles, generated });
      if (plan.conflicts.length > 0 && !opts.force) {
        throw new LassiError(
          'validation',
          `refusing to overwrite modified files under ${destRoot}: ${plan.conflicts.join(', ')}`,
          { hint: 'pass --force to overwrite (the list above is what would change)' }
        );
      }

      const table = renderTable(
        [
          { key: 'file', header: 'File' },
          { key: 'action', header: 'Action' },
        ],
        plan.entries.map((e) => ({ file: e.rel, action: e.action }))
      );
      const preview = {
        method: 'PUT' as const,
        path: displayPath(deps.cwd, destRoot),
        payloadLabel: 'files',
        payload: table,
      };
      if (guardWrite(ctx, preview) === 'dry-run') {
        // The shape every other write's --dry-run --json returns, plus what is specific to this one.
        return { data: { ...dryRunData(preview), destRoot, plan } };
      }

      for (const entry of plan.entries) {
        const path = destApi.join(destRoot, ...entry.rel.split('/'));
        if (entry.action === 'create' || entry.action === 'overwrite') {
          await deps.fs.writeFile(path, srcFiles[entry.rel] as string);
        } else if (entry.action === 'generate') {
          const header = generatedHeader(deps.buildInfo, deps.now());
          let body: string;
          try {
            body = await (GENERATED[entry.rel] as (typeof GENERATED)[string])(ctx, program);
          } catch (err) {
            // Instance-specific references need a configured product; keep the install usable and say so.
            const reason = (err as Error).message;
            ctx.logger.warn(`${entry.rel}: not generated (${reason}); run \`lassi skills install --force\` after configuring`);
            body = `<!-- not generated: ${reason.replace(/-->/g, '--')} -->\n\nRun \`lassi skills install --force\` once \`lassi doctor\` passes to render this reference.\n`;
          }
          await deps.fs.writeFile(path, `${header}\n${body}`);
        }
      }
      return {
        markdown: `installed into ${destRoot}\n\n${table}`,
        data: { destRoot, plan },
        axi: { data: { destRoot, files: plan.entries } },
      };
    },
  });
}
