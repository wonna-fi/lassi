export type ConfigSource = 'default' | 'global' | 'workspace' | 'env' | 'flag';

export interface SourceInfo {
  source: ConfigSource;
  /** File path or environment variable name the value came from. */
  from?: string;
}

/** One precedence layer: dotted leaf paths -> values. Later layers win. */
export interface Layer {
  source: ConfigSource;
  from?: string;
  values: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `{ jira: { url: 'x' } }` -> `{ 'jira.url': 'x' }`. Arrays and null are leaves; empty objects carry
 * no information and produce nothing, so `"jira": {}` in a later file cannot wipe an earlier layer.
 */
export function flatten(obj: Record<string, unknown>, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) {
      Object.assign(out, flatten(value, path));
    } else {
      out[path] = value;
    }
  }
  return out;
}

/** Inverse of `flatten`. */
/** Segments that would reach `Object.prototype` instead of the object being built. */
const UNSAFE_SEGMENT = new Set(['__proto__', 'constructor', 'prototype']);

export function unflatten(flat: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split('.');
    // A config file is untrusted input; a `__proto__` key must not write onto every object in the
    // process, least of all in a library embedded elsewhere. The schema rejects the key
    // afterwards, but by then the damage would be done.
    if (parts.some((part) => UNSAFE_SEGMENT.has(part))) continue;
    let cursor = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i] as string;
      const next = cursor[part];
      if (isPlainObject(next)) {
        cursor = next;
      } else {
        const created: Record<string, unknown> = {};
        cursor[part] = created;
        cursor = created;
      }
    }
    cursor[parts[parts.length - 1] as string] = value;
  }
  return out;
}

/** Applies layers in order; the last layer that sets a leaf wins and is recorded as its source. */
export function mergeLayers(layers: Layer[]): {
  values: Record<string, unknown>;
  sources: Record<string, SourceInfo>;
} {
  const values: Record<string, unknown> = {};
  const sources: Record<string, SourceInfo> = {};
  for (const layer of layers) {
    for (const [path, value] of Object.entries(layer.values)) {
      if (value === undefined) continue;
      values[path] = value;
      sources[path] =
        layer.from === undefined
          ? { source: layer.source }
          : { source: layer.source, from: layer.from };
    }
  }
  return { values, sources };
}
