import { isTag, type ChildNode, type Element } from 'domhandler';
import { storageToMdast, type PageShapes } from '../convert/storage-to-mdast.js';
import { EMPTY_DIRECTORY, type UserDirectory } from '../convert/users.js';
import type { ConverterWarning } from '../convert/warnings.js';
import { attributesOf, parseStorage } from '../convert/xml/parse.js';

/** Macro usage of one page; `layout` counts `ac:layout` and the legacy `div.contentLayout2`. */
export function countMacros(storage: string): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (name: string): void => void counts.set(name, (counts.get(name) ?? 0) + 1);
  const walk = (nodes: ChildNode[]): void => {
    for (const node of nodes) {
      if (!isTag(node)) continue;
      const el: Element = node;
      if (el.name === 'ac:structured-macro' || el.name === 'ac:macro') {
        bump((attributesOf(el).find(([n]) => n === 'ac:name')?.[1] ?? '?').toLowerCase() || '?');
      } else if (el.name === 'ac:layout') {
        bump('layout');
      } else if (el.name === 'div' && /\bcontentLayout2?\b/.test(el.attribs['class'] ?? '')) {
        bump('layout');
      }
      walk(el.children);
    }
  };
  walk(parseStorage(storage).doc.children);
  return counts;
}

export interface PageObservation {
  id: string;
  macros: Map<string, number>;
  shapes: PageShapes;
  warnings: ConverterWarning[];
}

/** One page through `countMacros` and the reader (for shapes and raw-fence reasons). */
export function observePage(
  id: string,
  storage: string,
  users: UserDirectory = EMPTY_DIRECTORY
): PageObservation {
  const result = storageToMdast(storage, { users });
  return { id, macros: countMacros(storage), shapes: result.shapes, warnings: result.warnings };
}

/** The bucket a converter warning lands in: what the dialect could gain next. */
export function fenceReason(warning: ConverterWarning): string | undefined {
  switch (warning.code) {
    case 'block-unknown':
      if (warning.name.startsWith('macro:')) return warning.name;
      if (warning.name === 'ac:layout' || warning.name.startsWith('div[')) return 'layout';
      return `block:${warning.name}`;
    case 'inline-unknown':
      return `inline:${warning.name}`;
    case 'attribute-unknown':
      return `attribute:${warning.name}`;
    case 'table-shape':
      return `table-shape:${warning.name}`;
    default:
      return undefined;
  }
}

export interface CountRow {
  name: string;
  pages: number;
  occurrences: number;
}

export interface Convention {
  aspect: string;
  value: string;
  pages: number;
}

export interface StatsSummary {
  pages: number;
  fencedPages: number;
  macros: CountRow[];
  fences: CountRow[];
  conventions: Convention[];
}

function tally(rows: Map<string, { pages: Set<string>; occurrences: number }>): CountRow[] {
  return [...rows.entries()]
    .map(([name, r]) => ({ name, pages: r.pages.size, occurrences: r.occurrences }))
    .sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name));
}

function add(
  rows: Map<string, { pages: Set<string>; occurrences: number }>,
  name: string,
  id: string,
  n = 1
): void {
  const row = rows.get(name) ?? { pages: new Set<string>(), occurrences: 0 };
  row.pages.add(id);
  row.occurrences += n;
  rows.set(name, row);
}

/**
 * Aggregates observations into the two tables asks for: which macros the space actually
 * uses, and which editor conventions (table shell, cell wrapping, mention attribute, layouts) the
 * writer must follow to leave pages untouched.
 */
export function summarize(observations: PageObservation[]): StatsSummary {
  const macros = new Map<string, { pages: Set<string>; occurrences: number }>();
  const fences = new Map<string, { pages: Set<string>; occurrences: number }>();
  const conventions = new Map<string, Map<string, Set<string>>>();
  const observe = (aspect: string, value: string, id: string): void => {
    const values = conventions.get(aspect) ?? new Map<string, Set<string>>();
    const pages = values.get(value) ?? new Set<string>();
    pages.add(id);
    values.set(value, pages);
    conventions.set(aspect, values);
  };
  const fencedPages = new Set<string>();
  for (const o of observations) {
    for (const [name, n] of o.macros) add(macros, name, o.id, n);
    for (const w of o.warnings) {
      const reason = fenceReason(w);
      if (reason === undefined) continue;
      add(fences, reason, o.id);
      fencedPages.add(o.id);
    }
    observe('layout', o.macros.has('layout') ? 'ac:layout' : 'none', o.id);
    for (const shell of new Set(o.shapes.tableShells)) observe('table shell', shell, o.id);
    for (const wrap of new Set(o.shapes.cellWraps)) observe('cell wrap', wrap, o.id);
    for (const attr of new Set(o.shapes.mentionAttributes))
      observe('mention attribute', attr, o.id);
  }
  const conventionRows: Convention[] = [];
  for (const [aspect, values] of conventions) {
    for (const [value, pages] of [...values.entries()].sort((a, b) => b[1].size - a[1].size))
      conventionRows.push({ aspect, value, pages: pages.size });
  }
  return {
    pages: observations.length,
    fencedPages: fencedPages.size,
    macros: tally(macros),
    fences: tally(fences),
    conventions: conventionRows,
  };
}
