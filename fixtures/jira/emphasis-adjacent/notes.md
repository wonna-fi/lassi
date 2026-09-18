---
section: "Text Formatting Notation Help — Text Effects"
direction: read
---
Two spans of the same kind with nothing between them merge into one. Markdown cannot keep them
apart: one marker written twice over (`**a****z**`) is a single delimiter run and reparses as one
span, and the other marker for the same construct only works away from word characters, so a run of
even length between two of them has no spelling at all. Two adjacent bold spans render exactly as
one containing both, so this is a normalisation  and a fixed point.
