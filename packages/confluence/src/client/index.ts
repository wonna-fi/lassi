import type { Writable } from 'node:stream';
import {
  LassiError,
  createHttpClient,
  isLassiError,
  quoteLiteral,
  saveStream,
  type HttpClient,
  type HttpClientOptions,
  type Logger,
} from '@wonna/lassi-core';
import { userDirectory, type UserDirectory } from '../convert/users.js';
import { parsePageRef } from './refs.js';
import type {
  ConfluenceAttachment,
  ConfluenceComment,
  ConfluenceContent,
  ConfluencePage,
  ConfluencePaged,
  ConfluenceSearchPage,
  ConfluenceUser,
  DownloadResult,
  PageCounts,
  SystemInfo,
  ChildKind,
  TreeNode,
  TreeResult,
  TreeTruncation,
} from './types.js';

export type ConfluenceClientOptions =
  | ({ baseUrl: string; token: string; logger?: Logger; downloadUrlSuffix?: string } & Pick<
      HttpClientOptions,
      'fetch' | 'timeoutMs' | 'retry' | 'random' | 'sleep' | 'now'
    >)
  | { baseUrl: string; http: HttpClient; downloadUrlSuffix?: string };

export interface SearchOptions {
  start?: number;
  limit?: number;
  expand?: string[];
}

export interface SearchIterOptions {
  pageSize?: number;
  /** Hard cap on results walked. */
  max?: number;
  expand?: string[];
}

export interface ConfluenceClient {
  readonly baseUrl: string;
  readonly http: HttpClient;
  pageUrl(id: string): string;
  currentUser(): Promise<ConfluenceUser>;
  systemInfo(): Promise<SystemInfo>;
  getContent(id: string, expand: string[]): Promise<ConfluenceContent>;
  /** Page with storage body, version, space, ancestors and exact child counts. */
  getPage(id: string): Promise<ConfluencePage>;
  findPageByTitle(space: string, title: string): Promise<ConfluencePage>;
  resolvePageRef(ref: string, defaultSpace?: string): Promise<ConfluencePage>;
  search(cql: string, opts?: SearchOptions): Promise<ConfluenceSearchPage>;
  searchIter(
    cql: string,
    opts?: SearchIterOptions
  ): AsyncGenerator<ConfluenceContent, { truncated: boolean; total?: number }>;
  searchAll(
    cql: string,
    opts?: SearchIterOptions
  ): Promise<{ results: ConfluenceContent[]; total?: number; truncated: boolean }>;
  /** `truncated` when the walk stopped at its cap, so the list is a prefix of the children. */
  children(
    id: string,
    kind: 'page' | 'attachment' | 'comment'
  ): Promise<{ items: ConfluenceContent[]; truncated: boolean }>;
  tree(
    root: { pageId: string } | { spaceKey: string },
    opts?: { depth?: number; maxNodes?: number }
  ): Promise<TreeResult>;
  createPage(input: {
    space: string;
    title: string;
    parentId?: string;
    storage: string;
  }): Promise<ConfluenceContent>;
  updatePage(
    id: string,
    input: { title: string; currentVersion: number; storage?: string; parentId?: string }
  ): Promise<ConfluenceContent>;
  /** `truncated` when the walk stopped at its cap, so the list is a prefix of the comments. */
  listComments(pageId: string): Promise<{ items: ConfluenceComment[]; truncated: boolean }>;
  createComment(pageId: string, storage: string): Promise<ConfluenceContent>;
  getComment(id: string): Promise<ConfluenceContent>;
  deleteComment(id: string): Promise<void>;
  /** `truncated` when the walk stopped at its cap, so the list is a prefix of the attachments. */
  listAttachments(pageId: string): Promise<{ items: ConfluenceAttachment[]; truncated: boolean }>;
  downloadAttachment(
    att: ConfluenceAttachment,
    dest: string | Writable,
    opts: { maxBytes: number; signal?: AbortSignal }
  ): Promise<DownloadResult>;
  /** `POST /rest/api/contentbody/convert/{to}`; a 400 is the server's parse error. */
  convertBody(value: string, from?: 'storage' | 'view', to?: 'storage' | 'view'): Promise<string>;
  getUser(username: string): Promise<ConfluenceUser>;
  getUserByKey(key: string): Promise<ConfluenceUser>;
  /** Unknown usernames (404) are returned, never thrown; known ones map to their user key. */
  validateMentions(usernames: string[]): Promise<{ known: Map<string, string>; unknown: string[] }>;
  /** Directory for the reader; unresolved keys are simply absent (reads never fail on users). */
  resolveUserKeys(keys: string[]): Promise<UserDirectory>;
}

