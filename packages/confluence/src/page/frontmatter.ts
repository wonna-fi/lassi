import { createHash } from 'node:crypto';
import type { ConfluenceContent, ConfluencePage, PageCounts } from '../client/types.js';

export interface PageReadonly {
  version: number;
  lastModified: string;
  lastModifiedBy: string | null;
  url: string;
}

/** `title` and `parent` are editable; `space`, `readonly`, `counts` and `lassi` are not. */
export interface PageFrontmatter {
  id: number;
  title: string;
  space: string;
  parent: number | null;
  readonly: PageReadonly;
  counts: PageCounts;
  lassi: {
    fetchedAt: string;
    product: 'confluence';
    schema: 1;
    storageSha256: string;
    format: 'md' | 'view';
  };
}

export function storageSha256(storage: string): string {
  return createHash('sha256').update(storage, 'utf8').digest('hex');
}

export function pageToFrontmatter(
  page: ConfluencePage,
  opts: { baseUrl: string; fetchedAt: string; format: 'md' | 'view' }
): PageFrontmatter {
  const parent = page.ancestors?.[page.ancestors.length - 1]?.id;
  const version = page.version?.number ?? 0;
  return {
    id: Number(page.id),
    title: page.title,
    space: page.space?.key ?? '',
    parent: parent === undefined ? null : Number(parent),
    readonly: {
      version,
      lastModified: page.history?.lastUpdated?.when ?? page.version?.when ?? '',
      lastModifiedBy: page.history?.lastUpdated?.by?.username ?? page.version?.by?.username ?? null,
      url: `${opts.baseUrl.replace(/\/+$/, '')}/pages/viewpage.action?pageId=${page.id}`,
    },
    counts: page.counts,
    lassi: {
      fetchedAt: opts.fetchedAt,
      product: 'confluence',
      schema: 1,
      storageSha256: storageSha256(page.body?.storage?.value ?? ''),
      format: opts.format,
    },
  };
}

export interface EditableDiff {
  title: string;
  titleChanged: boolean;
  parentId: string | null;
  parentChanged: boolean;
  spaceChanged: boolean;
  /** Top-level keys that are neither editable nor reserved; an update refuses them. */
  unknownKeys: string[];
}

const EDITABLE = new Set(['id', 'title', 'space', 'parent']);

/** Compares a working file's editable keys with the live page (title and parent may change). */
export function diffEditableFields(
  editable: Record<string, unknown>,
  live: ConfluenceContent,
  /**
   * What the working file was fetched from. Without it the live page is the baseline, which would
   * read a move made on the server after the fetch as the user's edit and revert it.
   */
  base?: { parent: string | null }
): EditableDiff {
  const liveParent = live.ancestors?.[live.ancestors.length - 1]?.id ?? null;
  const baseParent = base === undefined ? liveParent : base.parent;
  const title = typeof editable['title'] === 'string' ? editable['title'] : live.title;
  const rawParent = editable['parent'];
  const parentId =
    rawParent === null || rawParent === undefined ? null : String(rawParent as string | number);
  const space = editable['space'];
  return {
    title,
    titleChanged: title !== live.title,
    parentId,
    parentChanged: 'parent' in editable && parentId !== baseParent,
    spaceChanged: typeof space === 'string' && space !== '' && space !== (live.space?.key ?? ''),
    unknownKeys: Object.keys(editable).filter((k) => !EDITABLE.has(k)),
  };
}
