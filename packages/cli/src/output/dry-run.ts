export interface DryRunPreview {
  method: 'POST' | 'PUT' | 'DELETE';
  path: string;
  /** e.g. `body (wiki markup)`, `body (storage)`, `fields (json)`. */
  payloadLabel: string;
  payload: string;
  /** A resolved sentence such as `PROJ-1 blocks PROJ-2`. */
  note?: string;
}

/** format. Tokens never appear: previews are built from paths and converted payloads only. */
export function renderDryRun(preview: DryRunPreview): string {
  const lines = ['DRY RUN — nothing sent', `${preview.method} ${preview.path}`];
  if (preview.note) lines.push(preview.note);
  lines.push(`--- ${preview.payloadLabel} ---`);
  lines.push(preview.payload.replace(/\n+$/, ''));
  return `${lines.join('\n')}\n`;
}

export function dryRunData(preview: DryRunPreview): Record<string, unknown> {
  return { dryRun: true, ...preview };
}
