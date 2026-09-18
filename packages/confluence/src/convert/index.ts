import { stringifyMarkdown, type BodyConverter } from '@wonna/lassi-core';
import type { Root } from 'mdast';
import {
  CONFLUENCE_STRINGIFY_OPTIONS,
  normalizeConfluenceMarkdown,
  parseConfluenceMarkdown,
  stringifyConfluenceMarkdown,
} from './md/index.js';
import { mdastToStorage } from './mdast-to-storage.js';
import { storageToMdast, type PageShapes, type ReadResult } from './storage-to-mdast.js';
import { EMPTY_DIRECTORY, type UserDirectory } from './users.js';
import { viewToMdast } from './view-to-mdast.js';
import type { ConverterWarning, StorageWarning } from './warnings.js';
import type { StorageWriterOptions } from './writer-options.js';

export interface StorageConverterOptions {
  users?: UserDirectory;
  /** Editor-form choices for the write direction; `inferWriterOptions` fills them from a page. */
  writer?: Partial<StorageWriterOptions>;
  onWarning?: (warning: ConverterWarning) => void;
  onWriteWarning?: (warning: StorageWarning) => void;
}

/** Both directions behind core's `BodyConverter`, plus the mdast-level entry points. */
export interface StorageConverter extends BodyConverter {
  readonly format: 'storage';
  toMdast(storage: string): ReadResult;
  fromMdast(tree: Root): string;
  /** Rendered HTML (`convertBody(storage → view)`) → markdown; never written back. */
  viewToMarkdown(html: string): string;
  readonly shapes: PageShapes | undefined;
}

/** Storage XHTML → canonical markdown for the Confluence dialect. */
export function storageToMarkdown(storage: string, opts: StorageConverterOptions = {}): string {
  const result = storageToMdast(storage, { users: opts.users ?? EMPTY_DIRECTORY });
  for (const warning of result.warnings) opts.onWarning?.(warning);
  return stringifyMarkdown(result.tree, CONFLUENCE_STRINGIFY_OPTIONS);
}

/** Rendered view HTML → markdown with the same handlers; fences are plain `html` blocks. */
export function viewToMarkdown(html: string, opts: StorageConverterOptions = {}): string {
  const result = viewToMdast(html, { users: opts.users ?? EMPTY_DIRECTORY });
  for (const warning of result.warnings) opts.onWarning?.(warning);
  return stringifyMarkdown(result.tree, CONFLUENCE_STRINGIFY_OPTIONS);
}

export function createStorageConverter(opts: StorageConverterOptions = {}): StorageConverter {
  let shapes: PageShapes | undefined;
  return {
    format: 'storage',
    get shapes() {
      return shapes;
    },
    toMdast(storage) {
      const result = storageToMdast(storage, { users: opts.users ?? EMPTY_DIRECTORY });
      shapes = result.shapes;
      for (const warning of result.warnings) opts.onWarning?.(warning);
      return result;
    },
    toMarkdown(storage) {
      return stringifyConfluenceMarkdown(this.toMdast(storage).tree);
    },
    viewToMarkdown(html) {
      return viewToMarkdown(html, opts);
    },
    fromMdast(tree) {
      const result = mdastToStorage(tree, {
        users: opts.users ?? EMPTY_DIRECTORY,
        ...(opts.writer ? { writer: opts.writer } : {}),
      });
      for (const warning of result.warnings) opts.onWriteWarning?.(warning);
      return result.storage;
    },
    fromMarkdown(markdown) {
      return this.fromMdast(parseConfluenceMarkdown(markdown));
    },
  };
}

export { normalizeConfluenceMarkdown, parseConfluenceMarkdown, stringifyConfluenceMarkdown };
