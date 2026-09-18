import type { Command } from 'commander';
import {
  LassiError,
  displayPath,
  isLassiError,
  resolvePath,
  type HintContext,
} from '@wonna/lassi-core';
import {
  aliasFor,
  buildCreateIssueFields,
  checkRequiredFields,
  coerceFieldValue,
  expansionFromSections,
  fieldIdFor,
  frontmatterDiff,
  parseFieldArg,
  stripGeneratedSections,
  type IssueCache,
  type JiraFieldMetaMap,
} from '@wonna/lassi-jira';
import type { CliDeps } from '../../deps.js';
import { guardWrite } from '../../guard-write.js';
import { readBodyInput } from '../../input/body.js';
import { dryRunData } from '../../output/dry-run.js';
import { attach, type Session } from '../../run-command.js';
import {
  lassiDirs,
  jiraCachePath,
  readJsonCache,
  readWorkingFile,
  splitEditable,
} from '../../workfile/index.js';
import { markdownBodyToWiki } from './body.js';
import { resolveIssueKey } from './issue-key.js';
import { aliasesOf, jiraClient } from './shared.js';
import { templateDescription, templateNamed } from './templates.js';
import { buildIssueDocument, loadIssueComments, saveIssueWorkingFile } from './workfile.js';

interface CreateOptions {
  template?: string;
  project?: string;
  type?: string;
  summary?: string;
  field: string[];
  body?: string;
  file?: string;
}

interface UpdateOptions {
  field: string[];
  file?: string;
  body?: string;
  ifUnchanged?: boolean;
  keep?: boolean;
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

/** Facts the thrower could not know (project, key, operation) so the hint catalogue can pick a row. */
function withContext<T>(context: HintContext, run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (isLassiError(err)) err.context = { ...context, ...err.context };
    throw err;
  }
}

function fieldId(
  aliases: Record<string, string>,
  key: string,
  context: HintContext,
  lookup: string
): string {
  const id = fieldIdFor(aliases, key);
  if (id === undefined) {
    throw new LassiError('usage', `unknown field "${key}"; run \`${lookup}\` for the field list`, {
      context,
    });
  }
  return id;
}

