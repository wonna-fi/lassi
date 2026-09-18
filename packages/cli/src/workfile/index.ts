export { lassiDirs, type LassiDirs } from './paths.js';
export {
  RESERVED_KEYS,
  splitEditable,
  type LassiMeta,
  type SplitFrontmatter,
  type WorkingFile,
} from './schema.js';
export { readWorkingFile } from './read.js';
export { writeWorkingFile } from './write.js';
export { deepEqual, diffEditable, readonlyDrift, type FieldChange } from './diff.js';
export {
  confluenceCachePath,
  confluencePageCachePath,
  jiraCachePath,
  readJsonCache,
  writeJsonCache,
} from './cache.js';
