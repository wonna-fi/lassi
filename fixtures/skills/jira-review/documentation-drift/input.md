# Offline Jira evidence

Fabricated snapshot fetched 2026-09-17T17:00:00Z. The description, acceptance criteria, all comments,
all fields and attachment metadata are included. This bundle replaces live access.

## PROJ-601

URL: https://example.internal/browse/PROJ-601
Type: Story. Updated: 2026-09-17T15:00:00Z.

```json
{
  "names": {"customfield_10004": "Epic Link"},
  "schema": {"customfield_10004": {"type": "any", "custom": "com.pyxis.greenhopper.jira:gh-epic-link"}},
  "fields": {"customfield_10004": null, "parent": null}
}
```

Summary: Set the completed-export retention period.

D1: Keep completed exports for 14 days, then remove them. Existing expiry scheduling and all other
export behavior remain unchanged. This story changes only the retention value.

AC1: Remove completed exports after 7 days.

Comment 901, jsmith, 2026-09-16T15:00:00Z: Should retention be 7 or 14 days?

Comment 902, jsmith, 2026-09-17T15:00:00Z: Accepted decision for this story: retention is 14 days.
I updated D1 to match. AC1 still has the old 7-day value and needs updating. This decision replaces
the 7-day proposal. Do not reopen the retention choice unless requirements change.

Comment coverage: 2 of 2, complete. Attachment metadata: empty, 0 attachments. No issue links.
Epic Link is explicitly null in the complete field response; this story has no linked Epic.
