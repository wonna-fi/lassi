# Jira wiki-markup fixtures

Each directory is one fabricated fixture:

- `wiki.txt` — Jira wiki markup as the REST API returns it
- `markdown.md` — the canonical GitHub-flavoured Markdown `lassi` produces for it (read direction) and,
  for `direction: both`, the markdown that must convert back (write direction)
- `notes.md` — frontmatter `section` (the Atlassian "Text Formatting Notation Help" section that
  justifies the construct), `direction: both | read | write`, optional `confirm` (something to verify
  during manual verification), then prose about ambiguities
- `wiki.normalized.txt` (optional) — the expected write output when it legitimately differs from
  `wiki.txt` (blank lines between blocks, `bq.` for one-line quotes, bare autolinks, `{code:lang}`
  always multi-line, the Jira-safety escapes `\[1]` and `Wow\!Nice!`, …). Asserted byte for byte and
  required to be stable under a second `wiki → md → wiki` pass
- `warnings.json` (optional) — the exact `[{ "code", "line"? }]` warnings the write direction emits;
  absent means none
- `markdown.readback.md` (optional, `direction: write` only) — what `wiki → md` yields when the loop
  is lossy by design (for example hoisted list blocks)

Rules: use fabricated examples only (use `PROJ`, `jsmith`, `example.internal`, `customfield_1000x`); fixtures
are byte-level specs, so the formatter and editorconfig leave this directory alone.
