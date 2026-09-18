---
section: "Confluence Storage Format — Unknown macros"
direction: both
roundtrip: true
---
A macro whose name is a member of `Object.prototype` is an unknown macro like any other. The panel
lookup used `in`, which walks the prototype chain, so this entered the panel branch with a kind that
is a function and killed the writer.
