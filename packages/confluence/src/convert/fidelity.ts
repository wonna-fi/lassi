import type { BodyConverter } from '@wonna/lassi-core';
import { serializeCanonical, toCanonicalTree, type CanonNode } from './normalize.js';

export interface StorageDiff {
  /** Positional XPath into the canonical tree, e.g. `/p[3]/ac:structured-macro[1]/@ac:name`. */
  path: string;
  kind: 'missing' | 'extra' | 'changed';
  a?: string;
  b?: string;
}

export interface CompareResult {
  equal: boolean;
  diffs: StorageDiff[];
  truncated: boolean;
}

const VALUE_CHARS = 120;

function short(value: string): string {
  return value.length > VALUE_CHARS ? `${value.slice(0, VALUE_CHARS)}…` : value;
}

function describe(node: CanonNode): string {
  switch (node.kind) {
    case 'text':
      return short(node.value);
    case 'comment':
      return short(`<!--${node.value}-->`);
    case 'pi':
      return short(`<?${node.value}?>`);
    case 'element':
      return short(serializeCanonical([node]));
  }
}

function sameLabel(a: CanonNode, b: CanonNode): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind !== 'element' || b.kind !== 'element' || a.name === b.name;
}

function step(node: CanonNode, siblings: CanonNode[], index: number): string {
  const label = node.kind === 'element' ? node.name : `${node.kind}()`;
  let ordinal = 0;
  for (let i = 0; i <= index; i++) if (sameLabel(siblings[i] as CanonNode, node)) ordinal += 1;
  return `${label}[${ordinal}]`;
}

class Differ {
  readonly diffs: StorageDiff[] = [];
  truncated = false;
  private readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  add(diff: StorageDiff): boolean {
    if (this.diffs.length >= this.max) {
      this.truncated = true;
      return false;
    }
    this.diffs.push(diff);
    return true;
  }

  compare(a: CanonNode[], b: CanonNode[], path: string): void {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n && !this.truncated; i++) {
      const x = a[i];
      const y = b[i];
      if (x && !y) {
        this.add({ path: `${path}/${step(x, a, i)}`, kind: 'missing', a: describe(x) });
        continue;
      }
      if (!x && y) {
        this.add({ path: `${path}/${step(y, b, i)}`, kind: 'extra', b: describe(y) });
        continue;
      }
      if (!x || !y) continue;
      const here = `${path}/${step(x, a, i)}`;
      if (!sameLabel(x, y)) {
        this.add({ path: here, kind: 'changed', a: describe(x), b: describe(y) });
        continue;
      }
      if (x.kind !== 'element' || y.kind !== 'element') {
        const av = (x as { value: string }).value;
        const bv = (y as { value: string }).value;
        if (av !== bv) this.add({ path: here, kind: 'changed', a: short(av), b: short(bv) });
        continue;
      }
      const names = [...new Set([...x.attrs.map(([k]) => k), ...y.attrs.map(([k]) => k)])].sort();
      for (const name of names) {
        const av = x.attrs.find(([k]) => k === name)?.[1];
        const bv = y.attrs.find(([k]) => k === name)?.[1];
        if (av === bv) continue;
        const kind = av === undefined ? 'extra' : bv === undefined ? 'missing' : 'changed';
        const diff: StorageDiff = { path: `${here}/@${name}`, kind };
        if (av !== undefined) diff.a = av;
        if (bv !== undefined) diff.b = bv;
        if (!this.add(diff)) return;
      }
      this.compare(x.children, y.children, here);
    }
  }
}

/** Structural comparison of two storage bodies after normalisation. */
export function compareStorage(
  a: string,
  b: string,
  opts: { maxDiffs?: number } = {}
): CompareResult {
  const differ = new Differ(opts.maxDiffs ?? 10);
  differ.compare(toCanonicalTree(a), toCanonicalTree(b), '');
  return {
    equal: differ.diffs.length === 0 && !differ.truncated,
    diffs: differ.diffs,
    truncated: differ.truncated,
  };
}

export interface FidelityResult extends CompareResult {
  /** The markdown the page reads as (what the agent would edit). */
  markdown: string;
  /** Set when the write direction threw; then `equal` is false and `diffs` empty. */
  error?: string;
}

/**
 * `normalize(original)` versus `normalize(fromMarkdown(toMarkdown(original)))`. Equal
 * means a full-page update cannot damage the regions the agent did not touch.
 */
export function checkFidelity(original: string, converter: BodyConverter): FidelityResult {
  const markdown = converter.toMarkdown(original);
  let written: string;
  try {
    written = converter.fromMarkdown(markdown);
  } catch (err) {
    return { equal: false, diffs: [], truncated: false, markdown, error: (err as Error).message };
  }
  return { ...compareStorage(original, written), markdown };
}
