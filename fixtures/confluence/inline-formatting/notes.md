---
section: "Confluence Storage Format — Inline formatting"
direction: both
roundtrip: true
---
`strong`/`em`/`s`/`code` are the storage forms the writer emits; the legacy `b`/`i` forms are a separate negative fixture. `***both***` is `em > strong` in CommonMark, so that is the nesting the writer produces; a page with `strong > em` reads the same but trips the gate.
