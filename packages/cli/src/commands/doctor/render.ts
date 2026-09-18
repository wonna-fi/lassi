import { renderTable } from '../../output/table.js';
import type { CheckResult } from './types.js';

export function renderDoctor(results: CheckResult[]): string {
  return renderTable(
    [
      { key: 'name', header: 'Check' },
      { key: 'status', header: 'Status' },
      { key: 'detail', header: 'Detail' },
    ],
    results.map((r) => ({
      name: r.name,
      status: r.status,
      detail: r.hint ? `${r.detail} — hint: ${r.hint}` : r.detail,
    }))
  );
}
