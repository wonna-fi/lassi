import type { Command } from 'commander';
import { LassiError } from '@wonna/lassi-core';
import {
  aliasFor,
  createJiraClient,
  type JiraClient,
  type JiraFieldMeta,
  type JiraFieldMetaMap,
} from '@wonna/lassi-jira';
import type { Context } from '../../context.js';
import { renderTable } from '../../output/table.js';

const clients = new WeakMap<Context, Promise<JiraClient>>();

/** One Jira client per command run, built lazily on the context's HTTP client. */
export function jiraClient(ctx: Context): Promise<JiraClient> {
  let pending = clients.get(ctx);
  if (!pending) {
    pending = ctx
      .product('jira')
      .then((p) => createJiraClient({ baseUrl: p.baseUrl, http: p.http }));
    clients.set(ctx, pending);
  }
  return pending;
}

export function aliasesOf(ctx: Context): Record<string, string> {
  return ctx.config.jira.fields;
}

function allowedLabel(meta: JiraFieldMeta): string {
  const values = (meta.allowedValues ?? [])
    .map(
      (a) =>
        (a as { value?: string; name?: string; key?: string }).value ??
        (a as { name?: string }).name ??
        (a as { key?: string }).key
    )
    .filter((v): v is string => typeof v === 'string');
  if (values.length === 0) return '';
  const shown = values.slice(0, 10).join(', ');
  return values.length > 10 ? `${shown}, … (${values.length})` : shown;
}

/** `| Field | Id | Required | Type | Allowed values |` for createmeta / editmeta / transition screens. */
export function renderFieldMetaTable(
  fields: JiraFieldMetaMap,
  aliases: Record<string, string>
): string {
  const rows = Object.values(fields)
    .sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name))
    .map((meta) => {
      const alias = aliasFor(aliases, meta.fieldId);
      const type =
        meta.schema.type === 'array' ? `array<${meta.schema.items ?? '?'}>` : meta.schema.type;
      return {
        field: alias ? `${alias} (${meta.name})` : meta.name,
        id: meta.fieldId,
        required: meta.required ? 'yes' : '',
        type,
        allowed: allowedLabel(meta),
      };
    });
  return renderTable(
    [
      { key: 'field', header: 'Field' },
      { key: 'id', header: 'Id' },
      { key: 'required', header: 'Required' },
      { key: 'type', header: 'Type' },
      { key: 'allowed', header: 'Allowed values' },
    ],
    rows
  );
}

export function group(parent: Command, name: string, description: string): Command {
  return parent.command(name).description(description);
}

/** `--comments [N]`: absent → undefined, bare flag → 'all', value → N. */
export function commentsOption(value: string | boolean | undefined): number | 'all' | undefined {
  if (value === undefined || value === false) return undefined;
  if (value === true) return 'all';
  const n = Number(value);
  // A positive *integer*: `0`, a negative and a word used to mean "all", the opposite of what any
  // of them says, and a fraction below one floored to `0`, which `slice(-0)` then reads as the
  // whole array — the same "show every comment" by another route.
  if (!Number.isInteger(n) || n <= 0) {
    throw new LassiError(
      'usage',
      `--comments must be a positive whole number, got "${String(value)}"`
    );
  }
  return n;
}

export interface FlatFieldMeta {
  type: string;
  field: string;
  id: string;
  required: boolean;
  kind: string;
  allowed: string;
}

/** One row per field for `--axi`: alias (or name) first, allowed values joined with `|` (first 12). */
export function flattenFieldMeta(
  type: string,
  fields: JiraFieldMetaMap,
  aliases: Record<string, string>
): FlatFieldMeta[] {
  return Object.values(fields)
    .sort((a, b) => Number(b.required) - Number(a.required) || a.name.localeCompare(b.name))
    .map((meta) => {
      const values = (meta.allowedValues ?? []).map((v) =>
        'value' in v && v.value !== undefined
          ? String(v.value)
          : 'name' in v && v.name !== undefined
            ? String(v.name)
            : 'key' in v
              ? String(v.key)
              : ''
      );
      return {
        type,
        field: aliasFor(aliases, meta.fieldId) ?? meta.name,
        id: meta.fieldId,
        required: meta.required,
        kind:
          meta.schema.type === 'array' ? `array<${meta.schema.items ?? '?'}>` : meta.schema.type,
        allowed: values.length > 12 ? `${values.slice(0, 12).join('|')}|…` : values.join('|'),
      };
    });
}
