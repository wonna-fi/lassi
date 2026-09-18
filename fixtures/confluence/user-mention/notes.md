---
section: "Confluence Storage Format — User mentions (userkey)"
direction: both
roundtrip: true
writer: {mentionAttribute: userkey}
users: {k1abc: jsmith}
---
The first key is in the directory; the second is not and reads as the `@{userkey:…}` placeholder, which writes back verbatim.
