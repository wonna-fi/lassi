---
section: "Confluence Storage Format — Links to pages"
direction: both
roundtrip: true
---
The two halves of `[[Title|body]]` have different rules. The title ends at the first `|`, so it may
carry neither that nor a `]`. The body runs to the first `]]` and takes everything after the first
`|`, so a lone `|` or `]` in it round-trips and must not be fenced. `page-links-unfenceable` covers
the body that genuinely cannot be written.
