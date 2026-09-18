# Confluence workflows

Reads first, `page validate` and `--dry-run` before the first write, one retry at most. Replace
`123456`, `DEV` and the titles with the real values.

## Find and read

```sh
lassi confluence search 'space = DEV and title ~ "payment"' --limit 20
lassi confluence tree DEV --depth 2                     # space homepage and two levels below
lassi confluence page get 123456                        # or "DEV:Payment design", or the page URL
lassi confluence page get 123456 --comments --attachments
lassi confluence page get 123456 --format view          # what the renderer shows (read-only)
```

The trailer under a page says what is hidden (`(3 comments, 2 attachments, 4 child pages not
shown — use --comments, --attachments, `lassi confluence tree <ID>`)`).

## Edit a page through its working file

```sh
lassi confluence page get 123456 --out work/page.md
# edit work/page.md: the body, and title/parent in the frontmatter
lassi confluence page validate --file work/page.md      # server-side parse, nothing saved
lassi confluence page update --file work/page.md --dry-run
lassi confluence page update --file work/page.md
```

- Exit 6: the page changed on the server. Re-run `page get 123456 --out work/page.md`, re-apply the
  edit, send once more.
- Exit 5 "content the markdown dialect cannot preserve": the page holds constructs the round trip
  would change (legacy `<b>`/`<i>` tags, `thead` tables, styled spans, …). The JSON lists the nodes.
  Do **not** pass `--force` on your own; report the list to the human.
- Exit 2 mentioning generated sections: restore or delete `## Comments` / `## Attachments`.
- After success the file is rewritten from the server (version bumped); re-read it before editing
  again.

## Create a page

```sh
cat > runbook.md <<'MD'
---
title: Payment service runbook
space: DEV
parent: 123400
---

# Payment service runbook

> [!NOTE] Owner
> @jsmith

## Restart

1. `systemctl restart payment`
2. Check [[DEV:Payment dashboard]].
MD
lassi confluence page validate --file runbook.md
lassi confluence page create --file runbook.md --dry-run    # frontmatter supplies title/space/parent
lassi confluence page create --file runbook.md
```

Flags win over frontmatter: `--space`, `--title`, `--parent`. `--space` falls back to
`confluence.defaultSpace`.

## Rename or move without touching the body

```sh
lassi confluence page update 123456 --title "Payment service design (v2)"
lassi confluence page update 123456 --parent 100
```

## Comments

```sh
lassi confluence comment list 123456
lassi confluence comment add 123456 --body "Reviewed the failover section; two questions inline." --dry-run
lassi confluence comment add 123456 --body "Reviewed the failover section; two questions inline."
lassi confluence comment delete 777                     # own comments only; --any if the human asked
```

## Attachments

```sh
lassi confluence attach get 123456                      # to .lassi/123456/ (size cap from config)
lassi confluence attach get 123456 --only "*.pdf" --out ./tmp/123456
```

Then read the files with your own tools. If a download yields an HTML page instead of the file, the
CLI stops and names the `confluence.downloadUrlSuffix` setting for the human.

## Learn a space's conventions

```sh
lassi confluence stats macros --space DEV --limit 100
```

Shows which macros the space uses, the editor conventions (table shell, cell wrapping, mention
attribute, layouts) and which constructs end up in raw fences; use it to decide whether a page is a
good candidate for the working-file flow.

## Recover from errors

1. Read the JSON line on stderr: `code`, `message`, `errorMessages` (the gate's node list or the
   server's parse error), `hint`.
2. Do what the hint says.
3. Retry once. If it fails again, stop and report the JSON to the human.
