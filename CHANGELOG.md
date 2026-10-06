# Changelog

## Unreleased

### Breaking changes

- Jira custom fields are read-only unless their `jira.fields` entry marks them editable:
  `"team": { "id": "customfield_10030", "editable": true }`. This includes aliases written as a
  plain string. Read-only aliases and unaliased custom fields move from the top level of working
  files to `readonly`. `lassi jira issue update` refuses a read-only field, from a working file or
  from `--field`, before sending anything (exit 2).
- When update already has the issue's edit metadata, it refuses a field Jira does not offer for
  editing (exit 5) instead of sending a request Jira would reject.

### Added

- `jira.fields` entries take `format: "wiki"` to show a field's Jira wiki markup as Markdown, and
  `exclude: true` to leave a field out of working files, issue output and exports.
- `lassi jira fields` and the generated `references/fields.md` show each alias's access and format.

### Upgrading

Run `lassi doctor`: it lists string aliases of custom fields, which are now read-only. Rewrite the
ones you edit as `{ "id": "customfield_…", "editable": true }`. Fetch working files again with
`lassi jira issue get <KEY> --out <file>`. The next `lassi jira issue export` renders unedited
archive files once more in the new layout, and the next `lassi search index` embeds them again.
Run `lassi skills install` to refresh the bundled agent skills. If the installer reports
conflicts, back up and review customized skills before using `--force`, which overwrites them.

## 0.1.0-alpha.7

### Breaking changes

- Jira issue comments, attachments, transitions, and links now live under `lassi jira issue`.
  Project component and version catalogs now live under `lassi jira project`.
- Confluence page comment listing and creation, and attachment downloads, now live under
  `lassi confluence page`. Comment deletion remains `lassi confluence comment delete <COMMENT_ID>`.

The previous paths for moved commands are no longer accepted. Arguments and options retain
their meanings. After upgrading, run `lassi skills install` to refresh the bundled agent skills.
Reuse the original target and selection options, including `--project <dir>` for project-local
skills; without `--project`, the installer targets the global `~/.agents/skills/` directory.
If the installer reports conflicts, back up and review customized skills before using `--force`,
which overwrites those files. Use `lassi help --all` for the current command reference.