export function registerIssueWrites(issue: Command, deps: CliDeps, session: Session): void {
  const create = issue
    .command('create')
    .description(
      'create an issue from fields and a markdown description; createmeta runs first and missing required fields fail fast'
    )
    .option('--template <name>', 'defaults from jira.templates.<name>; flags win')
    .option('--project <P>', 'project key (default: jira.defaultProject)')
    .option('--type <T>', 'issue type name')
    .option('--summary <S>', 'summary (or --field summary=…)')
    .option('--field <alias=value>', 'field by alias or raw id (repeatable)', collect, [])
    .option('--body <md>', 'description as markdown')
    .option('--file <path>', 'markdown file with the description ("-" reads stdin)');
  attach<[], CreateOptions>(create, deps, session, {
    kind: 'write',
    async run(ctx, _args, opts) {
      // Template values are merged as if typed first, so flags override them and every value
      // travels the same alias, coercion and createmeta path as --field.
      const template =
        opts.template === undefined
          ? undefined
          : { name: opts.template, ...templateNamed(ctx, opts.template) };
      const project = opts.project ?? template?.project ?? ctx.config.jira.defaultProject;
      if (!project) {
        throw new LassiError('usage', '--project is required (or set jira.defaultProject)');
      }
      const type = opts.type ?? template?.type;
      if (!type) {
        throw new LassiError('usage', '--type is required', {
          hint: `run \`lassi jira issue createmeta ${project}\` for the issue types`,
        });
      }
      const context: HintContext = {
        product: 'jira',
        project,
        issueType: type,
        operation: 'create',
      };
      // Body first: an unreadable template file or a bad --file must fail before any request.
      const markdown =
        (await readBodyInput(deps, opts, { required: false })) ??
        (template === undefined
          ? undefined
          : await templateDescription(deps, template.name, template));
      const client = await jiraClient(ctx);
      const aliases = aliasesOf(ctx);
      const fieldArgs = [
        ...Object.entries(template?.fields ?? {}).map(([k, v]) => ({
          arg: `${k}=${String(v)}`,
          fromTemplate: true,
        })),
        ...opts.field.map((arg) => ({ arg, fromTemplate: false })),
      ];
      // Last one wins per resolved id before anything is coerced, so an explicit --field replaces
      // a stale template value instead of tripping over it.
      const byId = new Map<
        string,
        { key: string; raw: string; fromTemplate: boolean; id: string }
      >();
      for (const { arg, fromTemplate } of fieldArgs) {
        const { key, raw } = parseFieldArg(arg);
        const id = fieldId(aliases, key, context, 'lassi jira fields');
        byId.set(id, { key, raw, fromTemplate, id });
      }
      const given = [...byId.values()];
      const meta = await client.createmeta(project, type);
      const typeMeta = meta.issueTypes[0];
      if (!typeMeta) {
        throw new LassiError('validation', `issue type "${type}" is not available in ${project}`, {
          context,
        });
      }
      let summary = opts.summary ?? template?.summary;
      const custom: Record<string, unknown> = {};
      for (const field of given) {
        if (field.id === 'summary') {
          // A template's fields.summary is a default like template.summary: --summary wins.
          if (!field.fromTemplate || opts.summary === undefined) summary = field.raw;
          continue;
        }
        if (field.id === 'description' || field.id === 'project' || field.id === 'issuetype') {
          throw new LassiError(
            'usage',
            `use --body/--file, --project and --type instead of --field ${field.key}`
          );
        }
        custom[field.id] = withContext(context, () =>
          coerceFieldValue(field.raw, typeMeta.fields[field.id], field.id)
        );
      }
      if (summary === undefined || summary.trim() === '') {
        throw new LassiError('usage', '--summary is required');
      }
      const description =
        markdown === undefined ? undefined : await markdownBodyToWiki(ctx, client, markdown);
      const fields = buildCreateIssueFields({
        project,
        issueType: typeMeta.name,
        summary,
        ...(description === undefined ? {} : { description }),
        custom,
      });
      const missing = checkRequiredFields(typeMeta, fields);
      if (missing.length > 0) {
        const names = missing.map((id) => aliasFor(aliases, id) ?? id);
        throw new LassiError(
          'validation',
          `missing required field${missing.length === 1 ? '' : 's'}: ${names.join(', ')}`,
          {
            errors: Object.fromEntries(
              missing.map((id) => [id, `${typeMeta.fields[id]?.name ?? id} is required.`])
            ),
            context: { ...context, issueType: typeMeta.name },
          }
        );
      }
      const preview = {
        method: 'POST' as const,
        path: '/rest/api/2/issue',
        payloadLabel: 'fields (json)',
        payload: JSON.stringify({ fields }, null, 2),
      };
      if (guardWrite(ctx, preview) === 'dry-run') return { data: dryRunData(preview) };
      const created = await client.createIssue(fields, { project, issueType: typeMeta.name });
      const url = client.browseUrl(created.key);
      return {
        markdown: `created ${created.key} ${url}\n`,
        data: { key: created.key, id: created.id, url },
      };
    },
  });

  const update = issue
    .command('update <KEY>')
    .description(
      'update fields from --field values and/or a working file; only what changed is sent'
    )
    .option('--field <alias=value>', 'field by alias or raw id (repeatable)', collect, [])
    .option('--file <md>', 'working file from `issue get --out`, diffed against its cache')
    .option('--body <md>', 'replace the description with this markdown')
    .option(
      '--if-unchanged',
      'exit 6 if the issue changed on the server since the file was fetched'
    )
    .option('--keep', 'do not re-fetch and rewrite the working file afterwards');
  attach<[string], UpdateOptions>(update, deps, session, {
    kind: 'write',
    async run(ctx, [keyArg], opts) {
      const key = await resolveIssueKey(ctx, keyArg);
      if (!opts.file && opts.field.length === 0 && opts.body === undefined) {
        throw new LassiError('usage', 'nothing to update: pass --field, --body or --file');
      }
      if (opts.ifUnchanged && !opts.file) {
        // There is no baseline without a working file, and silently doing nothing would leave the
        // agent believing it had a lost-update guard.
        throw new LassiError(
          'usage',
          '--if-unchanged compares the working file against the server, so it needs --file <md>',
          {
            hint: `run \`lassi jira issue get ${key} --out <file>\`, edit it, then update with --file`,
          }
        );
      }
      const context: HintContext = { product: 'jira', issueKey: key, operation: 'update' };
      const client = await jiraClient(ctx);
      const aliases = aliasesOf(ctx);
      const editmeta: JiraFieldMetaMap = await client.editmeta(key);
      let fields: Record<string, unknown> = {};
      const changed: string[] = [];
      let descriptionMarkdown: string | undefined;
      let cache: IssueCache | undefined;

      if (opts.file) {
        const workingFile = opts.file;
        const fileContext = { ...context, workingFile };
        const file = await readWorkingFile(resolvePath(deps.cwd, workingFile), deps.fs);
        const split = splitEditable(file.frontmatter);
        const fileKey = split.editable['key'];
        if (fileKey !== undefined && fileKey !== key) {
          throw new LassiError(
            'usage',
            `${workingFile} is the working file of ${String(fileKey)}, not ${key}`
          );
        }
        const cachePath = jiraCachePath(
          lassiDirs(deps.cwd, ctx.config, ctx.loaded.workspaceStateDir),
          key
        );
        // Recorded, not logged: an error is one human line plus one JSON line on stderr,
        // and a warning ahead of it would make three. A damaged cache always ends in the error
        // below, so the detail belongs in its hint.
        let damaged: string | undefined;
        const stored = await readJsonCache<IssueCache>(cachePath, deps.fs, (p) => {
          damaged = displayPath(deps.cwd, p);
        });
        // The fetch that wrote *this* file is the baseline: a later fetch of the same issue (an
        // export, a run with different --comments) must not decide which trailing sections this
        // file is assumed to carry, or they would be sent as part of the description.
        const state = stored?.files?.[displayPath(deps.cwd, resolvePath(deps.cwd, workingFile))];
        if (!stored || !state) {
          throw new LassiError(
            'usage',
            `no record of ${workingFile} for ${key}; update diffs the file against the fetch that wrote it`,
            {
              hint:
                damaged === undefined
                  ? `run \`lassi jira issue get ${key} --out ${workingFile}\` first`
                  : `${damaged} is not valid JSON, so the record was ignored; run \`lassi jira issue get ${key} --out ${workingFile}\` again`,
              context: fileContext,
            }
          );
        }
        cache = { ...stored, ...state };
        if (opts.ifUnchanged) {
          const live = await client.getIssue(key, { fields: ['updated'] });
          if ((live.fields.updated ?? '') !== cache.updated) {
            throw new LassiError(
              'conflict',
              `${key} changed on the server since ${cache.fetchedAt} (updated ${cache.updated} → ${live.fields.updated ?? 'unknown'})`,
              { context: fileContext }
            );
          }
        }
        const description = stripGeneratedSections(file.body, cache.sections ?? '');
        if (description === undefined) {
          throw new LassiError(
            'usage',
            `the generated sections (## Comments / ## Attachments / ## Links) in ${workingFile} were edited`,
            {
              hint: `they are never sent, so they must stay exactly as fetched; edit the description above them, or run \`lassi jira issue get ${key} --out ${workingFile}\` without --comments/--attachments/--links for a file that has none`,
              context: fileContext,
            }
          );
        }
        const cached = cache;
        const diff = withContext(fileContext, () =>
          frontmatterDiff(
            cached,
            {
              editable: split.editable,
              ...(split.readonly ? { readonly: split.readonly } : {}),
              body: description,
            },
            aliases,
            editmeta
          )
        );
        for (const warning of diff.warnings) ctx.logger.warn(warning);
        fields = { ...diff.fields };
        changed.push(...diff.changedKeys);
        if (diff.descriptionChanged) descriptionMarkdown = description;
      }

      if (opts.body !== undefined) descriptionMarkdown = opts.body;
      for (const arg of opts.field) {
        const { key: name, raw } = parseFieldArg(arg);
        const id = fieldId(aliases, name, context, `lassi jira issue editmeta ${key}`);
        if (id === 'description') {
          throw new LassiError('usage', 'use --body (markdown) to change the description');
        }
        fields[id] = withContext(context, () => coerceFieldValue(raw, editmeta[id], id));
        changed.push(name);
      }
      if (descriptionMarkdown !== undefined) {
        fields['description'] = await markdownBodyToWiki(ctx, client, descriptionMarkdown);
        changed.push('description');
      }
      if (Object.keys(fields).length === 0) {
        return { markdown: `no changes for ${key}\n`, data: { key, changed: [] } };
      }
      const preview = {
        method: 'PUT' as const,
        path: `/rest/api/2/issue/${key}`,
        payloadLabel: 'fields (json)',
        payload: JSON.stringify({ fields }, null, 2),
      };
      if (guardWrite(ctx, preview) === 'dry-run') return { data: dryRunData(preview) };
      await client.updateIssue(key, { fields });

      let rewritten: string | undefined;
      if (opts.file && !opts.keep) {
        // the file is re-fetched and rewritten, keeping the sections it carried.
        const expansion = expansionFromSections(cache?.sections ?? '');
        const fresh = await loadIssueComments(
          client,
          await client.getIssue(key),
          expansion.comments ? 'all' : undefined
        );
        const doc = buildIssueDocument(ctx, client, fresh, {
          comments: expansion.comments ? 'all' : undefined,
          attachments: expansion.attachments,
          links: expansion.links,
        });
        await saveIssueWorkingFile(ctx, fresh, doc, opts.file);
        rewritten = opts.file;
      }
      return {
        markdown: `updated ${key} (${changed.join(', ')})${rewritten ? `; rewrote ${rewritten}` : ''}\n`,
        data: { key, changed, fields, ...(rewritten ? { file: rewritten } : {}) },
      };
    },
  });
}
