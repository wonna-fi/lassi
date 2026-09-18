import type { Command } from 'commander';
import { LassiError, formatLocal, parseAtlassianDate, parseSince } from '@wonna/lassi-core';
import {
  assertDigestClause,
  buildDigest,
  digestJql,
  type Digest,
  type JiraClient,
  type JiraComment,
  type JiraIssue,
} from '@wonna/lassi-jira';
import type { CliDeps } from '../../deps.js';
import { truncate } from '../../output/axi.js';
import { attach, type Session } from '../../run-command.js';
import { aliasesOf, jiraClient } from './shared.js';

interface DigestOptions {
  since?: string;
  jql?: string;
  limit?: string;
}

const FIELDS = ['summary', 'status', 'assignee', 'reporter', 'updated', 'comment'];

const COMMENT_PAGE = 100;

/**
 * A search returns a cut comment container for a busy issue. Page newest-first for those only,
 * and stop at the first page whose oldest comment precedes the window: everything older is
 * irrelevant, so the container is complete for the digest without fetching the whole history.
 */
async function completeComments(
  client: JiraClient,
  issues: JiraIssue[],
  since: Date
): Promise<void> {
  const busy = issues.filter((issue) => {
    const container = issue.fields.comment;
    return container !== undefined && container.total > container.comments.length;
  });
  // Shared across the pool: one worker's failure has to stop the others, including one that is
  // partway through paging a busy issue's comments.
  let failure: unknown;
  const complete = async (issue: JiraIssue): Promise<void> => {
    const container = issue.fields.comment as NonNullable<JiraIssue['fields']['comment']>;
    const pages: JiraComment[][] = [];
    let total = container.total;
    let fetched = 0;
    for (;;) {
      // Checked per page, not just per issue: an issue with more than one page of comments would
      // otherwise fetch all of them after another worker had already failed.
      if (failure !== undefined) return;
      const page = await client.listComments(issue.key, {
        limit: COMMENT_PAGE,
        startAt: fetched,
        newest: true,
      });
      total = page.total;
      fetched += page.comments.length;
      pages.unshift(page.comments);
      if (page.comments.length === 0 || fetched >= total) break;
      const oldest = parseAtlassianDate(page.comments[0]?.created ?? '');
      if (oldest !== undefined && oldest.getTime() < since.getTime()) break;
    }
    const comments = pages.flat();
    // The container describes what it holds: the newest `comments.length` of `total`. Claiming
    // startAt 0 and maxResults total would be a lie about a page nobody asked for.
    issue.fields.comment = {
      comments,
      total,
      startAt: Math.max(0, total - comments.length),
      maxResults: comments.length,
    };
  };
  // A busy issue costs a round trip each, and they are independent; serially, thirty of them meant
  // thirty waits after the two searches that found them.
  let cursor = 0;
  const worker = async (): Promise<void> => {
    // `Promise.all` rejects on the first failure and leaves the rest pulling entries, which would go
    // on issuing requests after the command had already reported the error.
    while (failure === undefined && cursor < busy.length) {
      try {
        await complete(busy[cursor++] as JiraIssue);
      } catch (err) {
        failure ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, busy.length) }, worker));
  if (failure !== undefined) throw failure;
}

const arrow = (from: string, to: string): string => `${from || '-'} → ${to || '-'}`;

function section(title: string, count: number, body: string[]): string[] {
  return [`## ${title} (${count})`, '', ...(body.length === 0 ? ['nothing'] : body)];
}

function issueBlock(i: Digest['changed'][number]): string[] {
  const events = [
    ...i.changes.map((c) => ({
      at: c.at,
      line: `- ${c.at} ${c.who} ${c.field}: ${arrow(c.from, c.to)}`,
    })),
    ...i.comments.map((c) => ({ at: c.at, line: `- ${c.at} ${c.who} commented: "${c.body}"` })),
  ]
    .sort(
      (a, b) =>
        (parseAtlassianDate(a.at)?.getTime() ?? 0) - (parseAtlassianDate(b.at)?.getTime() ?? 0)
    )
    .map((e) => e.line);
  const note = i.partial
    ? [`- (Jira cut this changelog; run \`lassi jira issue changelog ${i.key}\`)`]
    : [];
  return [`### ${i.key} ${i.summary} (${i.status})`, '', ...events, ...note];
}

