/**
 * Read-only production smoke. Local only, never in CI.
 *
 *   npm run build && npm run smoke:readonly -- [--jql "<JQL>"] [--limit N] [--report <file>]
 *   npm run build && npm run smoke:readonly -- --space DEV [--limit N] [--report <file>]
 *   npm run build && npm run smoke:readonly -- --cql 'type = page and lastmodified > now("-30d")'
 *
 * Environment: the same `~/.lassi.json` / `LASSI_*` configuration the CLI uses, plus optional
 * LASSI_SMOKE_JQL, LASSI_SMOKE_CQL, LASSI_SMOKE_SPACE and LASSI_SMOKE_LIMIT. Jira: fetches issues and their
 * comments, converts every wiki-markup body to markdown in memory, and reports conversion failures
 * and the constructs that fell into raw ```jira fences. Confluence (when --space or --cql is given):
 * the same for page storage bodies, plus the macro histogram and editor conventions.
 * Nothing is written except the report (stdout, or --report <file>).
 */
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { createLogger, loadConfig, nodeFs, resolveToken, type Logger } from '@wonna/lassi-core';
import {
  createConfluenceClient,
  fenceReason as pageFenceReason,
  observePage,
  storageToMarkdown,
  summarize,
  type ConfluenceClient,
  type PageObservation,
} from '@wonna/lassi-confluence';
import { createJiraClient, wikiToMarkdown, type JiraClient } from '@wonna/lassi-jira';

interface IssueStats {
  bodies: number;
  fencedBodies: number;
  fences: number;
  reasons: Map<string, number>;
}

interface Stats {
  bodies: number;
  converted: number;
  failed: Array<{ where: string; error: string }>;
  fenced: number;
  fenceReasons: Map<string, number>;
  fencedSamples: Array<{ where: string; head: string }>;
  /** Bodies with at least one fence, over the whole run (the samples above are capped). */
  fencedBodies: Set<string>;
  /** One automated issue with hundreds of comments can dominate the histogram; this shows it. */
  perIssue: Map<string, IssueStats>;
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function topReason(reasons: Map<string, number>): string {
  const sorted = [...reasons.entries()].sort((a, b) => b[1] - a[1]);
  return sorted[0] ? `${sorted[0][0]} (${sorted[0][1]})` : '';
}

const { values } = parseArgs({
  options: {
    jql: { type: 'string' },
    cql: { type: 'string' },
    space: { type: 'string' },
    limit: { type: 'string' },
    report: { type: 'string' },
  },
});

const jql = values.jql ?? process.env['LASSI_SMOKE_JQL'] ?? 'updated >= -30d ORDER BY updated DESC';
const limit = Number(values.limit ?? process.env['LASSI_SMOKE_LIMIT'] ?? 20);
const smokeSpace = values.space ?? process.env['LASSI_SMOKE_SPACE'];
const cql =
  values.cql ??
  process.env['LASSI_SMOKE_CQL'] ??
  (smokeSpace === undefined
    ? undefined
    : `space = "${smokeSpace}" and type = page order by lastmodified desc`);
// Pages run only when asked for; issues run unless only pages were asked for.
const wantConfluence = cql !== undefined;
const wantJira =
  values.jql !== undefined || process.env['LASSI_SMOKE_JQL'] !== undefined || !wantConfluence;

/** Classifies a raw ```jira fence by its first recognisable construct, for the macro histogram. */
function fenceReason(value: string): string {
  const head = value.trimStart();
  const macro = /^\{([a-zA-Z][\w-]*)/.exec(head);
  if (macro) return `{${(macro[1] as string).toLowerCase()}}`;
  if (head.startsWith('||') || head.startsWith('|')) return 'table-shape';
  if (/\{color[:}]/.test(value)) return '{color} inline';
  if (/\{[a-zA-Z][\w-]*(?::[^}]*)?\}/.test(value)) return 'inline macro';
  if (/(^|\s)\+[^\s+][^+]*\+/.test(value)) return '+inserted+';
  if (/\^[^\s^]+\^/.test(value)) return '^superscript^';
  if (/~[^\s~]+~/.test(value)) return '~subscript~';
  if (/\?\?[^?]+\?\?/.test(value)) return '??citation??';
  if (/!\S+\|[^!]*!/.test(value)) return 'image parameters';
  if (/\[[^\]]*\|[^\]]*\|[^\]]*\]/.test(value)) return 'link with tooltip';
  return 'other';
}

