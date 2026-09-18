---
section: "Lists (write direction) — block children"
direction: write
---
Block children other than nested lists are hoisted after the list with a `list-split` warning, which splits the list; an ordered list's start number is dropped with a warning; `(x)`/`(/)` at the start of an item's text reads back as a task, hence `task-marker-ambiguity`. The loop is lossy by design, so `markdown.readback.md` records the hoisted shape.
