---
name: jira
description: Work with Jira Data Center issues through the `lassi` CLI (read, search, comment, create, update, transition, attach, link) using markdown working files. Use whenever a task names an issue key such as PROJ-123, a ticket, an epic or a sprint, or asks to comment on, create or change a Jira issue.
---

# Jira via `lassi`

`lassi jira …` talks to the on-prem Jira Data Center. You read and write **GitHub-flavoured
Markdown**; the CLI converts to and from Jira wiki markup and refuses anything else. Every command
prints markdown on stdout (one JSON document with `--json`) and, on failure, one human line plus one
JSON line on stderr with a stable `code` and a `hint`. Run `lassi doctor` first when anything looks
misconfigured.

## Golden rules

1. **Write GFM only.** Never write wiki markup (`h2.`, `{code}`, `[~user]`, `{color}`, `||table||`)
   outside a ```` ```jira ```` fence; the CLI rejects it with exit 2.
2. **Look before you write.** Before `issue create`, run `lassi jira templates` (use
   `--template <name>` when one fits), `lassi jira fields` and `lassi jira issue createmeta <PROJECT>
   --type <TYPE>`; before `issue update`, run `lassi jira issue editmeta <KEY>`.
3. **On a non-zero exit**, read the JSON on stderr, follow `hint`, retry **once**, then stop and ask
   the human. Never loop on the same error.
4. **Attachments are files.** `lassi jira attach get <KEY>` downloads them to disk; read them with your
   own tools. Nothing binary ever comes through stdout.
5. **Prefer the working-file flow** (`issue get --out` → edit → `issue update --file --if-unchanged`)
   for anything longer than a one-line comment.
6. **Use `--dry-run`** when unsure what the converter will produce; it prints the exact request and
   sends nothing.
7. **Never pass `--any` or `--force`** unless the human asked for it.

## Reading and finding related work

Use a known key directly, JQL for field constraints, semantic search for meaning, and local exact search for error strings or code symbols. Read `references/retrieval.md` when gathering issue evidence, inspecting attachments or searching for related work. It explains discussion completeness, source freshness and what a negative search result can establish. `--axi` provides compact structured output and next steps; `--json` provides one JSON document.

## Quick reference

| Task | Command |
|---|---|
| Catch up | `lassi jira digest --since 1d`: mentions of you, your issues that changed, what you did |
| Read an issue | `lassi jira issue get PROJ-123` (`--comments [N]`, `--attachments`, `--links`, `--all`); `.` instead of a key means the issue named by the current git branch, on every command |
| Search | `lassi jira issue search 'project = PROJ AND status = "In Progress"' --limit 20` |
| Related work | `lassi search show --axi`; `lassi search query "describe the symptom" --product jira --axi` |
| What changed | `lassi jira issue changelog PROJ-123 --since 1d` (`--fields status,assignee`; `--since` takes `2h`, `1w`, `2026-09-01`) |
| Comment | `lassi jira comment add PROJ-123 --body "One line."` or `--file note.md` |
| Work a ticket | `lassi jira issue get PROJ-123 --out work/PROJ-123.md`, edit, then `lassi jira issue update PROJ-123 --file work/PROJ-123.md --if-unchanged` |
| Create | `lassi jira templates bug --out desc.md` (skeleton), fill it in, then `lassi jira issue create --template bug --summary "Login 500" --file desc.md`; without templates use `--project PROJ --type Bug`, inspect `issue createmeta`, and supply the required fields |
| Transition | `lassi jira transition list PROJ-123`, then `lassi jira transition do PROJ-123 "In Review" --field resolution=Fixed` |
| Attachments | `lassi jira attach get PROJ-123 --only "*.png"`; `lassi jira attach upload PROJ-123 ./log.txt` |
| Links | `lassi jira link types`; `lassi jira link list PROJ-123`; `lassi jira link create PROJ-1 PROJ-2 --type "blocks"` |
| Field metadata | `lassi jira fields`; `lassi jira issue createmeta PROJ --type Bug`; `lassi jira issue editmeta PROJ-123` |

Every write accepts `--dry-run`. `LASSI_READ_ONLY=1` in the environment blocks all writes (exit 7).

## Working files

`issue get PROJ-123 --out work/PROJ-123.md` writes a markdown file with YAML frontmatter:

- **Editable keys**: `summary`, `type`, `priority`, `assignee` (a *username*, never a display name),
  `labels`, and every configured custom-field alias (discover aliases with `lassi jira fields`). Set a key to `null` to clear it.
- **`readonly`**, **`counts`** and **`lassi`** are informational; edits there are ignored with a warning.
- **The body is the description.** Sections `## Comments`, `## Attachments`, `## Links` are generated
  and never sent; leave them untouched or delete them entirely.

