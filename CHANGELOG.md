# Changelog

## 0.1.0-alpha.7

### Breaking changes

- Jira issue comments, attachments, transitions, and links now live under `lassi jira issue`.
  Project component and version catalogs now live under `lassi jira project`.
- Confluence page comment listing and creation, and attachment downloads, now live under
  `lassi confluence page`. Comment deletion remains `lassi confluence comment delete <COMMENT_ID>`.

The previous paths for moved commands are no longer accepted. Arguments and options retain
their meanings. After upgrading, run `lassi skills install` to refresh the bundled agent skills.
If the installer reports conflicts, back up and review customized skills before using `--force`,
which overwrites those files. Use `lassi help --all` for the current command reference.
