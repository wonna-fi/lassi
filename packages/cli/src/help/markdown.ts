import type { Command } from 'commander';
import { LassiHelp } from './lassi-help.js';
import { renderTable } from '../output/table.js';

function fullName(cmd: Command): string {
  const parts: string[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) parts.unshift(c.name());
  return parts.join(' ');
}

function leafSection(cmd: Command, helper: LassiHelp): string {
  const lines: string[] = [];
  lines.push(`#### ${fullName(cmd)}`, '');
  lines.push('```', helper.commandUsage(cmd), '```', '');
  const description = helper.commandDescription(cmd);
  if (description) lines.push(description, '');
  const args = helper.visibleArguments(cmd);
  if (args.length > 0) {
    lines.push(
      renderTable(
        [
          { key: 'argument', header: 'Argument' },
          { key: 'description', header: 'Description' },
        ],
        args.map((a) => ({
          argument: helper.argumentTerm(a),
          description: helper.argumentDescription(a),
        }))
      )
    );
  }
  const options = helper.visibleOptions(cmd);
  if (options.length > 0) {
    lines.push(
      renderTable(
        [
          { key: 'option', header: 'Option' },
          { key: 'description', header: 'Description' },
        ],
        options.map((o) => ({
          option: helper.optionTerm(o),
          description: helper.optionDescription(o),
        }))
      )
    );
  }
  return lines.join('\n');
}

function walk(cmd: Command, depth: number, helper: LassiHelp, out: string[]): void {
  const children = cmd.commands.filter((c) => !(c as unknown as { _hidden?: boolean })._hidden);
  if (children.length === 0) {
    out.push(leafSection(cmd, helper));
    return;
  }
  const heading = depth === 1 ? '##' : '###';
  const description = helper.commandDescription(cmd);
  out.push(`${heading} ${fullName(cmd)}${description ? ` — ${description}` : ''}`, '');
  for (const child of children) walk(child, depth + 1, helper, out);
}

/**
 * The whole command tree as markdown (`lassi help --all`). Used verbatim for the generated
 * `references/commands.md` in the skills, so the output has no width-dependent wrapping.
 */
export function renderCommandTree(root: Command, opts: { namespace?: string } = {}): string {
  const helper = new LassiHelp();
  const out: string[] = [];
  const globalOptions = helper.visibleOptions(root);
  if (opts.namespace === undefined) {
    out.push('# lassi command reference', '');
    if (root.description()) out.push(root.description(), '');
  } else {
    out.push(`# lassi ${opts.namespace} commands`, '');
  }
  if (globalOptions.length > 0) {
    out.push('Global options (accepted before or after any command):', '');
    out.push(
      renderTable(
        [
          { key: 'option', header: 'Option' },
          { key: 'description', header: 'Description' },
        ],
        globalOptions.map((o) => ({
          option: helper.optionTerm(o),
          description: helper.optionDescription(o),
        }))
      )
    );
  }
  const roots =
    opts.namespace === undefined
      ? root.commands
      : root.commands.filter(
          (c) => c.name() === opts.namespace || c.aliases().includes(opts.namespace as string)
        );
  for (const cmd of roots) walk(cmd, 1, helper, out);
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
