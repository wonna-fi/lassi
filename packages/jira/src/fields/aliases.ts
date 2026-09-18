/** Standard Jira field ids an agent may address directly. */
export const STANDARD_FIELD_NAMES: ReadonlySet<string> = new Set([
  'summary',
  'description',
  'priority',
  'assignee',
  'reporter',
  'labels',
  'components',
  'fixVersions',
  'versions',
  'duedate',
  'environment',
  'parent',
  'issuetype',
  'project',
  'security',
]);

export const CUSTOM_FIELD_ID = /^customfield_\d+$/;

/** Frontmatter / flag name → Jira field id. `type` is the frontmatter spelling of `issuetype`. */
export function fieldIdFor(aliases: Record<string, string>, key: string): string | undefined {
  // `Object.hasOwn`, not a bare lookup: the aliases come from JSON, so `--field toString=x` used to
  // resolve through the prototype to a function and PUT it as the field id, with exit 0.
  const alias = Object.hasOwn(aliases, key) ? aliases[key] : undefined;
  if (alias !== undefined) return alias;
  if (key === 'type') return 'issuetype';
  if (CUSTOM_FIELD_ID.test(key) || STANDARD_FIELD_NAMES.has(key)) return key;
  return undefined;
}

export function resolveFieldAliases(
  aliases: Record<string, string>,
  input: Record<string, unknown>
): { fields: Record<string, unknown>; unknown: string[] } {
  const fields: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    const id = fieldIdFor(aliases, key);
    if (id === undefined) unknown.push(key);
    else fields[id] = value;
  }
  return { fields, unknown };
}

/** First alias (in config order) that maps to the field id. */
export function aliasFor(aliases: Record<string, string>, fieldId: string): string | undefined {
  for (const [alias, id] of Object.entries(aliases)) if (id === fieldId) return alias;
  return undefined;
}
