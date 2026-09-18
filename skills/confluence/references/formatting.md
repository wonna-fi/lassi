# Markdown ↔ Confluence storage format

You write GitHub-flavoured Markdown. The converter is deterministic, round-trips its own output and
refuses what it cannot express.

| Markdown | Storage | Notes |
|---|---|---|
| `# … ######` | `<h1>…</h1>` … | |
| `**b**`, `*i*`, `~~s~~`, `` `c` `` | `<strong>`, `<em>`, `<s>`, `<code>` | legacy `<b>`/`<i>` read fine but trip the gate |
| ```` ```lang ```` fence | code macro with `language` | fence meta `title=Foo.java` → macro parameters |
| ```` ```noformat ```` fence | noformat macro | |
| `- a`, `1. a`, nested | `<ul>`/`<ol start>` with `<li>` | loose lists (blank lines) → `<p>` items |
| `- [ ] a` / `- [x] a` | task list (`ac:task-list`) | one line per task; no mixing with plain items |
| `> quote` | `<blockquote>` | |
| `> [!NOTE] Title` / `[!TIP]` / `[!WARNING]` / `[!IMPORTANT]` | info / tip / warning / note panel | title on the marker line; `[!CAUTION]` is rejected |
| `[text](url "title")` | `<a href title>` | bare URLs and e-mails stay plain text |
| `[label](attachment:file.pdf)` | attachment link | label omitted when it equals the file name |
| `[[Page title]]`, `[[DEV:Page title]]`, `[[DEV:Page title|label]]` | page link | `[[:Title]]` when a bare title contains a colon |
| `@username` | user mention | validated; the page's own attribute (`userkey`/`username`) is kept |
| `@{userkey:abc}` | mention by key | placeholder for keys the directory could not resolve; write it back as is |
| `{jira:PROJ-1}` | Jira issue macro (single issue) | inline in text |
| `![alt](attachment:shot.png "width=300 height=200")` | `<ac:image>` with attributes | title words are `key=value` |
| `![alt](https://…/x.png)` | `<ac:image><ri:url/>` | |
| GFM table | `<table><tbody>…` | inline cells only; `<br />` inside a cell for a line break; an empty header row (`\| \| \|`) means "no header" |
| `<!-- toc -->`, `<!-- toc maxLevel=3 -->` | toc macro | |
| `---` | `<hr />` | |
| hard break | `<br />` | a lone `<br />` line is an empty paragraph |
| ```` ```confluence ```` fence | verbatim | escape hatch; contents are sent untouched |

## Reading

Storage → markdown keeps everything: constructs without a markdown form arrive verbatim inside
```` ```confluence ```` fences with a warning on stderr naming the construct (`raw fence:
macro:expand at /ac:structured-macro[2]`). Inside a paragraph the whole paragraph is fenced; inside
a table the whole table. Page layouts, page properties, `expand`, `status`, draw.io and other macros
are fenced whole. Leave fences alone when you edit; they go back byte for byte.

## The fidelity gate

`page update --file` re-reads the cached original storage, converts it to markdown and back, and
compares the result with the original after normalisation (server bookkeeping such as macro ids is
ignored). If the untouched parts of the page would change, the update exits 5 and lists the nodes:

```
/p[1]/b[1]: changed (page: b) (rewrite: strong)
```

Keep such regions in fences or leave the page to a human; `--force` rewrites them and is the human's
call. The gate is skipped (with a warning) when no cached original exists.

## Editor conventions

Confluence pages come in slightly different shapes (table shells, `<p>`-wrapped cells, mentions by
user key or username). The CLI infers the page's shape from the cached original and writes the same
shape, so an edited page looks unchanged to other editors. New pages use the plain shapes.

## Rejected (exit 5)

`[!CAUTION]`, footnotes, inline HTML other than `<br>`, HTML blocks other than the toc comment,
images that are neither `attachment:` nor `http(s)`, unresolved reference links, task lists mixed
with plain items, table rows wider than the header, unknown `@usernames`. Pasted XHTML outside a
fence is exit 2. The hint always names the ```` ```confluence ```` fence.
