---
section: "Tables (write direction) — cells"
direction: write
---
Cells carry `&#124;` for pipes (also inside inline code), `\\\\` for a `<br>`, a single space when empty, and an escaped `\\{code}` that must not fence the table on read. GFM flattens a hard break inside a cell to a space, so the reader keeps it as the inline `<br>` this fixture writes and the cell round-trips.
