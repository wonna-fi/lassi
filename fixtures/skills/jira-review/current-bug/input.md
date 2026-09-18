# Offline Jira evidence

Fabricated snapshot fetched 2026-09-17T17:00:00Z. All listed issue and Epic comments are included.
This bundle replaces live access. The referenced image file is supplied alongside this input.

## PROJ-501

URL: https://example.internal/browse/PROJ-501
Type: Sub-task. Updated: 2026-09-17T15:00:00Z.

```json
{
  "names": {"parent": "Parent"},
  "fields": {"parent": {"key": "PROJ-502", "fields": {"issuetype": {"name": "Story"}}}}
}
```

Summary: Correct the Viewer Delete button state.

D1: The current export page incorrectly styles Delete as enabled for Viewers. Correct its disabled
state. The existing server permission check already denies deletion, and does not change here.

AC1: On the completed-export page, the Delete button is disabled for the Viewer role.
AC2: Other roles keep their existing button states. Existing page behavior otherwise stays unchanged.

Comment 801, jsmith, 2026-09-17T15:00:00Z: Attachment 1101 records the current bug, before the fix.
It is not a proposed target design. This task implements the Viewer behavior defined by our parent
story and its Epic.

Comment coverage: 1 of 1, complete. Links: relates to PROJ-599, a design discussion, not a parent.

Attachment result: ID 1101, filename `export.png`, local path `1101-export.png`, image/png, saved.
Batch complete. No other attachments.

## PROJ-502

URL: https://example.internal/browse/PROJ-502
Type: Story. Updated: 2026-09-17T14:00:00Z. No comments or attachments, coverage complete.

```json
{
  "names": {"customfield_10003": "Epic Link"},
  "schema": {"customfield_10003": {"type": "any", "custom": "com.pyxis.greenhopper.jira:gh-epic-link"}},
  "fields": {"customfield_10003": "PROJ-500"}
}
```

D1: Apply the existing export permission policy consistently in the UI. PROJ-501 fixes the Viewer
control. Other subtasks cover the Admin and Editor controls. The server permission policy is unchanged.

## PROJ-500

URL: https://example.internal/browse/PROJ-500
Type: Epic. Updated: 2026-09-16T14:00:00Z. No comments or attachments, coverage complete.

E1: Viewers cannot delete completed exports. The UI must show the Delete control disabled for Viewers.
E2: Keep the existing export-page loading and error behavior. This release changes permission display
only, not retention, export formats, or backend permission enforcement.