export function renderDigest(d: Digest): string {
  const head = `# Jira digest for ${d.me} since ${formatLocal(new Date(d.since))} (${d.sinceText})`;
  if (d.totals.mentions + d.totals.changed + d.totals.actions === 0) {
    // A cut search may hide real events, so the definitive line is only for a complete one.
    const line =
      d.truncated.mine || d.truncated.mentions
        ? `nothing found among the fetched issues since ${d.sinceText}; the search returned more issues than were fetched (raise --limit or narrow --jql)`
        : `nothing happened on your issues since ${d.sinceText}`;
    return `${head}\n\n${line}\n`;
  }
  const mentions = d.mentions.map(
    (m) => `- ${m.key} ${m.summary} — ${m.who}, ${m.at}: "${m.body}"`
  );
  const changed = d.changed.flatMap((i, n) => (n === 0 ? issueBlock(i) : ['', ...issueBlock(i)]));
  const actions = d.actions.map((a) => `- ${a.at} ${a.key} ${a.what}`);
  return `${[
    head,
    '',
    ...section('Mentioned you', d.totals.mentions, mentions),
    '',
    ...section('Your issues that changed', d.totals.changed, changed),
    '',
    ...section('What you did', d.totals.actions, actions),
  ].join('\n')}\n`;
}

function digestAxi(d: Digest): Record<string, unknown> {
  return {
    me: d.me,
    since: d.since,
    counts: d.totals,
    truncated: d.truncated,
    mentions: d.mentions.map((m) => ({ key: m.key, who: m.who, at: m.at, body: truncate(m.body) })),
    changed: d.changed.map((i) => ({
      key: i.key,
      summary: truncate(i.summary),
      status: i.status,
      changes: i.changes.map((c) => `${c.who} ${c.field}: ${arrow(c.from, c.to)}`),
      comments: i.comments.map((c) => `${c.who}: ${truncate(c.body)}`),
      partial: i.partial,
    })),
    actions: d.actions.map((a) => ({ key: a.key, at: a.at, what: truncate(a.what) })),
  };
}

export function registerDigest(jira: Command, deps: CliDeps, session: Session): void {
  const digest = jira
    .command('digest')
    .description(
      'what happened on your issues since --since (default 1d): comments that mention you, changes and comments by others on issues you own or watch, and what you did'
    )
    .option(
      '--since <when>',
      'window start: 30m, 2h, 1d (default), 1w, YYYY-MM-DD or an ISO 8601 date-time'
    )
    .option('--jql <clause>', 'narrow every section with AND (<clause>)')
    .option('--limit <N>', 'issues per section (default 50)');
  attach<[], DigestOptions>(digest, deps, session, {
    kind: 'read',
    async run(ctx, _args, opts) {
      const since = parseSince(opts.since ?? '1d', deps.now());
      const limit = opts.limit === undefined ? 50 : Number(opts.limit);
      if (!Number.isFinite(limit) || limit <= 0)
        throw new LassiError('usage', `--limit must be a positive number, got "${opts.limit}"`);
      // Also validated inside digestJql, for its own library callers. Here it runs before the
      // client is built, so a bad clause is a usage error with no network call behind it.
      const extra = assertDigestClause(opts.jql);
      const client = await jiraClient(ctx);
      const me = (await client.myself()).name;
      const queries = digestJql(me, since, deps.now(), extra === undefined ? {} : { extra });
      const [mine, mentions] = await Promise.all([
        client.search({
          jql: queries.mine,
          maxResults: limit,
          fields: FIELDS,
          expand: ['changelog'],
        }),
        client.search({ jql: queries.mentions, maxResults: limit, fields: FIELDS }),
      ]);
      // The same busy issue often sits in both pages; page its comments once and share them.
      const byKey = new Map<string, JiraIssue>();
      for (const issue of [...mine.issues, ...mentions.issues]) {
        if (!byKey.has(issue.key)) byKey.set(issue.key, issue);
      }
      await completeComments(client, [...byKey.values()], since.instant);
      for (const issue of [...mine.issues, ...mentions.issues]) {
        const completed = byKey.get(issue.key);
        if (completed && completed !== issue) issue.fields.comment = completed.fields.comment;
      }
      const d = buildDigest({
        me,
        since,
        aliases: aliasesOf(ctx),
        mine,
        mentions,
        ...(extra === undefined ? {} : { jql: extra }),
      });
      if (d.truncated.mine)
        ctx.logger.warn(
          `showing ${mine.issues.length} of ${mine.total} of your issues; raise --limit or narrow --jql`
        );
      if (d.truncated.mentions)
        ctx.logger.warn(
          `showing ${mentions.issues.length} of ${mentions.total} issues that mention you; raise --limit or narrow --jql`
        );
      return { markdown: renderDigest(d), data: d, axi: { data: digestAxi(d) } };
    },
  });
}
