---
title: Jira Domain
type: concept
last_verified: 2026-09-30
sources:
  - packages/jira/package.json
  - packages/jira/src/index.ts
  - packages/jira/src/client/*.ts
  - packages/jira/src/fields/*.ts
  - packages/jira/src/issue/*.ts
  - packages/jira/src/changelog/*.ts
  - packages/jira/src/digest/*.ts
  - packages/core/src/config/schema.ts
  - packages/cli/src/context.ts
  - packages/cli/src/commands/jira/comment.ts
  - packages/cli/src/commands/jira/issue-key.ts
  - packages/cli/src/commands/jira/editmeta.ts
---

# Jira Domain

## Business Definition

The Jira domain represents issues and the related information Lassi can read or change: fields, comments, attachments, links, transitions, history, project components, and project versions. It also defines the authenticated client surface used by Jira workflows.
The package keeps these product terms independent of CLI rendering and filesystem policy.

## Configuration

| Source | Description |
|--------|-------------|
| `jira.url` and Jira token settings | Select the server and credentials used to construct the client. |
| `jira.defaultProject` | Supplies the project when issue creation omits `--project`. |
| `jira.fields` | Maps stable local aliases to Jira field IDs. |
| `jira.branchPattern` | Extracts an issue key when `.` is used as the key argument. |

**How to access:**

- `Context.product('jira')` - returns the memoized authenticated product client configuration.
- `createJiraClient()` - constructs the typed Jira API client from an injected HTTP client.
- `ISSUE_KEY` (constant) - contains the accepted uppercase issue-key pattern.

Configuration precedence and credential handling belong to [Runtime Context](./runtime-context.md).

## Data Storage

| Object/Model/Type | Field/Property | Purpose |
|--------|-------|---------|
| `JiraIssue` | `id`, `key`, `self`, `fields` | Identifies an issue and holds its fetched field values. |
| `JiraIssueFields` | `summary`, `description`, `status`, users, dates | Provides common fields while allowing additional Jira fields. |
| `JiraComment` | `id`, `author`, `body`, timestamps | Represents one comment in Jira wiki markup. |
| `JiraAttachment` | `id`, `filename`, `size`, `content` | Describes downloadable attachment content. |
| `JiraIssueLink` | `id`, `typeName`, `direction`, `description`, `otherKey`, optional `otherSummary`, optional `otherStatus` | Normalizes inward and outward links into one directed shape. |
| `JiraTransition` | `id`, `name`, `to`, `fields` | Describes an available status transition and its screen fields. |
| `JiraHistory` | `created`, `author`, `items` | Groups field changes made in one history event. |
| `JiraChangeItem` | `field`, optional `fieldId` | Carries a history display name and, when Jira supplies it, the field's identity. |
| `FlattenOptions` | `fields`, `aliases`, `fieldNames` | Supplies changelog filters, configured aliases, and an optional field ID to display-name map to `flattenChangelog()`. |
| `JiraFieldMeta` | `fieldId`, `name`, `required`, `schema`, `allowedValues` | Drives validation and conversion of authored field values. |
| `JiraComponent` | `id`, `name`, optional `description`, `lead`, `archived`, `project` | Represents a project component returned by Jira; an issue's `components` field holds named references. |
| `JiraVersion` | `id`, `name`, `archived`, `released`, optional `description`, `releaseDate` | Represents a project version; an issue's `fixVersions` field holds named references. |
| `EditmetaCache` | `schema`, `baseUrl`, `project`, `issueTypeId`, `fetchedAt`, `fields` | Stores a versioned edit-metadata answer for one server, project, and issue type. |
| `IssueFrontmatter` | editable fields, `readonly`, `counts`, `lassi` | Separates writable issue data from server-owned metadata and required informational metadata. |
| `IssueCache` | `editable`, `readonly`, `descriptionMarkdown`, `updated`, `files` | Stores the entity baseline and per-path snapshots used for working-file comparisons. |

An issue key is an uppercase project key, a hyphen, and digits; underscores are allowed in the project portion. `assertIssueKey()` rejects other direct values. The CLI may resolve `.` from the current branch using the configured pattern, then normalizes the discovered key to uppercase.

`assertProjectKey()` trims and uppercases a project key before it enters a project REST path. It accepts a leading letter followed by letters, digits, or underscores; `.` is reserved for issue-key lookup and is rejected as a project argument.

Project components are distinct from the components assigned to one issue. `JiraClient.listComponents()` reads the project's component catalog, and `createComponent()` creates an entry with a project, name, and optional description. Creating one requires Jira's Administer Projects permission; issue assignment does not create a project component unless requested by the workflow.

Project versions are distinct from an issue's fix versions. `JiraClient.listVersions()` includes archived entries, while `allowedVersions()` retains every non-archived entry, whether released or unreleased. Archived versions already on an issue may remain there, but `resolveVersions()` refuses to assign them again.

Component and version names resolve through `findByName()`: exact spelling wins, then one case-insensitive match is accepted. Multiple case-insensitive matches without an exact match are a validation error requiring exact spelling. `planComponentAdd()` and `planComponentRemove()` deduplicate resolved names and reject unresolved choices before a write; adding an archived project component is rejected unless it is already on the issue. `resolveVersions()` rejects unknown or archived names before a fix-version update.

Request shapes matter when extending this domain. `componentCreateRequest()` builds the project component POST body; `componentRef()` uses an ID when available, or a name for a component planned for creation. `componentUpdate()` sends `update.components` add/remove operations, preserving unrelated issue components. `fixVersionsUpdate('set', ...)` sends `fields.fixVersions` and replaces the list; `'add'` sends `update.fixVersions` add operations, retaining current entries. The command flow and dry-run behavior are in [Jira Issue Workflows](../features/jira-issue-workflows.md).

Comment IDs are decimal strings. The exported `assertCommentId()` validates them before a comment edit or delete can construct a request path; invalid IDs raise `usage`. The CLI calls it before preparing either write, while the client also checks IDs for comment get, edit, and delete. General path-segment protection belongs to [Injected I/O and HTTP](../patterns/injected-io-and-http.md).

Field aliases are explicit configuration entries. Standard IDs and `customfield_N` may also be addressed directly, and frontmatter `type` maps to Jira's `issuetype`. Unknown names are returned separately instead of being sent to Jira.

`matchesField()` compares changelog filters with a history item's display name, explicit field ID, or configured alias; filter names and display names are case-insensitive. For system history names covering components, fix versions, affected versions, and issue links, when Jira omits `fieldId` or sends the system field's own ID, it also recognizes that system ID and, for components and versions, their edit-screen names (`Component/s`, `Fix Versions`/`Fix Version/s`, `Affects Versions`/`Affects Version/s`); issue links have no edit-screen spelling.

An alias or raw `customfield_N` ID can match an item without `fieldId` through its display name when the caller supplies `FlattenOptions.fieldNames`, a field ID to instance display-name map. Without that map, a custom-field ID cannot be resolved for an ID-less item. Some system aliases still resolve through the known history names without a map. When `fieldId` is present, it controls alias and ID matching even if another field shares the display name: a custom field named `Component` does not match the `components` ID, although a direct filter for `Component` still matches that display name. An ID-less item carries no way to distinguish fields with the same display name; the command's lookup and warning behavior is in [Jira Issue Workflows](../features/jira-issue-workflows.md).

API field objects become compact authored values where possible: users become usernames, options become values, named entities become names, and projects become keys. Objects that cannot be safely simplified remain mappings. In the reverse direction, the field schema shapes users, projects, options, arrays, components, versions, and other named values for Jira. The schema comes from loaded metadata, from the fetch that wrote a working file, or from the standard field table.

An empty value or `-` clears a `--field`; JSON-looking input is parsed and sent as the explicit escape hatch. Values outside a field's advertised allowed set produce a structured validation failure.

Allowed values matter for options, priorities, issue types, resolutions, and statuses, which they validate and give a canonical spelling. `needsFieldMeta()` names these, plus a field without a known schema, so callers load metadata only for them. Clears and JSON values need none. Components and versions use loaded metadata to send an id, and otherwise go by name for Jira to resolve.

Edit metadata is cached as an `EditmetaCache` per server, project, and issue type for 24 hours. Its `schema: 1` identifies the stored format; a different version, identity, or expired timestamp is a miss. Project and issue type determine the edit screen, field configuration, and option contexts, so issues of one type share an entry. A field missing from a fresh entry does not trigger another fetch. `fieldChangeToApi()` can still form a value from a schema saved with the working file or from a standard schema, and Jira may reject the update. A screen or option change made within the 24 hours shows up once the entry expires or `jira issue editmeta` refreshes it. An empty answer, which Jira gives for an issue in a status that forbids editing, is never stored. A cache that cannot be read or written only costs time; the command warns and continues.

Links retain Jira's link type, numeric ID, and direction. `normalizeLinks()` maps raw issue links to the relationship as displayed from the listed issue. `resolveLinkDirection()` accepts a type name or its inward/outward phrase and returns `sourceKey`, `targetKey`, and the sentence shown to the user. For the displayed sentence `A blocks B`, `issueLinkRequest()` puts A in Jira's `inwardIssue` request field and B in `outwardIssue`; those request field names do not describe the sentence's direction. `createLink()` accepts `{ typeName, sourceKey, targetKey }` and sends that shape. `deleteLink()` accepts a decimal link ID, checked by `assertLinkId()` before it enters the DELETE path. The CLI's matching and deletion sequence belongs to [Jira Issue Workflows](../features/jira-issue-workflows.md).

Transitions resolve case-insensitively by exact ID or name. No match is a validation error; multiple name matches are rejected as ambiguous rather than selecting one.

## Key Services/Functions (PUBLIC/EXPORTED only)

| Module | Function/Method | Purpose |
|---------|--------|---------|
| `@wonna/lassi-jira` | `createJiraClient()` | Exposes Jira reads, writes, metadata, comments, links, transitions, and downloads. |
| `@wonna/lassi-jira` | `assertIssueKey()` | Validates a direct Jira key. |
| `@wonna/lassi-jira` | `assertProjectKey()` | Normalizes and validates a project key for a project path. |
| `@wonna/lassi-jira` | `assertCommentId()` | Validates a decimal comment ID before it is used in a request path. |
| `@wonna/lassi-jira` | `assertLinkId()` | Validates a decimal link ID before deletion. |
| `@wonna/lassi-jira` | `issueKeyFromBranch()` | Extracts a key from a branch name using configured syntax. |
| `@wonna/lassi-jira` | `resolveFieldAliases()` | Converts authored aliases to API field IDs and reports unknown names. |
| `@wonna/lassi-jira` | `coerceFieldValue()` | Converts CLI text with loaded field metadata, or a fallback schema when none was loaded. |
| `@wonna/lassi-jira` | `frontmatterChanges()` | Lists changed working-file fields, with the schema recorded at fetch or a standard one, before any conversion. |
| `@wonna/lassi-jira` | `fieldChangeToApi()` | Converts one change, raising a validation error for a value outside the allowed values. |
| `@wonna/lassi-jira` | `needsFieldMeta()` | Tells whether converting a value needs the field's metadata, live or cached. |
| `@wonna/lassi-jira` | `usableEditmetaCache()` | Accepts a stored edit-metadata entry only when fresh and for the same server, project, and issue type. |
| `@wonna/lassi-jira` | `resolveTransition()` | Selects one unambiguous transition. |
| `@wonna/lassi-jira` | `normalizeLinks()` | Normalizes Jira's directional link response. |
| `@wonna/lassi-jira` | `resolveLinkDirection()` | Resolves a type name or direction phrase to a displayed sentence and source/target keys. |
| `@wonna/lassi-jira` | `issueLinkRequest()` | Builds the Jira create body from a link type and source/target keys. |
| `@wonna/lassi-jira` | `findLinks()` | Finds links matching a resolved relationship, including either stored direction for symmetric wording. |
| `@wonna/lassi-jira` | `readComments()` | Reads paginated comments and reports coverage. |
| `@wonna/lassi-jira` | `findByName()` | Resolves a named component or version with exact-spelling priority. |
| `@wonna/lassi-jira` | `planComponentAdd()` / `planComponentRemove()` | Validate and plan an issue component change before writing. |
| `@wonna/lassi-jira` | `componentRef()` / `componentUpdate()` / `componentCreateRequest()` | Build component references and Jira request bodies. |
| `@wonna/lassi-jira` | `allowedVersions()` / `resolveVersions()` / `fixVersionsUpdate()` | Select assignable project versions and build an issue update. |
| `JiraClient` | `listComponents()` / `createComponent()` / `listVersions()` | Read project catalogs and create a project component. |
| `@wonna/lassi-jira` | `flattenChangelog()` | Produces ordered, filterable field-change rows. |
| `@wonna/lassi-jira` | `matchesField()` | Tests one history item against a changelog field filter. |
| `@wonna/lassi-jira` | `changelogFilterFieldId()` | Resolves a filter's configured alias or raw custom-field ID to a field ID. |
| `@wonna/lassi-jira` | `changelogNeedsFieldNames()` | Reports whether custom-field filtering over ID-less history needs instance field names. |
| `@wonna/lassi-jira` | `changelogFieldNames()` | Builds the caller-supplied ID-to-name map from Jira field definitions and reports missing or shared custom-field names. |
| `@wonna/lassi-jira` | `buildDigest()` | Classifies fetched activity into digest sections and actions. |

`JiraClient` is the public remote boundary. Its methods cover server identity, issue get/search/create/update, create/edit metadata, changelog, comment CRUD, attachment download/upload, transition list/apply, link types/list/create/delete, project component/version catalogs, component creation, and paginated export-oriented reads.

| Client area | Observable contract |
|-------------|---------------------|
| Issue search | One page preserves Jira's total; `searchAll()` reports whether its cap truncated results. |
| Comments | Page reads can be combined while retaining returned-versus-total coverage. |
| Attachments | Downloads distinguish a completed file from a skipped file and include the reason. |
| Changelog | Results carry summary, status, total history count, and a truncation marker. |
| Metadata | Create fields are scoped by project and issue type. Edit fields are requested per issue and cached per project and issue type. An edit-metadata request gets at least 180 seconds and no retry when its own deadline expires; other failures still retry. |
| Mutations | Create returns the new identity; other writes complete only after Jira accepts the request. |
| Project catalogs | Component and version reads use validated project keys. An empty Jira response becomes an empty list; version reads retain archived entries for callers to filter. |

## Internal Implementation

- The client accepts an injected `HttpClient`; pagination and endpoint fallbacks are hidden behind the public methods, constraining callers to one stable interface.
- Create metadata tries the paginated API and falls back to legacy behavior, exposing the selected `CreatemetaMode` so callers can report what Jira supported.
- Working-file readonly fields and caches preserve server identity and baselines; their lifecycle is documented in [Working File Lifecycle](../features/working-file-lifecycle.md).

## Reference Implementations

- `packages/jira/src/client/index.ts` - complete public client contract and HTTP-backed implementation.
- `packages/jira/src/client/types.ts` - exported Jira issue, comment, attachment, link, transition, and metadata shapes.
- `packages/jira/src/client/components.ts` - exported component planning and add/remove request builders.
- `packages/jira/src/client/versions.ts` - exported version filtering, resolution, and fix-version request builders.
- `packages/jira/src/client/named.ts` - exported case-insensitive name resolution with ambiguity handling.
- `packages/jira/src/fields/normalize.ts` - bidirectional field-value normalization.
- `packages/jira/src/issue/frontmatter.ts` - editable and readonly Jira frontmatter boundary.
- `packages/jira/src/changelog/flatten.ts` - exported filter resolution, field-name mapping, and history flattening boundary.
- `createJiraClient()` - reference entry point for Jira remote operations.
- `resolveFieldAliases()` - reference for accepting aliases without guessing unknown fields.

## Related Concepts

- [Runtime Context](./runtime-context.md)
- [Markdown Document](./markdown-document.md)
- [Working File](./working-file.md)
- Jira command behavior is documented in [Jira Issue Workflows](../features/jira-issue-workflows.md).
