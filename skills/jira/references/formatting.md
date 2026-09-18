# Markdown ↔ Jira wiki markup

You write GitHub-flavoured Markdown. The converter is deterministic and round-trips its own output;
these are the forms it produces and accepts.

| Markdown | Wiki markup | Notes |
|---|---|---|
| `# … ######` | `h1. … h6.` | a heading cannot contain a hard break |
| `**bold**`, `*italic*`, `~~struck~~` | `*bold*`, `_italic_`, `-struck-` | inside a word Jira needs `{*}bold{*}`; the CLI picks the form |
| `` `code` `` | `{{code}}` | `|` inside inline code in a table cell becomes `&#124;` |
| ```` ```lang ```` fence | `{code:lang}…{code}` | no lang → `{code}`; lang `noformat` → `{noformat}` |
| `- a` / `* a`, nested by indentation | `* a`, `** b` | |
| `1. a`, nested | `# a`, `## b` | start numbers are dropped (warning) |
| `- [ ] task` / `- [x] done` | `* (x) task` / `* (/) done` | Jira has no tasks; the prefix is the convention |
| `> quote` | `bq. quote` (one line) or `{quote}…{quote}` | |
| `[text](url)` | `[text|url]` | bare URLs stay bare; link titles are dropped |
| `@username` | `[~username]` | validated before sending |
| `![alt](attachment:file.png)` | `!file.png!` | title words → parameters: `"thumbnail"`, `"width=300 height=200"` |
| `[spec.pdf](attachment:spec.pdf)` | `[^spec.pdf]` | attachment links |
| GFM table | `\|\|h\|\|h\|\|` then `\|c\|c\|` | inline cells only; block content in a cell exits 5 |
| `---` | `----` | |
| hard break (`\` at line end, or two spaces) | newline or `\\` | soft breaks become spaces |
| `<span style="color:red">text</span>` | `{color:red}text{color}` | the only inline HTML accepted |
| ```` ```jira ```` fence | verbatim | escape hatch; contents are sent untouched |

## Escaping

Characters that would start wiki markup (`*`, `_`, `{`, `[`, `!`, `|`, line-start `#`/`-`/`h1.`)
are escaped only where Jira would otherwise interpret them, so `snake_case`, `2*3*4`, `C++` and
`[1]` survive. A paragraph that starts with `h1.` or `bq.` cannot be represented (exit 5); put it in
inline code.

## Reading

Wiki → markdown is tolerant: anything the dialect cannot carry (panels, `{expand}`, `{anchor}`,
emoticons, `+inserted+`, `??citation??`, tables with per-cell headers) arrives verbatim inside a
```` ```jira ```` fence, so nothing is lost. When you edit around such a fence, leave it as it is; it
is sent back exactly. Image parameters (`|width=…,height=…`) travel in the image title.

## Warnings

Lossy-but-legal conversions are reported on stderr (`warn: …`) and the write proceeds: a list item
holding a block other than a nested list is split out of the list; a numbered list's start number is
dropped; a link label with formatting is flattened; a link title is dropped; fence meta is dropped; a
backslash before a special character is written as `&#92;`.

## Rejected (exit 5)

Block content inside table cells, footnotes, inline HTML other than the colour span, images that are
neither `attachment:` nor `http(s)`, unresolved reference links. The hint always names the
```` ```jira ```` fence as the way to send raw markup on purpose.
