---
section: "Confluence Storage Format — Code block macro"
direction: both
roundtrip: true
---
The language becomes the fence language, other parameters the fence meta (`title=Foo.java`); `ac:macro-id` and `ac:schema-version` are server bookkeeping; a literal `]]>` in the body is split across CDATA sections.
