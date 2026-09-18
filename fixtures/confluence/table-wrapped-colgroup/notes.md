---
section: "Confluence Storage Format — Tables (editor shell)"
direction: both
roundtrip: true
writer: {tableShell: wrapped-colgroup, cellWrap: p}
---
The Data Center editor writes `class="wrapped"`, a `colgroup` and `<p>`-wrapped cells; `inferWriterOptions` reads that shape back. A `<br/>` inside a cell is inline HTML because GFM tables cannot carry a hard break.
