export interface WikiRow {
  header: boolean;
  cells: string[];
}

/**
 * Splits one `||h||h||` or `|c|c|` line. Pipes inside `{{…}}`, `[…]` and `!…!` do not split. Returns
 * undefined for shapes GFM cannot carry (per-cell headers, a line not ending with a pipe).
 */
export function splitRow(line: string): WikiRow | undefined {
  const text = line.trim();
  if (!text.startsWith('|')) return undefined;
  const header = text.startsWith('||');
  const delimiter = header ? '||' : '|';
  if (!text.endsWith(delimiter)) return undefined;
  const body = text.slice(delimiter.length, text.length - delimiter.length);
  const cells: string[] = [];
  let current = '';
  let i = 0;
  while (i < body.length) {
    const ch = body[i] as string;
    if (body.startsWith('{{', i)) {
      const end = body.indexOf('}}', i + 2);
      const stop = end === -1 ? body.length : end + 2;
      current += body.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '[') {
      const end = body.indexOf(']', i + 1);
      const stop = end === -1 ? i + 1 : end + 1;
      current += body.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === '!' && /^![^!|\s][^!]*?!/.test(body.slice(i))) {
      const end = body.indexOf('!', i + 1);
      current += body.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '\\' && i + 1 < body.length) {
      current += body.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (body.startsWith(delimiter, i)) {
      cells.push(current);
      current = '';
      i += delimiter.length;
      continue;
    }
    if (!header && body.startsWith('||', i)) return undefined;
    current += ch;
    i += 1;
  }
  cells.push(current);
  return { header, cells: cells.map((c) => c.trim()) };
}

/**
 * A GFM-representable table: one leading `||` header row, then `|` rows, no cell wider than the
 * header. Returns undefined when the block must stay a raw fence.
 */
export function parseTable(lines: string[]): WikiRow[] | undefined {
  const rows: WikiRow[] = [];
  for (const line of lines) {
    const row = splitRow(line);
    if (!row) return undefined;
    rows.push(row);
  }
  const first = rows[0];
  if (!first || !first.header) return undefined;
  for (const row of rows.slice(1)) if (row.header) return undefined;
  const width = first.cells.length;
  for (const row of rows) {
    if (row.cells.length > width) return undefined;
    while (row.cells.length < width) row.cells.push('');
    for (const cell of row.cells) {
      if (/(^|[^{\\])\{(code|noformat|quote|panel)(?:[:}])/.test(cell)) return undefined;
    }
  }
  return rows;
}
