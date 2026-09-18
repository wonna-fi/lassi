export interface Column {
  key: string;
  header: string;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '-';
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

/** GFM table; no colour, no alignment padding beyond a single space (stable diffs for agents). */
export function renderTable(columns: Column[], rows: ReadonlyArray<object>): string {
  const header = `| ${columns.map((c) => c.header).join(' | ')} |`;
  const separator = `| ${columns.map(() => '-').join(' | ')} |`;
  const body = rows.map(
    (row) => `| ${columns.map((c) => cell((row as Record<string, unknown>)[c.key])).join(' | ')} |`
  );
  return `${[header, separator, ...body].join('\n')}\n`;
}
