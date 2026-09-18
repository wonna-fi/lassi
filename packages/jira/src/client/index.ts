import { readComments, type CommentRead } from './comments.js';
import type { Writable } from 'node:stream';
import {
  LassiError,
  createHttpClient,
  isLassiError,
  saveStream,
  type HttpClient,
  type HttpClientOptions,
  type Logger,
} from '@wonna/lassi-core';
import { assertIssueKey } from './keys.js';
import { normalizeLinks } from './links.js';
import { CreatemetaResolver, editmeta, listFields, withIds } from './meta.js';
import type {
  CreatemetaMode,
  DownloadResult,
  JiraAttachment,
  JiraChangelogResult,
  JiraComment,
  JiraCommentPage,
  JiraCreateMeta,
  JiraIssueTypeList,
  JiraFieldDef,
  JiraFieldMeta,
  JiraFieldMetaMap,
  JiraIssue,
  JiraIssueLink,
  JiraLinkType,
  JiraSearchPage,
  JiraServerInfo,
  JiraStatus,
  JiraTransition,
  JiraUser,
} from './types.js';

export type JiraClientOptions =
  | ({ baseUrl: string; token: string; logger?: Logger } & Pick<
      HttpClientOptions,
      'fetch' | 'timeoutMs' | 'retry' | 'random' | 'sleep' | 'now'
    >)
  | { baseUrl: string; http: HttpClient };

export interface SearchRequest {
  jql: string;
  startAt?: number;
  maxResults?: number;
  fields?: string[];
  expand?: string[];
}

export interface SearchAllRequest {
  jql: string;
  fields?: string[];
  expand?: string[];
  pageSize?: number;
  cap?: number;
}

export interface SearchAllResult {
  issues: JiraIssue[];
  total: number;
  truncated: boolean;
}

export interface JiraClient {
  readonly baseUrl: string;
  readonly http: HttpClient;
  browseUrl(key: string): string;
  serverInfo(): Promise<JiraServerInfo>;
  myself(): Promise<JiraUser>;

  getIssue(key: string, opts?: { fields?: string[]; expand?: string[] }): Promise<JiraIssue>;
  /** Field history via `expand=changelog`; `truncated` when Jira cut the oldest entries. */
  changelog(key: string): Promise<JiraChangelogResult>;
  search(req: SearchRequest): Promise<JiraSearchPage>;
  /** One page at a time up to `cap`, so a bulk export never holds every issue in memory. */
  searchPages(
    req: SearchAllRequest
  ): AsyncGenerator<JiraSearchPage, { total: number; truncated: boolean }>;
  searchAll(
    req: SearchAllRequest,
    onPage?: (page: JiraSearchPage) => void
  ): Promise<SearchAllResult>;
  /** `meta` only feeds the error hints (which createmeta command to run). */
  createIssue(
    fields: Record<string, unknown>,
    meta?: { project?: string; issueType?: string }
  ): Promise<{ id: string; key: string; self?: string }>;
  updateIssue(
    key: string,
    body: { fields?: Record<string, unknown>; update?: Record<string, unknown[]> }
  ): Promise<void>;

  createmeta(project: string, issueType?: string): Promise<JiraCreateMeta>;
  /** Issue types only; one cheap request where `createmeta` costs one per type. */
  issueTypes(project: string): Promise<JiraIssueTypeList>;
  createmetaMode(): CreatemetaMode;
  editmeta(key: string): Promise<JiraFieldMetaMap>;
  fields(): Promise<JiraFieldDef[]>;

  listComments(
    key: string,
    opts?: { limit?: number; startAt?: number; newest?: boolean }
  ): Promise<JiraCommentPage>;
  readComments(key: string, requested?: number | 'all'): Promise<CommentRead>;
  getComment(key: string, id: string): Promise<JiraComment>;
  addComment(key: string, body: string): Promise<JiraComment>;
  editComment(key: string, id: string, body: string): Promise<JiraComment>;
  deleteComment(key: string, id: string): Promise<void>;

  listTransitions(key: string): Promise<JiraTransition[]>;
  doTransition(
    key: string,
    req: { id: string; fields?: Record<string, unknown>; commentBody?: string }
  ): Promise<void>;

  listAttachments(key: string): Promise<JiraAttachment[]>;
  downloadAttachment(
    att: JiraAttachment,
    dest: string | Writable,
    opts: { maxBytes: number; signal?: AbortSignal; preserveExisting?: boolean }
  ): Promise<DownloadResult>;
  uploadAttachment(
    key: string,
    file: { data: Blob | Uint8Array | string; filename: string; contentType?: string }
  ): Promise<JiraAttachment[]>;

  getLinkTypes(): Promise<JiraLinkType[]>;
  listLinks(key: string): Promise<JiraIssueLink[]>;
  createLink(req: { typeName: string; outwardKey: string; inwardKey: string }): Promise<void>;

  getUser(username: string): Promise<JiraUser>;
  /** Unknown usernames (404) are returned, never thrown; other failures propagate. */
  validateMentions(usernames: string[]): Promise<{ known: string[]; unknown: string[] }>;
}

