---
title: Tests and Fixtures
type: convention
---

# Tests and Fixtures

- **Rule.** Colocate Vitest tests with implementation files and name them `*.test.ts`.
- **Do.** `packages/search/src/query/query.test.ts`
- **Don't.** `test/search/query.ts`
- **Rule.** Use fabricated data and injected filesystem, fetch, clock, and service dependencies; automated tests must not contact live services.
- **Do.** Exercise HTTP behavior with an injected `fakeFetch` and example-only identities such as `PROJ` and `jsmith`.
- **Don't.** Read real credentials or send a request to Jira, Confluence, or an embeddings service.
- **Rule.** Store conversion fixtures under `fixtures/{product}/{scenario}/`, using the filenames defined by that product's fixture harness.
- **Do.** `fixtures/jira/code-blocks/markdown.md` and `fixtures/confluence/toc/storage.xml`
- **Don't.** Put product conversion samples beside the test file or combine unrelated scenarios in one directory.
- **Applies to.** `packages/*/src/**/*.test.ts`, `fixtures/jira/**`, and `fixtures/confluence/**`
