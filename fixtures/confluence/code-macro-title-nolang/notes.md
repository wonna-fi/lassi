---
section: "Confluence Storage Format — Code block macro (title, no language)"
direction: both
roundtrip: true
---
A code macro with parameters but no `language` is fenced rather than turned into a code block:
`mdast-util-to-markdown` drops a fence's meta when it has no language, so the title vanished from
the markdown and from the next `page update` with nothing said about it. `code-macro` covers
language plus title and `code-macro-nolang` covers no parameters at all; this is the combination
between them.
