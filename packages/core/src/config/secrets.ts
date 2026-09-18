import { flatten } from './layers.js';

const SECRET_KEY = /(token|password|passwd|secret|apikey|api_key|credential)/i;

/**
 * Dotted paths in a raw config object that look like they hold a secret: a key named like one
 * (except `*File` pointers) or any string value that looks like a PAT. Used by `doctor` on the
 * workspace file, which must never contain secrets.
 */
export function findSecretLookingKeys(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const [path, value] of Object.entries(flatten(raw as Record<string, unknown>))) {
    const leaf = path.split('.').pop() ?? path;
    const pointsToFile = /file$/i.test(leaf);
    if (SECRET_KEY.test(leaf) && !pointsToFile && typeof value === 'string' && value.length > 0) {
      out.push(path);
      continue;
    }
    if (typeof value === 'string' && /^[A-Za-z0-9+/_=-]{40,}$/.test(value)) out.push(path);
  }
  return out;
}
