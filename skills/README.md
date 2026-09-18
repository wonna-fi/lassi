# Agent skills

`lassi skills install` installs `jira` and `confluence` under `~/.agents/skills/`.
Use `--project <dir>` for `<dir>/.github/skills/`. Both skills use Markdown working files and
structured CLI errors. Review and adapt the instructions for your workflow.

The installer generates command references and configured Jira field aliases and link types.
These generated references can contain private instance information. Keep installed skill copies
local; the package contains only generic templates. Modified instructions are preserved unless
you explicitly pass `--force`. Back them up and merge updates before using that option.

The optional `jira-review` skill is an experimental requirements review workflow. Install its
`SKILL.md` and `references/` manually beside the `jira` skill. It is not installed by default.
