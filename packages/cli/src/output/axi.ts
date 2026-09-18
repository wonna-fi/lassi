import { brief } from '@wonna/lassi-core';
import { encode } from '@toon-format/toon';

/** What an `--axi` run prints: one TOON document, then optional `help[n]:` next-step lines. */
export interface AxiPayload {
  data: unknown;
  help?: string[];
}

/** Long free text in list rows is cut here; `--json` is the full escape hatch. */
export const AXI_SNIPPET_CHARS = 200;

export const truncate = (text: string, max = AXI_SNIPPET_CHARS): string => brief(text, max);

/** Drops `undefined` and functions the way JSON does, so the encoder sees plain data. */
function toJsonValue(value: unknown): unknown {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/** TOON needs an object at the root; a bare array or scalar gets a one-key wrapper. */
function rootObject(data: unknown): Record<string, unknown> {
  const value = toJsonValue(data);
  if (Array.isArray(value)) return { count: value.length, items: value };
  if (value !== null && typeof value === 'object') return value as Record<string, unknown>;
  return { value };
}

/** Rendered by hand so the data block above it parses as TOON on its own. */
export function renderHelp(help: string[] | undefined): string {
  const lines = (help ?? []).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return '';
  return `help[${lines.length}]:\n${lines.map((l) => `  ${l}`).join('\n')}\n`;
}

export function renderAxi(payload: AxiPayload): string {
  const body = encode(rootObject(payload.data));
  return `${body.endsWith('\n') ? body : `${body}\n`}${renderHelp(payload.help)}`;
}
