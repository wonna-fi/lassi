---
section: "Confluence Storage Format — No format macro"
direction: both
roundtrip: true
---
`noformat` parameters round-trip like any other macro's. The writer returned before it looked at the
fence meta, so `nopanel=true` was dropped on write-back without even a `code-meta-dropped` warning.
