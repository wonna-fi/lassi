---
section: "Composite (write direction) — escaping"
direction: write
---
One paragraph per escaper rule: macro headers and `{{`, anchor-style brackets, emphasis markers only at opener positions with a closer on the line, Jira-safety `\\!` for image-like spans, line-start guards for lists, rules and tables, and the `\\\\` break form when a continuation line would read as a heading or `bq.`. Plain backslashes survive; a backslash before a special character would become `&#92;` (not exercised here because it does not round-trip).
