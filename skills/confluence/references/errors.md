# Errors and hints (Confluence)

Every failure prints one human line and one JSON line on stderr; stdout stays empty. Parse the JSON.

```json
{"code":"validation","message":"page 123456 holds content the markdown dialect cannot preserve (1 node would change)","errorMessages":["/p[1]/b[1]: changed (page: b) (rewrite: strong)"],"hint":"keep those regions in ```confluence fences, or pass --force to rewrite them"}
```

| Exit | `code` | Typical cause | What to do |
|---|---|---|---|
| 0 | | success (also `--dry-run`, "no changes") | continue |
| 1 | `network`, `tls`, `timeout`, `http`, `internal` | instance unreachable, certificate not trusted, 5xx after retries | `lassi doctor`; TLS → the human sets `NODE_EXTRA_CA_CERTS`; retry once at most |
| 2 | `usage` | bad flag, pasted storage XHTML, edited generated sections, unknown frontmatter key, `--format view` file, space move | fix the file or command as the message says |
| 3 | `auth` | 401/403, anonymous answer, expired token | stop; tell the human which token file and to run `lassi doctor` |
| 4 | `not_found` | unknown page id, title, space or comment | `lassi confluence search` to look it up |
| 5 | `validation` | server parse error (`message` from the server, `request` names the endpoint), fidelity gate (`errorMessages` lists the nodes), unknown `@mention`, unrepresentable markdown, comment not yours | fix the markdown; keep raw regions in fences; `--force`/`--any` only if the human asked |
| 6 | `conflict` | the page changed on the server since the fetch (409, or version drift) | `lassi confluence page get <ID> --out <same file>`, re-apply the edit, retry once |
| 7 | `read_only` | `LASSI_READ_ONLY` is set | stop; writes are disabled on purpose |

## Hint catalogue

| Situation | Hint you will see |
|---|---|
| Version drift | `lassi confluence page get <ID> --out <file>` and re-apply your edit |
| Fidelity gate | keep the regions in ```` ```confluence ```` fences, or `--force` |
| Server parse error on update | `lassi confluence page validate --file <file>`, or `page get <ID> --format storage` to inspect the original |
| Pasted XHTML | wrap intentional markup in a ```` ```confluence ```` fence |
| Unknown mention | mentions are usernames; `@{userkey:…}` placeholders are kept |
| Missing cache for `--file` | the gate is skipped with a warning; `page get --out` refreshes the cache |
| Download returned HTML | ask the human to set `confluence.downloadUrlSuffix` |
| 401 | the token file path and `lassi doctor` |
| TLS | `NODE_EXTRA_CA_CERTS` |
| Read-only block | the name of the environment variable |

Rule 3 applies to all of them: follow the hint, retry once, then ask the human.