`issue update PROJ-123 --file work/PROJ-123.md` sends only what changed and rewrites the file from
the server afterwards (`--keep` skips that). `--if-unchanged` exits 6 when the issue changed on the
server since the fetch; re-run `issue get --out` on the same file and re-apply your edit. The
original is cached under `.lassi/cache/jira/`; do not edit that directory.

## Mentions, users, field values

- `@username` in a body becomes a Jira mention; usernames are validated before anything is sent
  (unknown → exit 5). Use the `assignee`/`reporter` values you see in issue files, not names.
- `--field alias=value`: aliases come from `references/fields.md`; raw ids (`customfield_10005`)
  work too. `-` or an empty value clears a field; a value starting with `{` or `[` is sent as JSON
  (escape hatch for cascading selects); select options are matched case-insensitively against the
  allowed values and a mismatch lists them.
- Required fields missing on create fail *before* any request, naming the aliases and the
  `createmeta` command to run.

## Formatting

Headings, emphasis, inline code, fenced code (`lang` → `{code:lang}`, `noformat` →
`{noformat}`), nested bullet and numbered lists, task lists (`- [ ]` → `(x)`/`(/)` prefixes),
quotes, links, `@user`, `![alt](attachment:file.png "thumbnail")`, tables with inline cells, `---`
and hard breaks all convert. Anything the wiki dialect cannot carry is rejected with exit 5 and a
hint (block content in table cells, footnotes, inline HTML other than `<span style="color:…">`).
On read, whatever the markdown dialect cannot carry (panels, `{expand}`, emoticons) arrives verbatim
inside a ```` ```jira ```` fence; keep those fences as they are when you edit around them. Details
and the normalised forms: `references/formatting.md`.

## Errors

| Exit | Meaning | Do |
|---|---|---|
| 2 | usage: bad flags, unknown alias, pasted markup | fix the command; the hint names the lookup command |
| 3 | auth | tell the human (token file path is in the JSON); `lassi doctor` |
| 4 | not found | check the key, project or user |
| 5 | validation (Jira's field errors verbatim under `errors`) | fix the fields; hint names `createmeta`/`editmeta`/`transition list` |
| 6 | conflict (`--if-unchanged` drift) | re-fetch with `issue get --out`, re-apply, retry once |
| 7 | read-only mode | `LASSI_READ_ONLY` is set; stop, tell the human |
| 1 | network, TLS, timeout, other HTTP | `lassi doctor`; TLS → `NODE_EXTRA_CA_CERTS` |

More in `references/errors.md`.

## References

- `references/commands.md` — every `lassi jira` command and flag (generated)
- `references/retrieval.md` — issue evidence, attachments and scoped semantic search
- `references/workflows.md` — step-by-step sequences with `--dry-run` first
- `references/formatting.md` — the markdown ↔ wiki dialect as implemented
- `references/errors.md` — the error contract and what each hint means
- `references/fields.md` — this instance's field aliases and allowed values (generated)
- `references/link-types.md` — this instance's link types and directions (generated)
