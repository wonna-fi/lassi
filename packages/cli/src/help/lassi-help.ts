import { Help, type Command } from 'commander';

const namespaces = new WeakSet<Command>();

/** Marks `lassi jira` / `lassi confluence` so their help lists flattened `issue get`-style leaves. */
export function markNamespace(cmd: Command): Command {
  namespaces.add(cmd);
  return cmd;
}

export function isNamespace(cmd: Command): boolean {
  return namespaces.has(cmd);
}

/**
 * Progressive help : the root lists namespaces, a namespace lists its commands as
 * `issue get`, `comment add`, … and a leaf shows the full flags.
 */
export class LassiHelp extends Help {
  override visibleCommands(cmd: Command): Command[] {
    const direct = super.visibleCommands(cmd);
    if (!namespaces.has(cmd)) return direct;
    const out: Command[] = [];
    for (const group of direct) {
      const leaves = super.visibleCommands(group);
      if (leaves.length === 0) out.push(group);
      else out.push(...leaves);
    }
    return out;
  }

  override subcommandTerm(cmd: Command): string {
    const term = super.subcommandTerm(cmd);
    const group = cmd.parent;
    if (group?.parent && namespaces.has(group.parent)) return `${group.name()} ${term}`;
    return term;
  }
}
