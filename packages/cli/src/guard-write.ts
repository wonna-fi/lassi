import { LassiError } from '@wonna/lassi-core';
import type { Context } from './context.js';
import { renderDryRun, type DryRunPreview } from './output/dry-run.js';

export const READ_ONLY_VAR = 'LASSI_READ_ONLY';

/** Any value except an explicit "off" spelling enables read-only mode. */
export function isReadOnly(env: Record<string, string | undefined>): boolean {
  const value = env[READ_ONLY_VAR]?.trim().toLowerCase();
  return value !== undefined && !['', '0', 'false', 'no', 'off'].includes(value);
}

/** Exit 7 before any network call. `--dry-run` stays allowed because it sends nothing. */
export function assertWriteAllowed(ctx: Pick<Context, 'readOnly' | 'dryRun'>): void {
  if (ctx.readOnly && !ctx.dryRun) {
    throw new LassiError('read_only', `write commands are blocked by ${READ_ONLY_VAR}`, {
      context: { readOnlyVar: READ_ONLY_VAR },
    });
  }
}

/**
 * Called by every write handler at the exact point it would send. Re-asserts read-only (defence in
 * depth) and, under `--dry-run`, prints the preview and tells the handler not to send.
 */
export function guardWrite(ctx: Context, preview: DryRunPreview): 'send' | 'dry-run' {
  assertWriteAllowed(ctx);
  if (!ctx.dryRun) return 'send';
  // Through the redactor like every other stdout byte (run-command.ts): a preview is built from a
  // converted payload, and that payload can carry a token the user pasted into a comment body.
  if (ctx.format === 'markdown') ctx.deps.stdout.write(ctx.redact(renderDryRun(preview)));
  return 'dry-run';
}
