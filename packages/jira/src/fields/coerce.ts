import { LassiError } from '@wonna/lassi-core';
import type { JiraFieldMeta } from '../client/types.js';
import { AllowedValueMismatch, scalarToApiValue } from './normalize.js';

/** `alias=value` → parts; the value may contain `=`. */
export function parseFieldArg(arg: string): { key: string; raw: string } {
  const eq = arg.indexOf('=');
  if (eq <= 0) throw new LassiError('usage', `--field expects alias=value, got "${arg}"`);
  return { key: arg.slice(0, eq).trim(), raw: arg.slice(eq + 1) };
}

/** Splits on commas outside double quotes; quotes are stripped. */
export function splitList(raw: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of raw) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === ',' && !quoted) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current.trim());
  return out.filter((s) => s.length > 0);
}

/**
 * Coerces a `--field` value with the field's live schema (createmeta / editmeta / transition
 * screen). A JSON-looking value is sent verbatim; empty or `-` clears the field.
 */
export function coerceFieldValue(
  raw: string,
  meta: JiraFieldMeta | undefined,
  fieldId: string
): unknown {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '-') return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      throw new LassiError(
        'usage',
        `--field ${fieldId}: value looks like JSON but does not parse (${(err as Error).message})`
      );
    }
  }
  const schema = meta?.schema;
  try {
    if (schema?.type === 'number') {
      const n = Number(trimmed);
      if (Number.isNaN(n))
        throw new LassiError('usage', `--field ${fieldId}: expected a number, got "${raw}"`);
      return n;
    }
    if (schema?.type === 'array') {
      return scalarToApiValue(splitList(trimmed), schema, meta);
    }
    return scalarToApiValue(trimmed, schema, meta);
  } catch (err) {
    if (err instanceof AllowedValueMismatch) {
      throw new LassiError('validation', err.message, {
        errors: { [err.fieldId]: `Allowed: ${err.allowed.join(', ')}` },
        context: { product: 'jira', allowedValues: { [err.fieldId]: err.allowed } },
      });
    }
    throw err;
  }
}
