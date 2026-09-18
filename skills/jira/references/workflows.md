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
lassi jira link list PROJ-123                 # blockers and dependencies with direction
lassi jira issue changelog PROJ-123 --since 7d   # who changed which field, when (oldest first)
```

Use `--json` when you need the raw field values (custom field ids, dates as strings).

## Comment

```sh
lassi jira comment add PROJ-123 --body "Reproduced on 2.3.1; the validator assumes a non-empty password." --dry-run
lassi jira comment add PROJ-123 --body "Reproduced on 2.3.1; the validator assumes a non-empty password."
```

For anything with structure write a file and pass `--file note.md` (or pipe markdown on stdin).
`comment edit PROJ-123 <ID>` replaces a body; `comment delete PROJ-123 <ID>` removes one of your
own comments (`--any` only when the human asked).

## Work a ticket through its working file

```sh
lassi jira issue get . --out work/PROJ-123.md       # "." = the issue on the current branch
# edit work/PROJ-123.md: frontmatter keys (summary, assignee, labels, aliases) and the description
lassi jira issue update . --file work/PROJ-123.md --if-unchanged --dry-run
lassi jira issue update . --file work/PROJ-123.md --if-unchanged
```

- Only changed keys and the description (when its markdown changed) are sent.
- Exit 6 means the issue moved on the server: run `issue get --out work/PROJ-123.md` again, re-apply
  the edit, send once more.
- Exit 2 mentioning generated sections: you edited `## Comments`/`## Attachments`/`## Links`; they are
  never sent, so restore or delete them.
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
lassi jira transition list PROJ-123                 # ids, names, target status, screen fields (* = required)
lassi jira transition do PROJ-123 "In Review" --dry-run
lassi jira transition do PROJ-123 Done --field resolution=Fixed --comment "Fixed in 2.3.1"
```

Names are matched case-insensitively; an id works too. A required screen field that is missing
exits 5 and the hint names `transition list`.

## Attachments

```sh
lassi jira attach get PROJ-123                      # all files to .lassi/PROJ-123/ (size cap from config)
lassi jira attach get PROJ-123 --only "*.log" --out ./tmp/PROJ-123
lassi jira attach upload PROJ-123 ./analysis.md ./trace.har --dry-run
lassi jira attach upload PROJ-123 ./analysis.md ./trace.har
```

Then read the returned paths with your own tools. Filenames include attachment IDs so duplicate names stay distinct. Identical repeat downloads report `unchanged`; different existing content is preserved with exit 6. Inspect every row on partial failure: successful files remain available, and failed rows include structured errors. Uploads stop at the first failure and report how
many landed; files above `attachments.maxSizeMb` are refused before anything is sent.

## Links

```sh
lassi jira link types                               # names with inward/outward phrases
lassi jira link create PROJ-1 PROJ-2 --type "is blocked by" --dry-run   # prints the resolved sentence
lassi jira link create PROJ-1 PROJ-2 --type "is blocked by"
```

Either the outward or the inward phrase is accepted; the CLI flips the direction and prints the
sentence it will create.

## Recover from errors

1. Read the JSON line on stderr: `code`, `message`, `errors` (Jira's field map, verbatim),
   `errorsByAlias`, `hint`.
2. Do what the hint says (usually a `createmeta`/`editmeta`/`transition list` lookup or a re-fetch).
3. Retry once. If it fails again, stop and report the JSON to the human.
