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

<!-- saaga:begin -->
### Domain Documentation (lassi)

This codebase has structured domain documentation under `saaga-docs/`, organized into four types:

| Type | Index | Answers |
|------|-------|---------|
| Concepts | `saaga-docs/concepts/INDEX.md` | What something is and where it lives |
| Patterns | `saaga-docs/patterns/INDEX.md` | How to do common operations — anything that takes reading a code flow to follow |
| Conventions | `saaga-docs/conventions/INDEX.md` | What things must be named or shaped like — the rules you could check with grep |
| Features | `saaga-docs/features/INDEX.md` | How a feature works end-to-end, user-facing or internal machinery |

Classify your question, open the matching `INDEX.md`, and read the relevant document(s):

- "What is X / where does X live?" -> read a concept
- "How do I do X?" -> read a pattern
- "What do I call X / where does the file go?" -> read a convention
- "How does feature X work end-to-end?" -> read a feature

Not every codebase has conventions; the category is present only when there are rules worth stating.

Rules:

- **Docs first**: ALWAYS read the domain documentation BEFORE exploring source code. It is the authoritative source for understanding the system; source code is the second resort.
- **No documentation updates during implementation**: do NOT update the domain documentation when making code changes. It is maintained separately by Saaga.
- **Consult before implementing**: before implementing new features or changes, check the existing concepts and patterns to reuse existing services/modules instead of reinventing them.
<!-- saaga:end -->
