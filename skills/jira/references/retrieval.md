# Read Jira evidence and find related work

Choose the retrieval method from the question:

| What is known | First action |
|---|---|
| Issue key or current branch | `lassi jira issue get PROJ-123 --axi` or `lassi jira issue get . --axi` |
| Project, status, assignee or date constraints | `lassi jira issue search 'project = PROJ AND status = "In Progress"' --limit 20 --axi` |
| A concept, symptom or possible duplicate | `lassi search show --axi`, then `lassi search query "session fails during parallel token renewal" --product jira --axi` |
| Exact error text, identifier or symbol | Search exported Markdown with `rg -n -F 'singleFlightRefresh' <source-directory>`; use a known issue key directly |

Semantic search is useful for meaning and paraphrases. It does not guarantee exact identifier matches or enforce Jira field filters. Combine it with JQL and local exact search when those constraints matter.

## Read enough of the issue

Start with the description and counts. Request `--comments 5` for recent context or `--comments all` for the whole discussion; `--all` also includes attachment and link metadata. Numeric comment selections are the newest N, presented chronologically. `commentCoverage` distinguishes intentional limits from incomplete retrieval; a cap or interrupted pagination is not a complete discussion. Look at later comments before concluding that a problem has no resolution.

```sh
lassi jira issue get PROJ-123 --comments all --attachments --links --axi
lassi jira attach get PROJ-123 --only '*.log' --json
```

Use the returned attachment ID-to-path mapping. Files are named with stable attachment IDs, so two equal filenames can coexist. Read logs, PDFs and images with the agent's own tools. Check `saved`, `unchanged`, `skipped`, `failed` and `complete`; a size skip or partial failure means some evidence was not read. A failed batch can still return successful paths on stdout. Retry failed selections once according to stderr's structured error; preserve local files reported as conflicts.

## Follow a semantic hit back to evidence

Read the hit's exported file for surrounding text and fetch the live issue before making a claim about current state:

```sh
lassi search query "duplicate charge after request timeout" --product jira --index default --axi
lassi jira issue get PROJ-123 --comments all --attachments --axi
```

Quote the issue key, source URL and the description or comment that supports the answer. Scores rank candidates; they are not confidence probabilities. A hit can be related without answering the question.

`coverage.localState` compares the index with local files. `current` means those files match; it does not mean Jira was checked today. Inspect the export dates, attempted queries, last-run completeness and per-hit fetch/check dates. `changed` needs an index refresh; `unavailable` or `unknown` prevents a completeness claim. A completed run covers its recorded query only. An export directory is an accumulating archive and may retain issues from older queries.

When authorized to refresh the corpus:

```sh
lassi jira issue export 'project = PROJ' --comments
lassi search index
```

Exports default to `~/.lassi/export/jira/`; indexes default to `~/.lassi/index/<name>/`. Both are shared across projects and can be relocated through global `storage.exportDir` / `storage.indexDir` configuration or `LASSI_EXPORT_DIR` / `LASSI_INDEX_DIR`. Use `lassi config show` to discover the resolved roots. Working files and attachments remain project-local.

Use the existing export directory and query appropriate to the task. Named indexes remember absolute source directories and work from any cwd: `lassi search index --name <name>`. If source files are unreadable, fix access before rebuilding. `--rebuild` is for repairing index data or accepting a model change; it does not fetch Jira. Indexing sends Markdown to the configured embeddings endpoint and is blocked by `LASSI_READ_ONLY`; querying an existing index sends the question, but does not rebuild it.

“No matches” means no indexed Markdown passed the configured similarity threshold. It does not establish that Jira has no relevant issue. Check scope, dates, failed/truncated exports, comment coverage, JQL and exact search before reporting a negative. Attachment filenames and metadata may be indexed; the contents of logs, PDFs and screenshots are not automatically extracted or embedded.

Keep editing copies separate from the export archive: use `issue get --out work/PROJ-123.md` for edits. Export conflicts preserve changed files; do not discard those edits to refresh search.

To index an archive outside the configured export roots, use `lassi search index <directory> --name <name>`. Future exports to that archive need its explicit `--out-dir`. To change an index’s source directories, pass the new directories with `--rebuild`. Preserve local edits and check the recorded sources before claiming coverage.

A busy archive or index returns conflict with a `.lassi-write.lock` path. Retry after the other operation completes. Do not remove its lock while another process may be active. Index directories must be separate from all source/archive directories.