function inspect(issueKey: string, where: string, wiki: string, stats: Stats): void {
  let issue = stats.perIssue.get(issueKey);
  if (!issue) {
    issue = { bodies: 0, fencedBodies: 0, fences: 0, reasons: new Map() };
    stats.perIssue.set(issueKey, issue);
  }
  stats.bodies += 1;
  issue.bodies += 1;
  let md: string;
  try {
    md = wikiToMarkdown(wiki);
  } catch (err) {
    stats.failed.push({ where, error: (err as Error).stack ?? String(err) });
    return;
  }
  stats.converted += 1;
  const fences = md.matchAll(/^`{3,}jira\n([\s\S]*?)\n`{3,}$/gm);
  let bodyFences = 0;
  for (const m of fences) {
    bodyFences += 1;
    const reason = fenceReason(m[1] as string);
    bump(stats.fenceReasons, reason);
    bump(issue.reasons, reason);
    if (stats.fencedSamples.length < 15) {
      stats.fencedSamples.push({
        where,
        head: (m[1] as string).split('\n')[0]?.slice(0, 80) ?? '',
      });
    }
  }
  if (bodyFences > 0) {
    stats.fenced += bodyFences;
    issue.fences += bodyFences;
    issue.fencedBodies += 1;
    stats.fencedBodies.add(where);
  }
}

async function smokeJira(client: JiraClient, log: Logger): Promise<Stats> {
  const stats: Stats = {
    bodies: 0,
    converted: 0,
    failed: [],
    fenced: 0,
    fenceReasons: new Map(),
    fencedSamples: [],
    fencedBodies: new Set(),
    perIssue: new Map(),
  };
  const me = await client.myself();
  log.info(`jira: authenticated as ${me.name}`);
  const info = await client.serverInfo();
  log.info(`jira: version ${info.version} (${info.deploymentType ?? 'unknown deployment'})`);
  log.info(
    `jira: createmeta mode is only probed when jira.defaultProject is set (see lassi doctor)`
  );
  const page = await client.search({
    jql,
    maxResults: limit,
    fields: ['summary', 'description', 'comment'],
  });
  log.info(`jira: ${page.issues.length} of ${page.total} issues for "${jql}"`);
  for (const issue of page.issues) {
    if (issue.fields.description)
      inspect(issue.key, `${issue.key} description`, issue.fields.description, stats);
    for (const comment of issue.fields.comment?.comments ?? []) {
      inspect(issue.key, `${issue.key} comment ${comment.id}`, comment.body, stats);
    }
  }
  return stats;
}

function renderReport(stats: Stats, meta: { jql: string; limit: number; when: string }): string {
  const lines: string[] = [];
  lines.push('# lassi read-only smoke report (Jira)', '');
  lines.push(`- when: ${meta.when}`, `- jql: \`${meta.jql}\``, `- limit: ${meta.limit}`, '');
  lines.push('## Conversion', '');
  lines.push(
    `| Bodies | Converted | Failed | Raw fences |`,
    `| - | - | - | - |`,
    `| ${stats.bodies} | ${stats.converted} | ${stats.failed.length} | ${stats.fenced} |`,
    ''
  );
  const fidelity =
    stats.bodies === 0
      ? 0
      : Math.round((100 * (stats.converted - stats.fencedBodies.size)) / stats.bodies);
  lines.push(
    `Bodies converted without any raw fence: ${fidelity}% (${stats.fencedBodies.size} of ${stats.bodies} bodies contain at least one fence).`,
    ''
  );
  lines.push('## Raw-fence reasons (what the dialect could gain next)', '');
  lines.push('| Construct | Count |', '| - | - |');
  for (const [reason, count] of [...stats.fenceReasons.entries()].sort((a, b) => b[1] - a[1]))
    lines.push(`| ${reason} | ${count} |`);
  lines.push('');
  lines.push('## Per-issue breakdown (counts only; issue keys stay on this machine)', '');
  lines.push(
    '| Issue | Bodies | Fenced bodies | Fences | Top construct |',
    '| - | - | - | - | - |'
  );
  const issues = [...stats.perIssue.entries()].sort((a, b) => b[1].fences - a[1].fences);
  for (const [key, i] of issues.slice(0, 25))
    lines.push(
      `| ${key} | ${i.bodies} | ${i.fencedBodies} | ${i.fences} | ${topReason(i.reasons)} |`
    );
  if (issues.length > 25) lines.push(`| … ${issues.length - 25} more issues | | | | |`);
  lines.push('');
  if (stats.fencedSamples.length > 0) {
    lines.push('## Fence samples (first line only, no content beyond that)', '');
    for (const s of stats.fencedSamples)
      lines.push(`- ${s.where}: \`${s.head.replace(/`/g, "'")}\``);
    lines.push('');
  }
  if (stats.failed.length > 0) {
    lines.push('## Converter exceptions', '');
    for (const f of stats.failed) lines.push(`### ${f.where}`, '', '```', f.error, '```', '');
  }
  return `${lines.join('\n')}\n`;
}

