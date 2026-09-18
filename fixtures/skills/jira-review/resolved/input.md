# Offline Jira evidence

Fabricated snapshot, fetched 2026-09-17T09:00:00Z. All issue and Epic comments are included.
This bundle replaces live access. Image files are in this directory.

## PROJ-301

URL: https://example.internal/browse/PROJ-301
Type: Story. Updated: 2026-09-16T16:00:00Z.

```json
{
  "names": {"customfield_10009": "Epic Link"},
  "schema": {"customfield_10009": {"type": "any", "custom": "com.pyxis.greenhopper.jira:gh-epic-link"}},
  "fields": {"customfield_10009": "PROJ-300"}
}
```

Summary: Show the configured retention period.

Description D1: On the Admin settings page, show the existing configured export retention value
in a read-only field. This story changes display only. Editing retention, expiry scheduling and
other existing behavior are outside its scope.

AC1: Show "Retention (days)" with value 30 for the fixture account.
AC2: Show the field read-only, as in the approved target.
AC3: Existing settings-page error and loading conventions apply unchanged, as defined in Epic E2.

Comment 601, jsmith, 2026-09-14T08:00:00Z: Initial sketch 901 uses a value of 90. Awaiting decision.

Comment 602, jsmith, 2026-09-16T16:00:00Z: Decision for this story: the fixture account uses 30.
I updated AC1 and approved attachment 902. Attachment 901 is superseded. They have the same
filename; use the attachment ID. The current acceptance criteria and 902 are the target.

Comment coverage: 2 of 2, complete.

Attachment result: ID 901, filename `settings.png`, local path `901-settings.png`, image/png,
saved. ID 902, filename `settings.png`, local path `902-settings.png`, image/png, saved.
Batch complete. No other attachments.

## PROJ-300

URL: https://example.internal/browse/PROJ-300
Type: Epic. Updated: 2026-09-16T16:00:00Z. No comments or attachments, coverage complete.

E1: Export settings includes a retention display in PROJ-301 and an audit history in PROJ-302.
E2: Reuse the existing settings page. While loading, show its existing loading indicator. On
fetch failure, show its existing error banner with Retry; do not show a stale retention value.
E3: The retention value is account configuration, not an Epic-wide constant. Each display story
may use a different fixture value. This permission is intentional.
