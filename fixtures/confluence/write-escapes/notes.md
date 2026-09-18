---
section: "Confluence Storage Format - Escaping (write)"
direction: write
roundtrip: true
---
`&`, `<`, `>` and U+00A0 are escaped in text; `"` additionally in attributes; a formatted link label is flattened with a warning (link bodies are plain text), which is the one lossy step and why `markdown.readback.md` exists.
