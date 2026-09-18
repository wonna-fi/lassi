# Confluence storage-format fixtures

Each directory is one fabricated fixture:

- `storage.xml` — the page body exactly as `GET /rest/api/content/{id}?expand=body.storage` returns it
- `markdown.md` — the canonical GitHub-flavoured Markdown `lassi` produces for it (read direction) and,
  for `direction: both`, the markdown that must convert back (write direction)
- `notes.md` — frontmatter `section` (the "Confluence Storage Format" documentation section that
  justifies the construct), `direction: both | read | write`, `roundtrip: true | false` (what the
  fidelity gate must say about this page), optional `writer` (`tableShell`, `cellWrap`,
  `mentionAttribute`), optional `users` (userKey → username the converter is given), optional
  `gate-diff` (the first XPath the gate must report for a `roundtrip: false` page), then prose
- `storage.normalized.xml` (optional) — the expected write output when it legitimately differs from
  `storage.xml` (server bookkeeping such as `ac:macro-id`, `ac:schema-version`, task ids and
  `ri:version-at-save` dropped; attributes in canonical order; entities minimally re-encoded; or, for
  `roundtrip: false` pages, the honest rewrite the gate refuses); asserted byte for byte
- `warnings.json` (optional) — `{ "read": [{ "code", "name", "path" }], "write": [{ "code", "line"? }] }`
- `markdown.readback.md` (optional, `direction: write` only) — what `storage → md` yields when the loop
  is lossy by design

Rules: use fabricated examples only (use `DEV`, `jsmith`, `example.internal`, page ids like `123456`); fixtures
are byte-level specs, so the formatter and editorconfig leave this directory alone. Every file ends
with exactly one newline that is not part of the spec (the writer emits none).
