---
name: confluence
description: Work with Confluence Data Center pages through the `lassi` CLI (read, search, browse the tree, comment, create and update pages, download attachments) using markdown working files. Use whenever a task mentions a Confluence page, space, wiki, runbook, design doc or page id, or asks to write documentation into Confluence.
---

# Confluence via `lassi`

`lassi confluence …` (alias `lassi conf`) talks to the on-prem Confluence Data Center. You read and write
**GitHub-flavoured Markdown**; the CLI converts to and from storage XHTML, keeps what it cannot
express in ```` ```confluence ```` fences, and refuses to write pages it cannot reproduce faithfully.
Every command prints markdown on stdout (one JSON document with `--json`) and, on failure, one human
line plus one JSON line on stderr with a stable `code` and a `hint`.

## Golden rules

1. **Write GFM only.** Never write storage XHTML (`<ac:…>`, `<ri:…>`, `<p>`) outside a
   ```` ```confluence ```` fence; the CLI rejects it with exit 2.
2. **Validate before you update.** Run `lassi confluence page validate --file <md>` before
   `page update`; it lets the server parse the converted storage without saving anything.
3. **On a non-zero exit**, read the JSON on stderr, follow `hint`, retry **once**, then stop and ask
   the human.
4. **Attachments are files.** `lassi confluence attach get <ID>` downloads them to disk; read them with
   your own tools.
5. **Prefer the working-file flow** (`page get --out` → edit → `page validate` → `page update --file`)
   for anything longer than a one-line comment.
6. **Use `--dry-run`** when unsure what the converter will produce; it prints the exact storage and
   sends nothing.
7. **Never pass `--any` or `--force`** unless the human asked for it. `--force` rewrites content the
   dialect cannot preserve.

## Quick reference

| Task | Command |
|---|---|
| Read a page | `lassi confluence page get 123456` (also `"DEV:Page title"` or the page URL; `--comments`, `--attachments`) |
| Raw storage / rendered view | `lassi confluence page get 123456 --format storage`; `--format view` (read-only markdown) |
| Search | `lassi confluence search 'space = DEV and text ~ "payment"' --limit 20` |
| Browse | `lassi confluence tree DEV --depth 2`; `lassi confluence tree 123456` |
| Work a page | `lassi confluence page get 123456 --out work/page.md`, edit, `lassi confluence page validate --file work/page.md`, `lassi confluence page update --file work/page.md` |
| Create | `lassi confluence page create --space DEV --title "Runbook" --parent 123400 --file runbook.md` |
| Rename / move | `lassi confluence page update 123456 --title "New title" --parent 100` |
| Comment | `lassi confluence comment list 123456`; `lassi confluence comment add 123456 --body "Reviewed."` |
| Attachments | `lassi confluence attach get 123456 --only "*.png"` |
| What a space uses | `lassi confluence stats macros --space DEV` |

Every write accepts `--dry-run`. `LASSI_READ_ONLY=1` blocks all writes (exit 7).

## Working files

`page get 123456 --out work/page.md` writes markdown with YAML frontmatter:

- **Editable keys**: `title` and `parent` (a page id). `id` and `space` identify the page; moving a
  page to another space is not supported.
- **`readonly`** (`version`, last modified, URL), **`counts`** and **`lassi`** are informational.
- **The body is the page.** Sections `## Comments` and `## Attachments` are generated and never sent;
  leave them untouched or delete them entirely.
- Regions the dialect cannot express (layouts, unknown macros, irregular tables) appear as
  ```` ```confluence ```` fences holding the exact XHTML. Edit around them; they are sent back byte
  for byte. Do not hand-edit XHTML inside a fence unless you know the storage format.

`page update --file work/page.md` checks the server version (exit 6 if the page changed), converts the
body, runs the **fidelity gate** (exit 5 when the untouched parts of the page would not survive the
round trip; the JSON lists the nodes), sends `version + 1` and rewrites the file from the server
(`--keep` skips that). The original storage is cached under `.lassi/cache/confluence/`; do not edit it.
A `--format view` file is read-only and cannot be updated.

## Formatting

Headings, emphasis, inline code, fenced code (`lang` → code macro, `noformat` → noformat macro),
lists, task lists, quotes, links, `@username`, `[[Page title]]` / `[[DEV:Page title|label]]` page
links, `{jira:PROJ-1}` issue macros, `![alt](attachment:file.png "width=300")` images, GFM tables,
GFM alerts (`> [!NOTE] Title`, `[!TIP]`, `[!WARNING]`, `[!IMPORTANT]` → info/tip/warning/note
panels), `<!-- toc -->` and `---` all convert. Unresolvable user keys read as `@{userkey:…}` and
write back unchanged. `[!CAUTION]`, footnotes, inline HTML other than `<br>` and images that are
neither attachments nor URLs are rejected (exit 5). Details: `references/formatting.md`.

## Errors

| Exit | Meaning | Do |
|---|---|---|
| 2 | usage: bad flags, pasted XHTML, edited generated sections, unknown frontmatter key | fix the file or command |
| 3 | auth | tell the human; `lassi doctor` |
| 4 | not found | check the id, title or space; `lassi confluence search` |
| 5 | validation: server parse error, fidelity gate, unknown `@mention`, unrepresentable markdown | fix the markdown; keep raw regions in fences; `--force` only if asked |
| 6 | conflict: page changed on the server | `page get <ID> --out <same file>`, re-apply, retry once |
| 7 | read-only mode | stop, tell the human |
| 1 | network, TLS, timeout, other HTTP | `lassi doctor` |

More in `references/errors.md`.

## References

- `references/commands.md` — every `lassi confluence` command and flag (generated)
- `references/workflows.md` — step-by-step sequences with `--dry-run` first
- `references/formatting.md` — the markdown ↔ storage dialect as implemented
- `references/errors.md` — the error contract, the fidelity gate and what each hint means