const PAGE_EXPAND = [
  'body.storage',
  'version',
  'space',
  'ancestors',
  'history.lastUpdated',
  'children.page',
  'children.comment',
  'children.attachment',
];
const SEARCH_EXPAND = ['space', 'version', 'history.lastUpdated'];
const COMMENT_EXPAND = ['body.storage', 'history', 'version'];
const CHILD_PAGE_SIZE = 200;
const CHILD_CAP = 1000;
const SEARCH_PAGE = 50;
const SEARCH_CAP = 5000;

/** `applinks/1.0/manifest` answers XML or JSON depending on the instance. */
export function parseManifestVersion(text: string): string | undefined {
  try {
    const json = JSON.parse(text) as { version?: unknown };
    if (typeof json.version === 'string' && json.version.length > 0) return json.version;
  } catch {
    // XML
  }
  const m = /<version>([^<]+)<\/version>/.exec(text);
  return m?.[1]?.trim() || undefined;
}

function isAnonymous(user: ConfluenceUser): boolean {
  return user.type === 'anonymous' || (!user.username && !user.userKey);
}

export function createConfluenceClient(opts: ConfluenceClientOptions): ConfluenceClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const http =
    'http' in opts ? opts.http : createHttpClient({ ...opts, baseUrl, product: 'confluence' });
  const suffix = opts.downloadUrlSuffix?.replace(/^[?&]/, '');
  const userByName = new Map<string, ConfluenceUser | null>();
  const userByKey = new Map<string, ConfluenceUser | null>();

  const context = (extra: Record<string, unknown> = {}) => ({
    product: 'confluence' as const,
    ...extra,
  });

  /**
   * Confluence pages by position in the unfiltered result set, so a page trimmed by permissions
   * comes back shorter than the limit while more results follow: stepping by the number of rows
   * received would re-read rows the server already skipped past. The next link carries the truth.
   */
  function nextStartOf(link: string | undefined, from: number, limit: number): number | undefined {
    if (link === undefined) return undefined;
    const m = /[?&]start=(\d+)/.exec(link);
    const parsed = m ? Number(m[1]) : Number.NaN;
    return Number.isFinite(parsed) && parsed > from ? parsed : from + limit;
  }

  /** `truncated` when the walk stopped at `CHILD_CAP`: the list is a prefix, not the whole set. */
  async function walkChildren(
    id: string,
    kind: 'page' | 'attachment' | 'comment',
    expand: string[] = []
  ): Promise<{ items: ConfluenceContent[]; truncated: boolean }> {
    const items: ConfluenceContent[] = [];
    let start = 0;
    let truncated = false;
    for (;;) {
      const page = await http.get<ConfluencePaged<ConfluenceContent>>(
        `/rest/api/content/${encodeURIComponent(id)}/child/${kind}`,
        {
          query: {
            start,
            limit: CHILD_PAGE_SIZE,
            ...(kind === 'comment' ? { location: 'footer', depth: 'all' } : {}),
            ...(expand.length > 0 ? { expand: expand.join(',') } : {}),
          },
          context: context({ pageId: id }),
        }
      );
      const results = page?.results ?? [];
      items.push(...results);
      const next = nextStartOf(page?._links?.next, start, CHILD_PAGE_SIZE);
      if (next === undefined) break;
      if (items.length >= CHILD_CAP) {
        truncated = true;
        break;
      }
      start = next;
    }
    return { items, truncated };
  }

  async function countsOf(content: ConfluenceContent): Promise<PageCounts> {
    const count = async (
      kind: 'page' | 'comment' | 'attachment'
    ): Promise<{ n: number; truncated: boolean }> => {
      const paged = content.children?.[kind];
      if (!paged) return { n: 0, truncated: false };
      // `size === limit` means the expand was cut off; only then walk the children.
      if (paged.size < paged.limit) return { n: paged.size, truncated: false };
      const walked = await walkChildren(content.id, kind);
      return { n: walked.items.length, truncated: walked.truncated };
    };
    const [children, comments, attachments] = await Promise.all([
      count('page'),
      count('comment'),
      count('attachment'),
    ]);
    // Per kind, not one flag for all three: 1001 child pages next to two comments must not make
    // the trailer say "2+ comments". Absent entirely when nothing was capped, so an ordinary page's
    // frontmatter is unchanged.
    const truncated: ChildKind[] = (
      [
        ['children', children],
        ['comments', comments],
        ['attachments', attachments],
      ] as const
    )
      .filter(([, walked]) => walked.truncated)
      .map(([kind]) => kind);
    return {
      children: children.n,
      comments: comments.n,
      attachments: attachments.n,
      ...(truncated.length > 0 ? { truncated } : {}),
    };
  }

  async function withCounts(content: ConfluenceContent): Promise<ConfluencePage> {
    return { ...content, counts: await countsOf(content) };
  }

  const client: ConfluenceClient = {
    baseUrl,
    http,
    pageUrl: (id) => `${baseUrl}/pages/viewpage.action?pageId=${encodeURIComponent(id)}`,

    async currentUser() {
      const user = await http.get<ConfluenceUser>('/rest/api/user/current', {
        context: context(),
      });
      if (!user || isAnonymous(user)) {
        throw new LassiError(
          'auth',
          'Confluence answered anonymously; the token was not accepted',
          {
            context: context(),
          }
        );
      }
      return user;
    },

    async systemInfo() {
      // 401 means the token was rejected everywhere; 403 is the admin-only endpoint the fallback
      // chain exists for.
      const rethrowAuth = (err: unknown): void => {
        if (isLassiError(err) && err.code === 'auth' && err.http === 401) throw err;
      };
      try {
        const info = await http.get<{ version?: string }>('/rest/api/settings/systemInfo');
        if (info?.version) return { version: info.version, source: 'systemInfo' };
      } catch (err) {
        rethrowAuth(err);
      }
      try {
        const version = parseManifestVersion(await http.getText('/rest/applinks/1.0/manifest'));
        if (version) return { version, source: 'manifest' };
      } catch (err) {
        rethrowAuth(err);
      }
      await http.get('/rest/api/space', { query: { limit: 1 } });
      return { source: 'space-probe' };
    },

    getContent: (id, expand) =>
      http.get<ConfluenceContent>(`/rest/api/content/${encodeURIComponent(id)}`, {
        query: expand.length > 0 ? { expand: expand.join(',') } : {},
        context: context({ pageId: id }),
      }),

    async getPage(id) {
      return withCounts(await client.getContent(id, PAGE_EXPAND));
    },

    async findPageByTitle(space, title) {
      const page = await http.get<ConfluencePaged<ConfluenceContent>>('/rest/api/content', {
        query: { spaceKey: space, title, type: 'page', expand: PAGE_EXPAND.join(',') },
        context: context({ pageId: `${space}:${title}` }),
      });
      const first = page?.results[0];
      if (!first) {
        throw new LassiError('not_found', `no page titled "${title}" in space ${space}`, {
          hint: `run \`lassi confluence search 'space = ${quoteLiteral(space)} and title ~ ${quoteLiteral(title)}'\` to look it up`,
          context: context({ pageId: `${space}:${title}` }),
        });
      }
      return withCounts(first);
    },

    resolvePageRef(ref, defaultSpace) {
      const parsed = parsePageRef(ref, defaultSpace);
      return parsed.kind === 'id'
        ? client.getPage(parsed.id)
        : client.findPageByTitle(parsed.space, parsed.title);
    },

    async search(cql, o = {}) {
      const limit = o.limit ?? SEARCH_PAGE;
      const page = await http.get<ConfluencePaged<ConfluenceContent>>('/rest/api/content/search', {
        query: {
          cql,
          start: o.start ?? 0,
          limit,
          expand: (o.expand ?? SEARCH_EXPAND).join(','),
        },
        context: context({ operation: 'search' }),
      });
      const results = page?.results ?? [];
      return {
        results,
        start: page?.start ?? o.start ?? 0,
        limit: page?.limit ?? limit,
        size: page?.size ?? results.length,
        ...(page?.totalSize === undefined ? {} : { totalSize: page.totalSize }),
        next: Boolean(page?._links?.next),
        ...(nextStartOf(page?._links?.next, o.start ?? 0, limit) === undefined
          ? {}
          : { nextStart: nextStartOf(page?._links?.next, o.start ?? 0, limit) as number }),
      };
    },

    async *searchIter(cql, o = {}) {
      const pageSize = o.pageSize ?? SEARCH_PAGE;
      const max = o.max ?? SEARCH_CAP;
      let start = 0;
      let seen = 0;
      let total: number | undefined;
      for (;;) {
        const page = await client.search(cql, {
          start,
          limit: Math.min(pageSize, max - seen),
          ...(o.expand ? { expand: o.expand } : {}),
        });
        total = page.totalSize ?? total;
        for (const item of page.results) {
          yield item;
          seen += 1;
        }
        if (!page.next) return { truncated: false, ...(total === undefined ? {} : { total }) };
        if (seen >= max) return { truncated: true, ...(total === undefined ? {} : { total }) };
        start = page.nextStart ?? start + Math.max(page.size, 1);
      }
    },

    async searchAll(cql, o = {}) {
      const results: ConfluenceContent[] = [];
      const iterator = client.searchIter(cql, o);
      for (;;) {
        const step = await iterator.next();
        if (step.done)
          return {
            results,
            truncated: step.value.truncated,
            ...(step.value.total === undefined ? {} : { total: step.value.total }),
          };
        results.push(step.value);
      }
    },

    children: (id, kind) => walkChildren(id, kind),

    async tree(root, o = {}) {
      const depth = o.depth ?? 3;
      const maxNodes = o.maxNodes ?? 2000;
      let rootContent: ConfluenceContent;
      if ('pageId' in root) {
        rootContent = await client.getContent(root.pageId, []);
      } else {
        const space = await http.get<{ homepage?: ConfluenceContent }>(
          `/rest/api/space/${encodeURIComponent(root.spaceKey)}`,
          { query: { expand: 'homepage' }, context: context() }
        );
        if (!space?.homepage) {
          throw new LassiError('not_found', `space ${root.spaceKey} has no homepage`, {
            context: context(),
          });
        }
        rootContent = space.homepage;
      }
      const node: TreeNode = { id: rootContent.id, title: rootContent.title, children: [] };
      let count = 1;
      // Both caps can fire on one walk, and they read differently, so both travel with the result.
      const truncated = new Set<TreeTruncation>();
      const queue: Array<{ node: TreeNode; level: number }> = [{ node, level: 0 }];
      while (queue.length > 0) {
        const { node: current, level } = queue.shift() as { node: TreeNode; level: number };
        if (level >= depth) continue;
        const walked = await walkChildren(current.id, 'page');
        // A capped child list is a truncated tree just as much as one that hit `maxNodes`.
        if (walked.truncated) truncated.add('children');
        for (const child of walked.items) {
          if (count >= maxNodes) {
            truncated.add('nodes');
            break;
          }
          const childNode: TreeNode = { id: child.id, title: child.title, children: [] };
          current.children.push(childNode);
          count += 1;
          queue.push({ node: childNode, level: level + 1 });
        }
        // The budget can fill exactly on the last child the walk returned. There are more children
        // either way when that walk was capped, and none of them fits, so the node cap is a live
        // cause too — raising only the child cap would run straight into it.
        if (walked.truncated && count >= maxNodes) truncated.add('nodes');
        if (truncated.has('nodes')) break;
      }
      return { root: node, truncated: [...truncated] };
    },

    createPage(input) {
      return http.post<ConfluenceContent>(
        '/rest/api/content',
        {
          type: 'page',
          title: input.title,
          space: { key: input.space },
          ...(input.parentId ? { ancestors: [{ id: input.parentId }] } : {}),
          body: { storage: { value: input.storage, representation: 'storage' } },
        },
        { context: context({ operation: 'create' }) }
      );
    },

    updatePage(id, input) {
      return http.put<ConfluenceContent>(
        `/rest/api/content/${encodeURIComponent(id)}`,
        {
          id,
          type: 'page',
          title: input.title,
          version: { number: input.currentVersion + 1 },
          ...(input.parentId ? { ancestors: [{ id: input.parentId }] } : {}),
          ...(input.storage === undefined
            ? {}
            : { body: { storage: { value: input.storage, representation: 'storage' } } }),
        },
        {
          context: context({
            pageId: id,
            versionFrom: input.currentVersion,
            versionTo: input.currentVersion + 1,
            operation: 'update',
          }),
        }
      );
    },

    async listComments(pageId) {
      const { items, truncated } = await walkChildren(pageId, 'comment', COMMENT_EXPAND);
      const comments = items.map((c) => {
        const comment: ConfluenceComment = { id: c.id, storage: c.body?.storage?.value ?? '' };
        if (c.history?.createdBy) comment.author = c.history.createdBy;
        if (c.history?.createdDate) comment.created = c.history.createdDate;
        if (c.version?.number !== undefined) comment.version = c.version.number;
        return comment;
      });
      return { items: comments, truncated };
    },

    createComment(pageId, storage) {
      return http.post<ConfluenceContent>(
        '/rest/api/content',
        {
          type: 'comment',
          container: { id: pageId, type: 'page' },
          body: { storage: { value: storage, representation: 'storage' } },
        },
        { context: context({ pageId, operation: 'comment' }) }
      );
    },

    getComment: (id) =>
      http.get<ConfluenceContent>(`/rest/api/content/${encodeURIComponent(id)}`, {
        query: { expand: 'history,container,version' },
        context: context({ operation: 'comment' }),
      }),

    async deleteComment(id) {
      await http.delete(`/rest/api/content/${encodeURIComponent(id)}`, {
        context: context({ operation: 'comment' }),
      });
    },

    async listAttachments(pageId) {
      const { items, truncated } = await walkChildren(pageId, 'attachment', [
        'version',
        'metadata',
      ]);
      const attachments = items.map((a) => {
        const att: ConfluenceAttachment = {
          id: a.id,
          filename: a.title,
          mediaType: a.metadata?.mediaType ?? a.extensions?.mediaType ?? '',
          size: a.extensions?.fileSize ?? 0,
          downloadPath: a._links?.download ?? '',
        };
        if (a.version?.number !== undefined) att.version = a.version.number;
        const comment = a.metadata?.comment ?? a.extensions?.comment;
        if (comment) att.comment = comment;
        return att;
      });
      return { items: attachments, truncated };
    },

    async downloadAttachment(att, dest, o) {
      if (att.size > o.maxBytes) {
        return { status: 'skipped', reason: 'size', size: att.size, maxBytes: o.maxBytes };
      }
      let url = `${baseUrl}${att.downloadPath.startsWith('/') ? '' : '/'}${att.downloadPath}`;
      if (suffix) url += `${url.includes('?') ? '&' : '?'}${suffix}`;
      const res = await http.download(url, o.signal ? { signal: o.signal } : {});
      const header = res.contentType?.split(';')[0]?.trim();
      // A login or error page instead of the file is the known `_links.download` pitfall.
      if (header === 'text/html' && !att.mediaType.startsWith('text/html')) {
        throw new LassiError(
          'http',
          `download of ${att.filename} returned an HTML page instead of the file`,
          {
            hint: 'the instance may need a query suffix on _links.download; set confluence.downloadUrlSuffix (for example "download=true") in ~/.lassi.json',
            context: context(),
          }
        );
      }
      const mimeType = !header || header === 'application/octet-stream' ? att.mediaType : header;
      const { bytes } = await saveStream(res.body, dest, {
        maxBytes: o.maxBytes,
        ...(o.signal ? { signal: o.signal } : {}),
      });
      return typeof dest === 'string'
        ? { status: 'saved', path: dest, bytes, mimeType }
        : { status: 'saved', bytes, mimeType };
    },

    async convertBody(value, from = 'storage', to = 'view') {
      const result = await http.post<{ value?: string }>(
        `/rest/api/contentbody/convert/${to}`,
        { value, representation: from },
        { context: context({ operation: 'other' }) }
      );
      // A 200 that is not the documented `{ value }` is an SSO login page or a proxy notice, not
      // a successful conversion; reporting it as valid would make `page validate` say yes to junk.
      if (typeof result?.value !== 'string') {
        throw new LassiError(
          'http',
          `the ${to} conversion endpoint answered without a body; the response was not the expected JSON`,
          {
            hint: 'the instance may have answered with an SSO login page; check the URL and the token with `lassi doctor`',
            context: context({ operation: 'other' }),
          }
        );
      }
      return result.value;
    },

    async getUser(username) {
      // `has`, not a truthy check: a known-missing user is cached as `null`, and a truthy check
      // never saw it, so every lookup of the same missing name went back to the server.
      if (userByName.has(username)) {
        const cached = userByName.get(username);
        if (cached) return cached;
        throw new LassiError('not_found', `user ${username} not found`, { context: context() });
      }
      const user = await http.get<ConfluenceUser>('/rest/api/user', {
        query: { username },
        context: context(),
      });
      if (!user || isAnonymous(user)) {
        throw new LassiError('not_found', `user ${username} not found`, { context: context() });
      }
      userByName.set(username, user);
      if (user.userKey) userByKey.set(user.userKey, user);
      return user;
    },

    async getUserByKey(key) {
      if (userByKey.has(key)) {
        const cached = userByKey.get(key);
        if (cached) return cached;
        throw new LassiError('not_found', `user key ${key} not found`, { context: context() });
      }
      const user = await http.get<ConfluenceUser>('/rest/api/user', {
        query: { key },
        context: context(),
      });
      if (!user || isAnonymous(user)) {
        throw new LassiError('not_found', `user key ${key} not found`, { context: context() });
      }
      userByKey.set(key, user);
      if (user.username) userByName.set(user.username, user);
      return user;
    },

    async validateMentions(usernames) {
      const unique = [...new Set(usernames)];
      const pending = unique.filter((u) => !userByName.has(u));
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < pending.length) {
          const name = pending[cursor++] as string;
          try {
            await client.getUser(name);
          } catch (err) {
            if (isLassiError(err) && err.code === 'not_found') userByName.set(name, null);
            else throw err;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
      const known = new Map<string, string>();
      const unknown: string[] = [];
      for (const name of unique) {
        const user = userByName.get(name);
        // A user the directory knows but has no key for is still writable when the page's inferred
        // convention is `ri:username`, so "keyless" is not the same answer as "unknown". The writer
        // is where the key is needed and where its absence is refused.
        if (user?.userKey) known.set(name, user.userKey);
        else if (user) known.set(name, '');
        else unknown.push(name);
      }
      return { known, unknown };
    },

    async resolveUserKeys(keys) {
      const unique = [...new Set(keys)].filter((k) => !userByKey.has(k));
      let cursor = 0;
      const worker = async (): Promise<void> => {
        while (cursor < unique.length) {
          const key = unique[cursor++] as string;
          try {
            await client.getUserByKey(key);
          } catch (err) {
            if (isLassiError(err) && err.code === 'not_found') userByKey.set(key, null);
            else throw err;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, unique.length) }, worker));
      const entries: Array<{ userKey: string; username: string }> = [];
      for (const key of new Set(keys)) {
        const user = userByKey.get(key);
        if (user?.username) entries.push({ userKey: key, username: user.username });
      }
      return userDirectory(entries);
    },
  };
  return client;
}