interface PageStats {
  pages: number;
  converted: number;
  failed: Array<{ where: string; error: string }>;
  fences: number;
  fencedSamples: Array<{ where: string; head: string }>;
  observations: PageObservation[];
  truncated: boolean;
  total: number | undefined;
}

async function smokeConfluence(client: ConfluenceClient, log: Logger): Promise<PageStats> {
  const stats: PageStats = {
    pages: 0,
    converted: 0,
    failed: [],
    fences: 0,
    fencedSamples: [],
    observations: [],
    truncated: false,
    total: undefined,
  };
  const me = await client.currentUser();
  log.info(`confluence: authenticated as ${me.username ?? me.userKey ?? 'unknown'}`);
  const info = await client.systemInfo();
  log.info(`confluence: version ${info.version ?? 'unknown'} (${info.source})`);
  const iterator = client.searchIter(cql as string, { max: limit, expand: ['body.storage'] });
  for (;;) {
    const step = await iterator.next();
    if (step.done) {
      stats.truncated = step.value.truncated;
      stats.total = step.value.total;
      break;
    }
    const page = step.value;
    const storage = page.body?.storage?.value ?? '';
    stats.pages += 1;
    try {
      stats.observations.push(observePage(page.id, storage));
      const md = storageToMarkdown(storage);
      stats.converted += 1;
      for (const m of md.matchAll(/^`{3,}confluence\n([\s\S]*?)\n`{3,}$/gm)) {
        stats.fences += 1;
        if (stats.fencedSamples.length < 15) {
          stats.fencedSamples.push({
            where: `page ${page.id}`,
            head: (m[1] as string).split('\n')[0]?.slice(0, 80) ?? '',
          });
        }
      }
    } catch (err) {
      stats.failed.push({ where: `page ${page.id}`, error: (err as Error).stack ?? String(err) });
    }
  }
  log.info(
    `confluence: ${stats.pages}${stats.total === undefined ? '' : ` of ${stats.total}`} pages for "${cql}"${stats.truncated ? ' (truncated by --limit)' : ''}`
  );
  return stats;
}

