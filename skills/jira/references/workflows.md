# Jira workflows

Every sequence below is safe to run as written: reads first, `--dry-run` before the first write,
one retry at most. Replace `PROJ-123`, `PROJ` and `Bug` with the real key, project and type. Inside
a git checkout, `.` in place of `PROJ-123` means the issue named by the current branch
(`feature/PROJ-123-login` → `PROJ-123`); exit 2 tells you when the branch names no issue.

## Start of day

```sh
lassi jira digest                              # since 1d: mentions of you, your issues that changed, what you did
lassi jira digest --since 1w --jql 'project = PROJ'   # a longer window, one project
lassi jira issue get PROJ-123 --comments 5     # then read the issue behind a line that needs you
```

Each line names an issue key; `--json` gives the full model. `--since` takes `2h`, `1w`,
`2026-09-01` (local midnight) or an ISO date-time.

## Read an issue and decide what to do

```sh
lassi jira issue get PROJ-123                 # frontmatter + description; the trailer says what is hidden
lassi jira issue get PROJ-123 --comments 5    # newest five comments
lassi jira issue get PROJ-123 --all           # comments, attachments, links
lassi jira issue link list PROJ-123                 # blockers and dependencies with direction
lassi jira issue changelog PROJ-123 --since 7d   # who changed which field, when (oldest first)
```

Use `--json` when you need the raw field values (custom field ids, dates as strings).

## Comment

```sh
lassi jira issue comment add PROJ-123 --body "Reproduced on 2.3.1; the validator assumes a non-empty password." --dry-run
lassi jira issue comment add PROJ-123 --body "Reproduced on 2.3.1; the validator assumes a non-empty password."
```

For anything with structure write a file and pass `--file note.md` (or pipe markdown on stdin).
`comment edit PROJ-123 <ID>` replaces a body; `comment delete PROJ-123 <ID>` removes one of your
own comments (`--any` only when the human asked).

## Work a ticket through its working file

```sh
lassi jira issue get . --out work/PROJ-123.md       # "." = the issue on the current branch
# edit work/PROJ-123.md: top-level frontmatter keys (summary, assignee, labels, editable aliases)
# and the description; the keys under `readonly` are never sent
lassi jira issue update . --file work/PROJ-123.md --if-unchanged --dry-run
lassi jira issue update . --file work/PROJ-123.md --if-unchanged
```

- Only changed keys and the description (when its markdown changed) are sent.
- Exit 6 means the issue moved on the server: run `issue get --out work/PROJ-123.md` again, re-apply
  the edit, send once more.
- Exit 2 mentioning generated sections: you edited `## Comments`/`## Attachments`/`## Links`; they are
  never sent, so restore or delete them.
- Exit 2 "read-only field": that custom field is not marked editable in `jira.fields`. Leave it
  alone, or ask the human to mark it editable.
- Exit 5 "Jira does not let … be updated through …": the issue's edit screen does not offer that
  field. Drop the change; if the hint says the metadata was cached, run `issue editmeta <KEY>` once
  and retry.
- After success the file is rewritten from the server; re-read it before editing again.

## Create an issue with required fields

```sh
lassi jira templates                                # configured templates: type, project, fields, skeleton
lassi jira templates bug --out desc.md              # only the skeleton lands in the file; fill it in, keep the headings
lassi jira issue create --template bug --summary "Login page throws 500 on empty password" --file desc.md --dry-run
lassi jira fields                                   # alias table (also references/fields.md)
lassi jira issue createmeta PROJ --type Bug         # required fields and allowed values for this type
lassi jira issue create --project PROJ --type Bug --summary "Login page throws 500 on empty password" \
  --field priority=High --file description.md --dry-run
lassi jira issue create --project PROJ --type Bug --summary "Login page throws 500 on empty password" \
  --field priority=High --file description.md
```

Add any required `--field alias=value` entries reported by `createmeta` to the commands above.
Missing required fields fail before the create request (exit 5) and the hint repeats the `createmeta`
command. `--project` defaults to `jira.defaultProject` when configured. A template supplies
type, project, summary, fields and the description; every flag and `--field` you pass wins over it.

## Transition

```sh
lassi jira issue transition list PROJ-123                 # ids, names, target status, screen fields (* = required)
lassi jira issue transition do PROJ-123 "In Review" --dry-run
lassi jira issue transition do PROJ-123 Done --field resolution=Fixed --comment "Fixed in 2.3.1"
```

Names are matched case-insensitively; an id works too. A required screen field that is missing
exits 5 and the hint names `transition list`.

## Attachments

```sh
lassi jira issue attach get PROJ-123                      # all files to .lassi/PROJ-123/ (size cap from config)
lassi jira issue attach get PROJ-123 --only "*.log" --out ./tmp/PROJ-123
lassi jira issue attach upload PROJ-123 ./analysis.md ./trace.har --dry-run
lassi jira issue attach upload PROJ-123 ./analysis.md ./trace.har
```

Then read the returned paths with your own tools. Filenames include attachment IDs so duplicate names stay distinct. Identical repeat downloads report `unchanged`; different existing content is preserved with exit 6. Inspect every row on partial failure: successful files remain available, and failed rows include structured errors. Uploads stop at the first failure and report how
many landed; files above `attachments.maxSizeMb` are refused before anything is sent.

## Links

```sh
lassi jira link types                               # names with inward/outward phrases
lassi jira issue link create PROJ-1 PROJ-2 --type "is blocked by" --dry-run   # prints the resolved sentence
lassi jira issue link create PROJ-1 PROJ-2 --type "is blocked by"
lassi jira issue link delete PROJ-1 PROJ-2 --type "is blocked by" --dry-run   # the link `link list PROJ-1` shows that way
```

Either the outward or the inward phrase is accepted; the CLI flips the direction and prints the
sentence it will create. `link delete` takes the sentence as `link list` prints it; when it names
no link, the error lists the links that do exist between the two issues.

## Components and fix versions

```sh
lassi jira project component list PROJ                                   # the project's components
lassi jira issue component add PROJ-123 Backend "Data import" --dry-run
lassi jira issue component add PROJ-123 Mobile --create          # creates Mobile in PROJ first
lassi jira issue component remove PROJ-123 Backend
lassi jira project version list PROJ                                     # versions an issue can take
lassi jira issue fix-version set PROJ-123 2.1                    # replaces the fix versions
lassi jira issue fix-version set PROJ-123 2.2 --add              # keeps the ones it has
```

Names match in any case and every name is checked before anything is sent. `issue component add`
leaves the issue's other components alone, refuses a component the project does not have unless
`--create` is passed, and never creates one for an archived name; creating needs the Administer
Projects permission. `issue component remove` refuses a component the issue does not have. A fix
version is always one of the project's versions that is not archived; the error lists them, and
setting one needs the Resolve Issues permission. Prefer these commands to
`issue update --field components=…` or `fixVersions=…`, which replace the whole list unchecked.

## Recover from errors

1. Read the JSON line on stderr: `code`, `message`, `errors` (Jira's field map, verbatim),
   `errorsByAlias`, `hint`.
2. Do what the hint says (usually a `createmeta`/`editmeta`/`transition list` lookup or a re-fetch).
3. Retry once. If it fails again, stop and report the JSON to the human.
