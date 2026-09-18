---
section: "Text Formatting Notation Help — Text Effects (color)"
direction: both
confirm: "the boundary newlines of the three-line {color:x} … {color} form do not render as line breaks, so trimming them is lossless"
---
`{color:value}text{color}` maps to `<span style="color:value">text</span>` in both directions
. Values are colour names or `#rgb` / `#rrggbb`; anything else keeps the
paragraph raw. The body is trimmed on read because canonical markdown cannot carry a hard break right
before the closing tag, which collapses the three-line block form on write. A colour opened at line
start and closed inside the same paragraph is the inline form; one spanning paragraphs stays one raw
block to its closer.
