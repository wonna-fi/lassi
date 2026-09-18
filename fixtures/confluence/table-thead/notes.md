---
section: "Confluence Storage Format — Tables (thead)"
direction: both
roundtrip: false
writer: {tableShell: plain, cellWrap: none}
gate-diff: "/table[1]/thead[1]"
---
Read as a GFM table for readability; the writer emits `tbody` only, so the gate refuses.
