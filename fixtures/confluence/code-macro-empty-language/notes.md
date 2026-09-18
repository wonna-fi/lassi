---
section: "Confluence Storage Format — Code block macro (empty language)"
direction: both
roundtrip: true
---
An empty `language` parameter is still a parameter. It leaves nothing in the fence meta, so an
ordinary fence would read cleanly and write back without the parameter, which the fidelity gate then
refuses. The converter refuses parameters that cannot be preserved, including this one.
