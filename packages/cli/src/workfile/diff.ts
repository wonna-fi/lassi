export interface FieldChange {
  key: string;
  from: unknown;
  to: unknown;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of keys) if (!deepEqual(ao[k], bo[k])) return false;
    return true;
  }
  return false;
}

/** Keys whose value changed or was added in the working file; deleted keys are reported separately. */
export function diffEditable(
  current: Record<string, unknown>,
  cached: Record<string, unknown>
): { changed: FieldChange[]; deleted: string[] } {
  const changed: FieldChange[] = [];
  for (const [key, to] of Object.entries(current)) {
    if (!deepEqual(to, cached[key])) changed.push({ key, from: cached[key], to });
  }
  const deleted = Object.keys(cached).filter((k) => !(k in current));
  return { changed, deleted };
}

/** Keys under `readonly:` the agent edited. */
export function readonlyDrift(
  current: Record<string, unknown> | undefined,
  cached: Record<string, unknown> | undefined
): string[] {
  if (!current || !cached) return [];
  return Object.keys(cached).filter((k) => !deepEqual(current[k], cached[k]));
}