function renderPageReport(stats: PageStats, meta: { when: string }): string {
  const summary = summarize(stats.observations);
  const lines: string[] = [];
  lines.push('# lassi read-only smoke report (Confluence)', '');
  lines.push(`- when: ${meta.when}`, `- cql: \`${cql}\``, `- limit: ${limit}`, '');
  lines.push('## Conversion', '');
  lines.push(
    '| Pages | Converted | Failed | Raw fences |',
    '| - | - | - | - |',
    `| ${stats.pages} | ${stats.converted} | ${stats.failed.length} | ${stats.fences} |`,
    ''
  );
  const clean =
    stats.pages === 0 ? 0 : Math.round((100 * (stats.pages - summary.fencedPages)) / stats.pages);
  lines.push(
    `Pages converted without any raw fence: ${clean}% (${summary.fencedPages} of ${stats.pages} pages contain at least one fence).`,
    ''
  );
  lines.push('## Macro histogram', '', '| Macro | Pages | Occurrences |', '| - | - | - |');
  for (const row of summary.macros)
    lines.push(`| ${row.name} | ${row.pages} | ${row.occurrences} |`);
  lines.push('');
  lines.push(
    '## Conventions (what the writer must match)',
    '',
    '| Aspect | Value | Pages |',
    '| - | - | - |'
  );
  for (const c of summary.conventions) lines.push(`| ${c.aspect} | ${c.value} | ${c.pages} |`);
  lines.push('');
  lines.push(
    '## Raw-fence reasons (what the dialect could gain next)',
    '',
    '| Reason | Pages | Occurrences |',
    '| - | - | - |'
  );
  for (const row of summary.fences)
    lines.push(`| ${row.name} | ${row.pages} | ${row.occurrences} |`);
  lines.push('');
  lines.push('## Per-page breakdown (ids only; titles and content stay on this machine)', '');
  lines.push('| Page | Macros | Fences | Top reason |', '| - | - | - | - |');
  const perPage = stats.observations
    .map((o) => {
      const reasons = new Map<string, number>();
      for (const w of o.warnings) {
        const reason = pageFenceReason(w);
        if (reason !== undefined) bump(reasons, reason);
      }
      const fences = [...reasons.values()].reduce((a, b) => a + b, 0);
      const macros = [...o.macros.values()].reduce((a, b) => a + b, 0);
      return { id: o.id, macros, fences, top: topReason(reasons) };
    })
    .sort((a, b) => b.fences - a.fences);
  for (const p of perPage.slice(0, 25))
    lines.push(`| ${p.id} | ${p.macros} | ${p.fences} | ${p.top} |`);
  if (perPage.length > 25) lines.push(`| … ${perPage.length - 25} more pages | | | |`);
  lines.push('');
  if (stats.fencedSamples.length > 0) {
    lines.push('## Fence samples (first line only, no content beyond that)', '');
    for (const s of stats.fencedSamples)
      lines.push(`- ${s.where}: \`${s.head.replace(/`/g, "'")}\``);
    lines.push('');
  }
  if (stats.failed.length > 0) {
    lines.push('## Converter exceptions', '');
    for (const f of stats.failed) lines.push(`### ${f.where}`, '', '```', f.error, '```', '');
  }
  return `${lines.join('\n')}\n`;
}

async function main(): Promise<number> {
  const log = createLogger({ level: 'info', write: (l) => process.stderr.write(l) });
  const fs = nodeFs();
  const loaded = await loadConfig({ env: process.env, cwd: process.cwd(), homedir: homedir(), fs });
  const when = new Date().toISOString();
  const reports: string[] = [];
  let failures = 0;
  if (wantJira) {
    const jira = loaded.config.jira;
    if (!jira.url) {
      log.error('jira.url is not configured; pass --space/--cql to smoke Confluence only');
      return 2;
    }
    const token = await resolveToken({
      product: 'jira',
      ...(jira.token === undefined ? {} : { envToken: jira.token }),
      ...(jira.tokenFile === undefined ? {} : { tokenFile: jira.tokenFile }),
      readFile: (p) => fs.readFile(p),
    });
    const client = createJiraClient({
      baseUrl: jira.url,
      token: token.token,
      timeoutMs: loaded.config.http.timeoutMs,
    });
    const stats = await smokeJira(client, log);
    reports.push(renderReport(stats, { jql, limit, when }));
    failures += stats.failed.length;
  }
  if (wantConfluence) {
    const confluence = loaded.config.confluence;
    if (!confluence.url) {
      log.error('confluence.url is not configured; nothing to smoke for --space/--cql');
      return 2;
    }
    const token = await resolveToken({
      product: 'confluence',
      ...(confluence.token === undefined ? {} : { envToken: confluence.token }),
      ...(confluence.tokenFile === undefined ? {} : { tokenFile: confluence.tokenFile }),
      readFile: (p) => fs.readFile(p),
    });
    const client = createConfluenceClient({
      baseUrl: confluence.url,
      token: token.token,
      timeoutMs: loaded.config.http.timeoutMs,
    });
    const stats = await smokeConfluence(client, log);
    reports.push(renderPageReport(stats, { when }));
    failures += stats.failed.length;
  }
  const report = reports.join('\n');
  if (values.report) {
    writeFileSync(values.report, report);
    log.info(`report written to ${values.report}`);
  } else {
    process.stdout.write(report);
  }
  return failures > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(
      `error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`
    );
    process.exitCode = 1;
  }
);
