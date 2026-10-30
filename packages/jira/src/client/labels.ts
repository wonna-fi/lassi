import { LassiError } from '@wonna/lassi-core';

export interface LabelChangePlan {
  changed: string[];
  unchanged: string[];
}

/** Compare literal, case-sensitive labels against the issue snapshot, keeping input order. */
export function planLabelChange(
  mode: 'add' | 'remove',
  requested: readonly string[],
  current: readonly string[]
): LabelChangePlan {
  const present = new Set(current);
  const plan: LabelChangePlan = { changed: [], unchanged: [] };
  for (const label of new Set(requested)) {
    if (label === '' || /\s/u.test(label)) {
      throw new LassiError(
        'usage',
        `invalid label ${JSON.stringify(label)}: labels must be nonempty and contain no whitespace`,
        {
          hint: 'pass each label as a separate argument; use hyphens or underscores instead of spaces',
        }
      );
    }
    const changes = mode === 'add' ? !present.has(label) : present.has(label);
    (changes ? plan.changed : plan.unchanged).push(label);
  }
  return plan;
}

/** Update only the named labels, preserving unrelated labels added since the issue was read. */
export function labelUpdate(
  mode: 'add' | 'remove',
  labels: readonly string[]
): { update: { labels: Array<{ add: string } | { remove: string }> } } {
  return {
    update: {
      labels: labels.map((label) => (mode === 'add' ? { add: label } : { remove: label })),
    },
  };
}
