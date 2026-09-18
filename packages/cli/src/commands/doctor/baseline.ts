import type { Product } from '@wonna/lassi-core';

/** API targets used by the synthetic contract fixtures; live compatibility is not certified. */
export const API_TARGETS: Record<Product, { majors: number[] }> = {
  jira: { majors: [9, 10] },
  confluence: { majors: [8, 9] },
};

export function majorOf(version: string): number | undefined {
  const m = /^(\d+)/.exec(version.trim());
  return m ? Number(m[1]) : undefined;
}
