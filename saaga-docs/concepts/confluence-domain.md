---
title: Confluence Domain
type: concept
sources:
  - packages/core/src/config/schema.ts
  - packages/confluence/package.json
  - packages/confluence/src/index.ts
  - packages/confluence/src/client/*.ts
  - packages/confluence/src/page/*.ts
  - packages/confluence/src/stats/macros.ts
---

# Confluence Domain

## Business Definition

The Confluence domain represents Data Center pages and their related comments, attachments, users, hierarchy, and storage bodies. Lassi exposes these objects through one package-level client and uses page references to let callers address content by ID, title, or supported URL.

## Configuration

| Source | Description |
|--------|-------------|
| `confluence` configuration | Supplies the base URL, token source, default space, and optional attachment download suffix. |

**How to access:**

- `createConfluenceClient()` - creates the authenticated REST client from an injected HTTP client or transport dependencies.
- `parsePageRef()` - parses a numeric ID, `SPACE:Title`, supported page URL, or a bare title when a default space is available.

Configuration precedence and credential resolution are owned by [Runtime Context](./runtime-context.md).

## Data Storage

| Object/Model/Type | Field/Property | Purpose |
|--------|-------|---------|
| `PageRef` | `kind`, `id` or `space`, `title` | Distinguishes direct ID lookup from title lookup within a space. |
| `ConfluenceContent` | `id`, `type`, `title`, `space`, `version` | Holds the common REST representation for pages and related content. |
| `ConfluenceContent` | `ancestors`, `body`, `history`, `children` | Carries hierarchy, storage/view bodies, audit facts, and expanded child pages. |
| `ConfluencePage` | `counts` | Adds exact or capped child, comment, and attachment counts to content. |
| `ConfluenceComment` | `id`, `storage`, `author`, `created`, `version` | Represents a footer comment whose body is storage XHTML. |
| `ConfluenceAttachment` | `id`, `filename`, `mediaType`, `size`, `downloadPath` | Describes a downloadable page attachment. |
| `ConfluenceUser` | `username`, `userKey`, `displayName`, `type` | Represents an API user and the two mention identities used by storage. |
| `UserDirectory` | `usernameForKey()`, `keyForUsername()` | Resolves mention identities in both conversion directions. |
| `StatsSummary` | `pages`, `fencedPages`, `macros`, `fences`, `conventions` | Aggregates macro use and page-shape observations across a scope. |

Page bodies may contain writable `storage` XHTML and rendered `view` HTML. Only storage is a write-back source; conversion behavior belongs to [Confluence Storage Conversion](../features/confluence-storage-conversion.md).

A page's `counts.truncated` names the child kinds whose values are lower bounds because traversal reached its cap. Tree results similarly distinguish the whole-tree node cap from a per-parent child cap.

Page references accept numeric IDs, `SPACE:Title`, URLs containing `pageId`, modern `/spaces/.../pages/ID` URLs, and legacy `/display/SPACE/Title` URLs. Tiny `/x/` links cannot be resolved offline. A bare title requires `confluence.defaultSpace`.

## Key services and functions

| Module | Function/Method | Purpose |
|---------|--------|---------|
| `@wonna/lassi-confluence` | `createConfluenceClient()` | Constructs the public Confluence REST client. |
| `ConfluenceClient` | `resolvePageRef()` | Resolves any supported reference to a page with counts. |
| `ConfluenceClient` | `getPage()` | Fetches storage, version, space, ancestors, history, and related counts. |
| `ConfluenceClient` | `search()` / `searchIter()` / `searchAll()` | Searches CQL once, incrementally, or through the configured hard cap. |
| `ConfluenceClient` | `tree()` | Walks a page or space hierarchy and reports truncation reasons. |
| `ConfluenceClient` | `createPage()` / `updatePage()` | Creates or version-updates writable page storage. |
| `ConfluenceClient` | `listComments()` / `createComment()` / `deleteComment()` | Reads and mutates footer comments. |
| `ConfluenceClient` | `listAttachments()` / `downloadAttachment()` | Lists and streams attachments with a byte limit. |
| `ConfluenceClient` | `validateMentions()` / `resolveUserKeys()` | Builds safe username/user-key mappings with cached lookups. |
| `@wonna/lassi-confluence` | `countMacros()` / `observePage()` / `summarize()` | Produces macro, raw-fence, and editor-convention statistics. |

Search pagination follows the server's next-link `start`, because permission filtering can return fewer rows than the requested limit without exhausting results. Child walks cap each kind at 1,000 items; search walks cap at 5,000 unless a lower maximum is requested.

User lookup caches both successful and missing results. Mention validation returns known usernames separately from unknown names; unresolved keys encountered while reading remain representable rather than making reads fail.

The client also exposes these result contracts:

| Result | Meaning |
|--------|---------|
| `ConfluenceSearchPage` | One CQL page plus the server-derived next position. |
| `TreeResult` | A rooted page tree and independent node/child truncation flags. |
| `DownloadResult` | A saved byte count and MIME type, or a size-limit skip. |
| `SystemInfo` | An optional server version and the endpoint that established connectivity. |

Macro statistics count structured and legacy macros, treat modern and legacy layouts as `layout`, and pair those totals with converter warnings and observed writer shapes. They describe a sampled scope, not a server-side inventory.

## Internal Implementation

- Page counts reuse expanded children when complete and walk only a kind whose expansion reached its page limit; this affects whether displayed counts are exact.
- `systemInfo()` falls back from the administrative endpoint to the application-link manifest and finally a space probe, while preserving a definite authentication failure.
- Attachment downloads stream through the shared save boundary and may return `skipped` before writing when the declared file size exceeds the caller's limit.

## Reference Implementations

- `packages/confluence/src/client/types.ts` - public REST, page, hierarchy, comment, attachment, and result models.
- `packages/confluence/src/client/index.ts` - the complete injected client, pagination, caps, user lookup, and mutations.
- `parsePageRef()` - authoritative page-reference grammar and errors.
- `packages/confluence/src/page/frontmatter.ts` - mapping from server pages into editable and reserved working-file fields.
- `packages/confluence/src/stats/macros.ts` - macro inventory and page-shape aggregation.

## Related Concepts

- [Runtime Context](./runtime-context.md)
- [Markdown Document](./markdown-document.md)
- [Working File](./working-file.md)
- The user-facing commands are documented in [Confluence Page Workflows](../features/confluence-page-workflows.md).
