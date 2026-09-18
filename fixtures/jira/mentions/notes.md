---
section: "Text Formatting Notation Help — Links (user mentions)"
direction: both
---
`[~user]` becomes `@user`; e-mail addresses stay plain text (the `@` is escaped so the address never
re-parses as a mention or an autolink). A mention glued to a preceding word (`x[~y]`) cannot be
expressed in markdown and is a known limitation.
