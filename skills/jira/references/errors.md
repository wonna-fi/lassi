# Errors and hints (Jira)

Every failure prints one human line and one JSON line on stderr; stdout stays empty. Parse the JSON.

```json
{"code":"validation","http":400,"message":"…","errors":{"customfield_10001":"Category is required."},"errorsByAlias":{"category":"Category is required."},"hint":"Run `lassi jira issue createmeta PROJ --type Bug` …","request":{"method":"POST","url":"/rest/api/2/issue"}}
```

| Exit | `code` | Typical cause | What to do |
|---|---|---|---|
| 0 | | success (also `--dry-run`, "no changes") | continue |
| 1 | `network`, `tls`, `timeout`, `http`, `internal` | instance unreachable, certificate not trusted, 5xx after retries | run `lassi doctor`; TLS → the human must set `NODE_EXTRA_CA_CERTS`; do not retry more than once |
| 2 | `usage` | bad flag, unknown field alias, unparsable input, pasted wiki markup, missing cache for `--file` | fix the command; hints name `lassi jira fields`, `lassi jira issue editmeta <KEY>`, or `issue get --out` |
| 3 | `auth` | 401/403, empty or expired token | stop; tell the human which token file is in `tokenFile` and to run `lassi doctor` |
| 4 | `not_found` | unknown key, project, user or comment id | check the key; `lassi jira issue search` to look it up |
| 5 | `validation` | Jira's field errors (`errors` verbatim, `errorsByAlias` by alias), missing required fields, unknown `@mention`, unrepresentable markdown, comment not yours | fix the fields or the markdown; hints name `createmeta`/`editmeta`/`transition list`; `--any` only if the human asked |
| 6 | `conflict` | `--if-unchanged` drift, 409 | `lassi jira issue get <KEY> --out <same file>`, re-apply the edit, retry once |
| 7 | `read_only` | `LASSI_READ_ONLY` is set | stop; writes are disabled on purpose |

## Hint catalogue

| Situation | Hint you will see |
|---|---|
| Missing required field on create | `lassi jira issue createmeta <P> --type <T>` and the aliases of the missing ids |
| Unknown field on update | `lassi jira issue editmeta <KEY>` |
| Invalid option value | the allowed values from metadata |
| Transition failed on screen fields | `lassi jira transition list <KEY>` |
| 401 | the token file path and `lassi doctor` |
| TLS | `NODE_EXTRA_CA_CERTS` (and `NODE_USE_ENV_PROXY=1` behind a proxy) |
| Read-only block | the name of the environment variable |
| Pasted wiki markup | wrap intentional markup in a ```` ```jira ```` fence |
| Unknown mention | mentions are usernames, not display names |

Rule 3 applies to all of them: follow the hint, retry once, then ask the human.
