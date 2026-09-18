import type { Command } from 'commander';
import { flatten, toPosix, type SourceInfo } from '@wonna/lassi-core';
import type { CliDeps } from '../deps.js';
import { renderTable } from '../output/table.js';
import { attach, type Session } from '../run-command.js';

const MASKED = new Set(['jira.token', 'confluence.token', 'embeddings.apiKey']);

function tilde(path: string, homedir: string): string {
  const p = toPosix(path);
  const h = toPosix(homedir);
  return p.startsWith(`${h}/`) || p === h ? `~${p.slice(h.length)}` : path;
}

export function sourceLabel(info: SourceInfo, homedir: string): string {
  switch (info.source) {
    case 'default':
      return 'default';
    case 'env':
      return `env (${info.from ?? '?'})`;
    case 'flag':
      return 'flag';
    default:
      return info.from ? tilde(info.from, homedir) : info.source;
  }
}

export function renderValue(key: string, value: unknown): string {
  if (MASKED.has(key)) return '***set***';
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '-';
  return JSON.stringify(value);
}

export function registerConfigShow(program: Command, deps: CliDeps, session: Session): void {
  const config = program.command('config').description('inspect the merged configuration');
  const show = config
    .command('show')
    .description('print every setting with the layer it came from');
  attach<[], { json?: boolean }>(show, deps, session, {
    kind: 'read',
    async run(ctx) {
      const flat = flatten(ctx.config as unknown as Record<string, unknown>);
      const rows = Object.entries(flat).map(([key, value]) => ({
        key,
        value: renderValue(key, value),
        source: sourceLabel(ctx.loaded.sources[key] ?? { source: 'default' }, ctx.deps.homedir),
      }));
      const files = ctx.loaded.files;
      const header = [
        `global config: ${files.global ? tilde(files.global, ctx.deps.homedir) : 'none'}`,
        `workspace config: ${files.workspace ? tilde(files.workspace, ctx.deps.homedir) : 'none'}`,
        '',
      ].join('\n');
      const masked = Object.fromEntries(
        Object.entries(flat).map(([k, v]) => [
          k,
          MASKED.has(k) && v !== undefined ? '***set***' : v,
        ])
      );
      return {
        markdown: `${header}${renderTable(
          [
            { key: 'key', header: 'Key' },
            { key: 'value', header: 'Value' },
            { key: 'source', header: 'Source' },
          ],
          rows
        )}`,
        data: { files, config: masked, sources: ctx.loaded.sources },
        axi: { data: { files, settings: rows } },
      };
    },
  });
}
