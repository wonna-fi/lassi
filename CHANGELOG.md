# Changelog

## Unreleased

### Breaking changes

- Jira issue comments, attachments, transitions, and links now live under `lassi jira issue`.
  Project component and version catalogs now live under `lassi jira project`.
- Confluence page comment listing and creation, and attachment downloads, now live under
  `lassi confluence page`. Comment deletion remains `lassi confluence comment delete <COMMENT_ID>`.

The previous paths for moved commands are no longer accepted. Arguments and options retain
their meanings. Refresh the bundled agent skills after upgrading, or use `lassi help --all`
for the current command reference.
