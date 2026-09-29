export {
  issueToFrontmatter,
  type FrontmatterResult,
  type IssueCounts,
  type IssueFrontmatter,
  type IssueReadonly,
} from './frontmatter.js';
export {
  buildIssueCache,
  issueFileState,
  splitFrontmatterKeys,
  type IssueCache,
  type IssueFileState,
} from './cache.js';
export {
  fieldChangeToApi,
  frontmatterChanges,
  frontmatterDiff,
  type DiffInput,
  type DiffResult,
  type FieldChange,
  type FrontmatterChanges,
} from './diff.js';
export {
  composeBody,
  expansionFromSections,
  joinSections,
  stripGeneratedSections,
  renderAttachments,
  renderComments,
  renderLinks,
  trailerLine,
} from './document.js';
