import type { Command } from 'commander';
import type { Context } from '../../context.js';
import { renderCommandTree } from '../../help/markdown.js';

export type Generator = (ctx: Context, program: Command) => Promise<string>;

/**
 * Files rendered from the live CLI and instance at install time. Jira registers
 * `jira/references/fields.md` and `jira/references/link-types.md`.
 */
export const GENERATED: Record<string, Generator> = {
  'jira/references/commands.md': async (_ctx, program) => renderCommandTree(program, { namespace: 'jira' }),
  'confluence/references/commands.md': async (_ctx, program) =>
    renderCommandTree(program, { namespace: 'confluence' }),
};

export function registerGenerated(rel: string, generator: Generator): void {
  GENERATED[rel] = generator;
}
