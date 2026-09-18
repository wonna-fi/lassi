export * from './page/index.js';
export { viewToMdast } from './convert/view-to-mdast.js';
export * from './stats/macros.js';
export { mdastToStorage, type WriteOptions, type WriteResult } from './convert/mdast-to-storage.js';
export {
  DEFAULT_WRITER_OPTIONS,
  inferWriterOptions,
  inferWriterOptionsFromStorage,
  type StorageWriterOptions,
} from './convert/writer-options.js';
export type { StorageWarning, StorageWarningCode } from './convert/warnings.js';
export {
  createConfluenceClient,
  parseManifestVersion,
  type ConfluenceClient,
  type ConfluenceClientOptions,
  type SearchIterOptions,
  type SearchOptions,
} from './client/index.js';
export { parsePageRef } from './client/refs.js';
export * from './client/types.js';
export {
  createStorageConverter,
  normalizeConfluenceMarkdown,
  parseConfluenceMarkdown,
  storageToMarkdown,
  stringifyConfluenceMarkdown,
  type StorageConverter,
  type StorageConverterOptions,
} from './convert/index.js';
export {
  CONFLUENCE_PARSE_OPTIONS,
  CONFLUENCE_STRINGIFY_OPTIONS,
  confluenceToMarkdown,
  parsePageLinkBody,
  type Alert,
  type AlertKind,
  type JiraMacro,
  type PageLink,
} from './convert/md/index.js';
export { decodeParams, encodeParams, type Params } from './convert/params.js';
export {
  storageToMdast,
  type PageShapes,
  type ReadOptions,
  type ReadResult,
} from './convert/storage-to-mdast.js';
export {
  collectMentions,
  collectUserKeys,
  mergeUserDirectories,
  collectUsernames,
  EMPTY_DIRECTORY,
  userDirectory,
  type UserDirectory,
} from './convert/users.js';
export type { ConverterWarning, ConverterWarningCode } from './convert/warnings.js';
export {
  checkFidelity,
  compareStorage,
  type CompareResult,
  type FidelityResult,
  type StorageDiff,
} from './convert/fidelity.js';
export {
  BLOCK_CONTAINERS,
  BLOCK_ELEMENTS,
  hasBlockChildren,
  IGNORED_ATTRIBUTES,
  IGNORED_ELEMENTS,
  modeOf,
  normalizeStorage,
  serializeCanonical,
  toCanonicalTree,
  VERBATIM,
  type CanonNode,
  type WhitespaceMode,
} from './convert/normalize.js';
export { cdata, escapeAttr, escapeText } from './convert/xml/escape.js';
export {
  attributesOf,
  decodeAttr,
  decodeText,
  parseStorage,
  sliceRange,
  sliceSource,
  VOID_ELEMENTS,
  type ParsedStorage,
} from './convert/xml/parse.js';
