export interface ConfluenceUser {
  type?: 'known' | 'anonymous' | 'unknown' | string;
  username?: string;
  userKey?: string;
  displayName?: string;
}

export interface ConfluenceVersion {
  number: number;
  when?: string;
  by?: ConfluenceUser;
  message?: string;
  minorEdit?: boolean;
}

export interface ConfluenceSpaceRef {
  key: string;
  name?: string;
}

export interface ConfluenceBody {
  storage?: { value: string; representation: string };
  view?: { value: string; representation: string };
}

export interface ConfluencePaged<T> {
  results: T[];
  start: number;
  limit: number;
  size: number;
  totalSize?: number;
  _links?: { next?: string };
}

/** `GET /rest/api/content/{id}` with the expands `getPage` asks for; other calls fill a subset. */
export interface ConfluenceContent {
  id: string;
  type: 'page' | 'comment' | 'attachment' | 'blogpost' | string;
  status?: string;
  title: string;
  space?: ConfluenceSpaceRef;
  version?: ConfluenceVersion;
  ancestors?: Array<{ id: string; title?: string }>;
  body?: ConfluenceBody;
  history?: {
    createdBy?: ConfluenceUser;
    createdDate?: string;
    lastUpdated?: { by?: ConfluenceUser; when?: string };
  };
  children?: {
    page?: ConfluencePaged<ConfluenceContent>;
    comment?: ConfluencePaged<ConfluenceContent>;
    attachment?: ConfluencePaged<ConfluenceContent>;
  };
  container?: { id: string; type: string };
  extensions?: { location?: string; fileSize?: number; mediaType?: string; comment?: string };
  metadata?: { mediaType?: string; comment?: string };
  _links?: { webui?: string; download?: string; self?: string; base?: string };
}

export type ChildKind = 'children' | 'comments' | 'attachments';

export interface PageCounts {
  children: number;
  comments: number;
  attachments: number;
  /** The counts that are floors rather than totals, because that walk stopped at its cap. */
  truncated?: ChildKind[];
}

export interface ConfluencePage extends ConfluenceContent {
  counts: PageCounts;
}

export interface ConfluenceAttachment {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
  /** `_links.download`, relative to the instance base URL. */
  downloadPath: string;
  version?: number;
  comment?: string;
}

export interface ConfluenceComment {
  id: string;
  storage: string;
  author?: ConfluenceUser;
  created?: string;
  version?: number;
}

export interface ConfluenceSearchPage {
  results: ConfluenceContent[];
  start: number;
  limit: number;
  size: number;
  totalSize?: number;
  next: boolean;
  /** `start` of the server's own next link; permission filtering makes `size` a wrong step. */
  nextStart?: number;
}

export interface TreeNode {
  id: string;
  title: string;
  children: TreeNode[];
}

/** `'nodes'` is the whole tree's `maxNodes`; `'children'` is one parent's own cap. */
export type TreeTruncation = 'nodes' | 'children';

export interface TreeResult {
  root: TreeNode;
  /**
   * Which caps stopped the walk; empty when the tree is complete. Both can fire on one walk, and
   * they read differently: raising `maxNodes` does nothing about a parent with too many children,
   * so a caller that hears only about the node cap is told the wrong thing to change.
   */
  truncated: TreeTruncation[];
}

export interface SystemInfo {
  version?: string;
  source: 'systemInfo' | 'manifest' | 'space-probe';
}

export type DownloadResult =
  | { status: 'saved'; path?: string; bytes: number; mimeType: string }
  | { status: 'skipped'; reason: 'size'; size: number; maxBytes: number };

export type PageRef = { kind: 'id'; id: string } | { kind: 'title'; space: string; title: string };
