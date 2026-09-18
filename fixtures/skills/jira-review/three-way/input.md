# Offline Jira evidence

Fabricated snapshot, fetched 2026-09-17T09:00:00Z. All issue and Epic comments are included.
This bundle replaces live access. Image files are in this directory.

## PROJ-201

URL: https://example.internal/browse/PROJ-201
Type: Story. Updated: 2026-09-16T14:00:00Z.

Field metadata returned with the issue:

```json
{
  "names": {"customfield_10007": "Epic Link", "customfield_10008": "Acceptance criteria"},
  "schema": {"customfield_10007": {"type": "any", "custom": "com.pyxis.greenhopper.jira:gh-epic-link"}},
  "fields": {"customfield_10007": "PROJ-200", "customfield_10008": "AC1: Remove completed exports after 7 days. AC2: Offer XLSX export in release 1. AC3: The Delete button is disabled for the Viewer role."}
}
```

Summary: Add export controls for release 1.

Description D1: Add the export controls to the existing export screen. Existing application
conventions apply to everything this story does not change.

Description D2: Keep completed exports for 14 days.

Comment 501, jsmith, 2026-09-16T14:00:00Z: Attachment 801 is the approved target for the Viewer
state in release 1. It illustrates controls and permission states, not retention or file formats.

Comment coverage: 1 of 1, complete. Links: relates to PROJ-999, a discovery spike, not an Epic.

Attachment result: ID 801, filename `export.png`, local path `801-export.png`, image/png,
saved. Batch complete. No other attachments.

## PROJ-200

URL: https://example.internal/browse/PROJ-200
Type: Epic. Updated: 2026-09-15T08:00:00Z. No comments or attachments, coverage complete.

E1: Release 1 supports CSV export only. XLSX export is explicitly out of scope until release 2.
E2: This Epic does not set export retention. Each story defines its own retention period.
E3: Other stories cover the import screen and audit history. They are not part of PROJ-201.
