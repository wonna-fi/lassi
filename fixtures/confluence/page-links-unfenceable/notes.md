---
section: "Confluence Storage Format — Links to pages"
direction: read
roundtrip: false
---
A `[[Title|body]]` link is one line and ends at the first `]]`, so a body carrying `]]`, a line
ending, or a trailing `]` cannot be written as one: the trailing bracket pairs with the first
bracket of the closing marker and cuts the body one character short. `page-links-delimiters` covers
the delimiters that are representable.
