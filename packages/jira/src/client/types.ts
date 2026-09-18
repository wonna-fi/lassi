/** Wire shapes kept close to Jira DC REST v2 JSON; custom fields live in `fields` by raw id. */

export interface JiraServerInfo {
  baseUrl?: string;
  version: string;
  versionNumbers?: number[];
  deploymentType?: string;
  buildNumber?: number;
  serverTitle?: string;
}

export interface JiraUser {
  /** Username (DC keys users by name, not accountId). */
  name: string;
  key?: string;
  displayName: string;
  emailAddress?: string;
  active?: boolean;
}

export interface JiraNamed {
  id?: string;
  name: string;
}

export interface JiraOption {
  id?: string;
  value: string;
  child?: JiraOption;
}

export interface JiraStatus extends JiraNamed {
  statusCategory?: { key: string; name: string };
}

export interface JiraProjectRef {
  id?: string;
  key: string;
  name?: string;
}

export interface JiraFieldSchema {
  type: string;
  items?: string;
  system?: string;
  custom?: string;
  customId?: number;
}

export interface JiraComment {
  id: string;
  body: string;
  author?: JiraUser;
  updateAuthor?: JiraUser;
  created: string;
  updated?: string;
  self?: string;
}

export interface JiraCommentPage {
  incomplete?: boolean;
  comments: JiraComment[];
  total: number;
  startAt: number;
  maxResults: number;
}

export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Absolute URL under `/secure/attachment/…`, outside the REST path. */
  content: string;
  created?: string;
  author?: JiraUser;
  thumbnail?: string;
}

export interface JiraLinkType {
  id: string;
  name: string;
  inward: string;
  outward: string;
}

export interface JiraLinkedIssue {
  id: string;
  key: string;
  fields?: { summary?: string; status?: JiraStatus; issuetype?: JiraNamed; priority?: JiraNamed };
}

export interface JiraRawIssueLink {
  id: string;
  type: JiraLinkType;
  inwardIssue?: JiraLinkedIssue;
  outwardIssue?: JiraLinkedIssue;
}

/** Normalised link as seen from one issue. */
export interface JiraIssueLink {
  id: string;
  typeName: string;
  direction: 'outward' | 'inward';
  /** `type.outward` or `type.inward`, e.g. "blocks" / "is blocked by". */
  description: string;
  otherKey: string;
  otherSummary?: string;
  otherStatus?: string;
}

export interface JiraIssueFields {
  summary?: string;
  description?: string | null;
  issuetype?: JiraNamed & { subtask?: boolean };
  priority?: JiraNamed | null;
  status?: JiraStatus;
  assignee?: JiraUser | null;
  reporter?: JiraUser | null;
  labels?: string[];
  components?: JiraNamed[];
  fixVersions?: JiraNamed[];
  versions?: JiraNamed[];
  resolution?: JiraNamed | null;
  created?: string;
  updated?: string;
  resolutiondate?: string | null;
  duedate?: string | null;
  comment?: JiraCommentPage;
  attachment?: JiraAttachment[];
  issuelinks?: JiraRawIssueLink[];
  project?: JiraProjectRef;
  parent?: { id: string; key: string };
}

export interface JiraChangeItem {
  /** Display name (`status`, `Team`); `fieldId` (Jira 8.3+) is what maps a custom field to its alias. */
  field: string;
  fieldtype?: string;
  fieldId?: string;
  from: string | null;
  fromString: string | null;
  to: string | null;
  /** Jira's wire name. Read it as `item.toString` and map it at once; never destructure it. */
  toString: string | null;
}

export interface JiraHistory {
  id: string;
  author?: JiraUser;
  created: string;
  items: JiraChangeItem[];
}

/** From `expand=changelog`; `total` above `histories.length` means Jira cut the oldest entries. */
export interface JiraChangelog {
  startAt: number;
  maxResults: number;
  total: number;
  histories: JiraHistory[];
}

export interface JiraChangelogResult {
  key: string;
  summary: string;
  status: string;
  histories: JiraHistory[];
  total: number;
  truncated: boolean;
}

export interface JiraIssue {
  id: string;
  key: string;
  self?: string;
  fields: JiraIssueFields & Record<string, unknown>;
  /** From `expand=names`: field id -> display name. */
  names?: Record<string, string>;
  /** From `expand=schema`: field id -> schema. */
  schema?: Record<string, JiraFieldSchema>;
  /** From `expand=changelog`. */
  changelog?: JiraChangelog;
}

export interface JiraSearchPage {
  issues: JiraIssue[];
  total: number;
  startAt: number;
  maxResults: number;
  /** From `expand=names` / `expand=schema` on a search: page-level, shared by every issue. */
  names?: Record<string, string>;
  schema?: Record<string, JiraFieldSchema>;
}

export interface JiraFieldMeta {
  fieldId: string;
  name: string;
  required: boolean;
  schema: JiraFieldSchema;
  allowedValues?: Array<JiraNamed | JiraOption | { key: string; name?: string }>;
  hasDefaultValue?: boolean;
  defaultValue?: unknown;
  operations?: string[];
  autoCompleteUrl?: string;
}

export type JiraFieldMetaMap = Record<string, JiraFieldMeta>;

export interface JiraIssueTypeMeta {
  id: string;
  name: string;
  subtask: boolean;
  fields: JiraFieldMetaMap;
}

export type CreatemetaMode = 'paginated' | 'legacy' | 'unknown';

export interface JiraCreateMeta {
  project: JiraProjectRef;
  issueTypes: JiraIssueTypeMeta[];
  mode: Exclude<CreatemetaMode, 'unknown'>;
}

/** Issue types a project accepts, without field metadata: the cheap probe `doctor` relies on. */
export interface JiraIssueTypeList {
  project: JiraProjectRef;
  issueTypes: Array<Pick<JiraIssueTypeMeta, 'id' | 'name' | 'subtask'>>;
  mode: Exclude<CreatemetaMode, 'unknown'>;
}

export interface JiraFieldDef {
  id: string;
  name: string;
  custom: boolean;
  schema?: JiraFieldSchema;
  clauseNames?: string[];
}

export interface JiraTransition {
  id: string;
  name: string;
  to: JiraStatus;
  fields: JiraFieldMetaMap;
  hasScreen: boolean;
}

export type DownloadResult =
  | { status: 'saved' | 'unchanged'; path?: string; bytes: number; mimeType: string }
  | { status: 'skipped'; reason: 'size'; size: number; maxBytes: number };
