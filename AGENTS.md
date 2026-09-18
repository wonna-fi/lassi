# Working on Lassi

Use Node.js 24, npm workspaces, TypeScript ESM and `.js` extensions in relative imports.
Keep `core` independent; `jira`, `confluence` and `search` may import only `core`.
The CLI composes those packages. Libraries receive filesystem, fetch and credentials explicitly.

Use fabricated fixtures and injected fetch for tests. Never call a live service in an automated test.
Keep credentials and user data outside this source tree. Preserve TLS verification, redaction,
the structured error contract, read-only checks, and dry-run behavior.

The initial release is alpha. Keep persisted data formats consistent across readers and writers.
Storage operations must honor the shared lock. Installed skills may contain user customizations;
do not overwrite them silently.

Run checks in order: `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build`.
Validate distribution changes with `npm run test:package`. Format with oxfmt and lint with oxlint.