const SEARCH_PAGE = 100;
const SEARCH_CAP = 5000;

interface RawTransition {
  id: string;
  name: string;
  to: JiraStatus;
  fields?: Record<string, Omit<JiraFieldMeta, 'fieldId'> & { fieldId?: string }>;
  hasScreen?: boolean;
}

export function createJiraClient(opts: JiraClientOptions): JiraClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const http = 'http' in opts ? opts.http : createHttpClient({ ...opts, baseUrl, product: 'jira' });
  const createmeta = new CreatemetaResolver(http);
  const userCache = new Map<string, JiraUser | null>();
  const issuePath = (key: string): string =>
    `/rest/api/2/issue/${encodeURIComponent(assertIssueKey(key))}`;

  const client: JiraClient = {
    baseUrl,
    http,
    browseUrl: (key) => `${baseUrl}/browse/${key}`,
    serverInfo: () => http.get<JiraServerInfo>('/rest/api/2/serverInfo'),
    // Not memoised: a CLI run builds a fresh client and asks once, so the cache never paid for
    // itself, and a long-lived client (a daemon or a scheduled job) would keep serving an
    // identity that a rename or a re-issued credential had already changed.
    myself: () => http.get<JiraUser>('/rest/api/2/myself'),

    async getIssue(key, o = {}) {
      return http.get<JiraIssue>(issuePath(key), {
        query: {
          fields: (o.fields ?? ['*all']).join(','),
          expand: (o.expand ?? ['names', 'schema']).join(','),
        },
        context: { product: 'jira', issueKey: key },
      });
    },

    async changelog(key) {
      const issue = await client.getIssue(key, {
        fields: ['summary', 'status'],
        expand: ['changelog'],
      });
      const log = issue.changelog ?? { startAt: 0, maxResults: 0, total: 0, histories: [] };
      return {
        key: issue.key,
        summary: issue.fields.summary ?? '',
        status: issue.fields.status?.name ?? '',
        histories: log.histories,
        total: log.total,
        truncated: log.total > log.histories.length,
      };
    },

    search(req) {
      return http.post<JiraSearchPage>(
        '/rest/api/2/search',
        {
          jql: req.jql,
          startAt: req.startAt ?? 0,
          maxResults: req.maxResults ?? 50,
          ...(req.fields ? { fields: req.fields } : {}),
          ...(req.expand ? { expand: req.expand } : {}),
        },
        { context: { product: 'jira', operation: 'search' }, idempotent: true }
      );
    },

    async *searchPages(req) {
      const pageSize = req.pageSize ?? SEARCH_PAGE;
      const cap = req.cap ?? SEARCH_CAP;
      let startAt = 0;
      let seen = 0;
      for (;;) {
        const page = await client.search({
          jql: req.jql,
          startAt,
          maxResults: Math.min(pageSize, cap - seen),
          ...(req.fields ? { fields: req.fields } : {}),
          ...(req.expand ? { expand: req.expand } : {}),
        });
        yield page;
        seen += page.issues.length;
        startAt += page.issues.length;
        if (page.issues.length === 0 || startAt >= page.total) {
          return { total: page.total, truncated: false };
        }
        if (seen >= cap) return { total: page.total, truncated: true };
      }
    },

    async searchAll(req, onPage) {
      const issues: JiraIssue[] = [];
      const pages = client.searchPages(req);
      for (;;) {
        const step = await pages.next();
        if (step.done) return { issues, ...step.value };
        onPage?.(step.value);
        issues.push(...step.value.issues);
      }
    },

    createIssue(fields, meta = {}) {
      return http.post<{ id: string; key: string; self?: string }>(
        '/rest/api/2/issue',
        { fields },
        {
          context: {
            product: 'jira',
            operation: 'create',
            ...(meta.project ? { project: meta.project } : {}),
            ...(meta.issueType ? { issueType: meta.issueType } : {}),
          },
        }
      );
    },

    async updateIssue(key, body) {
      await http.put(issuePath(key), body, {
        context: { product: 'jira', issueKey: key, operation: 'update' },
      });
    },

    createmeta: (project, issueType) => createmeta.resolve(project, issueType),
    issueTypes: (project) => createmeta.issueTypes(project),
    createmetaMode: () => createmeta.currentMode(),
    editmeta: async (key) => editmeta(http, assertIssueKey(key)),
    fields: () => listFields(http),

    async listComments(key, o = {}) {
      const page = await http.get<JiraCommentPage>(`${issuePath(key)}/comment`, {
        query: {
          startAt: o.startAt ?? 0,
          maxResults: o.limit ?? 50,
          orderBy: o.newest ? '-created' : 'created',
        },
        context: { product: 'jira', issueKey: key },
      });
      if (o.newest) page.comments = [...page.comments].reverse();
      return page;
    },
    readComments: (key, requested = 'all') =>
      readComments((opts) => client.listComments(key, opts), requested),
    getComment: async (key, id) =>
      http.get<JiraComment>(`${issuePath(key)}/comment/${encodeURIComponent(id)}`, {
        context: { product: 'jira', issueKey: key, operation: 'comment' },
      }),
    addComment: async (key, body) =>
      http.post<JiraComment>(
        `${issuePath(key)}/comment`,
        { body },
        { context: { product: 'jira', issueKey: key, operation: 'comment' } }
      ),
    editComment: async (key, id, body) =>
      http.put<JiraComment>(
        `${issuePath(key)}/comment/${encodeURIComponent(id)}`,
        { body },
        { context: { product: 'jira', issueKey: key, operation: 'comment' } }
      ),
    async deleteComment(key, id) {
      await http.delete(`${issuePath(key)}/comment/${encodeURIComponent(id)}`, {
        context: { product: 'jira', issueKey: key, operation: 'comment' },
      });
    },

    async listTransitions(key) {
      const raw = await http.get<{ transitions?: RawTransition[] }>(
        `${issuePath(key)}/transitions`,
        {
          query: { expand: 'transitions.fields' },
          context: { product: 'jira', issueKey: key, transition: true },
        }
      );
      return (raw?.transitions ?? []).map((t) => {
        const fields = withIds(t.fields);
        return {
          id: t.id,
          name: t.name,
          to: t.to,
          fields,
          hasScreen: t.hasScreen ?? Object.keys(fields).length > 0,
        };
      });
    },
    async doTransition(key, req) {
      await http.post(
        `${issuePath(key)}/transitions`,
        {
          transition: { id: req.id },
          ...(req.fields && Object.keys(req.fields).length > 0 ? { fields: req.fields } : {}),
          ...(req.commentBody ? { update: { comment: [{ add: { body: req.commentBody } }] } } : {}),
        },
        { context: { product: 'jira', issueKey: key, transition: true, operation: 'transition' } }
      );
    },

    async listAttachments(key) {
      const issue = await http.get<JiraIssue>(issuePath(key), {
        query: { fields: 'attachment' },
        context: { product: 'jira', issueKey: key },
      });
      return issue?.fields.attachment ?? [];
    },
    async downloadAttachment(att, dest, o) {
      if (att.size > o.maxBytes) {
        return { status: 'skipped', reason: 'size', size: att.size, maxBytes: o.maxBytes };
      }
      const res = await http.download(att.content, o.signal ? { signal: o.signal } : {});
      // The raw endpoint sometimes answers octet-stream; Jira's own metadata is the better label.
      const header = res.contentType;
      const mimeType = !header || header === 'application/octet-stream' ? att.mimeType : header;
      const { bytes, unchanged } = await saveStream(res.body, dest, {
        maxBytes: o.maxBytes,
        ...(o.preserveExisting ? { preserveExisting: true } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      });
      const status = unchanged ? 'unchanged' : 'saved';
      return typeof dest === 'string'
        ? { status, path: dest, bytes, mimeType }
        : { status, bytes, mimeType };
    },
    async uploadAttachment(key, file) {
      const result = await http.uploadMultipart<JiraAttachment[]>(
        `${issuePath(key)}/attachments`,
        [
          {
            field: 'file',
            data: file.data,
            filename: file.filename,
            ...(file.contentType ? { contentType: file.contentType } : {}),
          },
        ],
        { context: { product: 'jira', issueKey: key } }
      );
      return result ?? [];
    },

    async getLinkTypes() {
      const raw = await http.get<{ issueLinkTypes?: JiraLinkType[] }>('/rest/api/2/issueLinkType');
      return raw?.issueLinkTypes ?? [];
    },
    async listLinks(key) {
      const issue = await http.get<JiraIssue>(issuePath(key), {
        query: { fields: 'issuelinks' },
        context: { product: 'jira', issueKey: key },
      });
      return normalizeLinks(issue?.fields.issuelinks);
    },
    async createLink(req) {
      await http.post(
        '/rest/api/2/issueLink',
        {
          type: { name: req.typeName },
          outwardIssue: { key: assertIssueKey(req.outwardKey) },
          inwardIssue: { key: assertIssueKey(req.inwardKey) },
        },
        { context: { product: 'jira', operation: 'link' } }
      );
    },

    async getUser(username) {
      const user = await http.get<JiraUser>('/rest/api/2/user', {
        query: { username },
        context: { product: 'jira' },
      });
      if (!user) {
        throw new LassiError('not_found', `user ${username} not found`, {
          context: { product: 'jira' },
        });
      }
      return user;
    },
    async validateMentions(usernames) {
      const unique = [...new Set(usernames)];
      const pending = unique.filter((u) => !userCache.has(u));
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < pending.length) {
          const name = pending[cursor++] as string;
          try {
            userCache.set(name, await client.getUser(name));
          } catch (err) {
            if (isLassiError(err) && err.code === 'not_found') userCache.set(name, null);
            else throw err;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
      return {
        known: unique.filter((u) => Boolean(userCache.get(u))),
        unknown: unique.filter((u) => userCache.get(u) === null),
      };
    },
  };
  return client;
}
