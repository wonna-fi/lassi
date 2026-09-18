export interface LassiMeta {
  fetchedAt: string;
  product: 'jira' | 'confluence';
  schema: 1;
  storageSha256?: string;
  format?: 'md' | 'view';
}

export interface WorkingFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Top-level keys that are not editable fields. */
export const RESERVED_KEYS = ['readonly', 'counts', 'lassi'] as const;

export interface SplitFrontmatter {
  editable: Record<string, unknown>;
  readonly?: Record<string, unknown>;
  counts?: Record<string, number>;
  lassi?: LassiMeta;
}

export function splitEditable(frontmatter: Record<string, unknown>): SplitFrontmatter {
  const editable: Record<string, unknown> = {};
  const out: SplitFrontmatter = { editable };
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key === 'readonly' && typeof value === 'object' && value !== null) {
      out.readonly = value as Record<string, unknown>;
    } else if (key === 'counts' && typeof value === 'object' && value !== null) {
      out.counts = value as Record<string, number>;
    } else if (key === 'lassi' && typeof value === 'object' && value !== null) {
      out.lassi = value as LassiMeta;
    } else {
      editable[key] = value;
    }
  }
  return out;
}
