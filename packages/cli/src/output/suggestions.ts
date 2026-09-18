export interface SuggestionInput {
  args: unknown[];
  opts: Record<string, unknown>;
  data: unknown;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * At most three imperative lines naming runnable `lassi` commands: what an agent would most likely
 * do next after this result. Never instance URLs, never tokens. Commands can pass
 * their own `help` instead; this is the fallback keyed by command path.
 */
export function suggestionsFor(path: string, input: SuggestionInput): string[] {
  const data = record(input.data);
  const arg = (i: number, fallback: string): string => str(input.args[i], fallback);
  if (data['dryRun'] === true) return ['Re-run without --dry-run to send.'];
  switch (path) {
    case 'jira issue search': {
      const total = num(data['total']) ?? 0;
      const shown = num(data['shown']) ?? 0;
      if (total === 0) return ['No issues match; broaden the JQL or check the project key.'];
      const out = ['Run `lassi jira issue get <KEY>` for the description and counts.'];
      if (total > shown)
        out.push(
          `Add --limit N or --all to see the remaining ${total - shown} issue${total - shown === 1 ? '' : 's'}.`
        );
      return out;
    }
    case 'jira issue get': {
      // The payload's key is the resolved one; the argument may be the `.` branch shorthand.
      const key = str(data['key'], arg(0, '<KEY>'));
      if (typeof data['path'] === 'string')
        return [
          `Edit the file, then run \`lassi jira issue update ${key} --file ${input.opts['out'] as string} --if-unchanged\`.`,
        ];
      const out = [`Run \`lassi jira comment add ${key} --body "..."\` to comment.`];
      const hidden = num(data['hidden']);
      if (hidden !== undefined && hidden > 0)
        out.push(
          `Add --comments, --attachments or --links (or --all) to see the ${hidden} hidden item${hidden === 1 ? '' : 's'}.`
        );
      out.push(`Run \`lassi jira transition list ${key}\` before changing the status.`);
      return out;
    }
    case 'jira issue create':
      return [`Run \`lassi jira issue get ${str(data['key'], '<KEY>')}\` to verify the new issue.`];
    case 'jira issue update':
    case 'jira transition do':
      return [`Run \`lassi jira issue get ${str(data['key'], arg(0, '<KEY>'))}\` to verify.`];
    case 'jira issue createmeta':
      return [
        `Run \`lassi jira issue create --project ${arg(0, '<P>')} --type <T> --summary "..." --field alias=value --dry-run\`.`,
      ];
    case 'jira issue editmeta':
      return [
        `Run \`lassi jira issue update ${str(data['key'], arg(0, '<KEY>'))} --field alias=value --dry-run\`.`,
      ];
    case 'jira issue changelog': {
      const key = str(data['key'], arg(0, '<KEY>'));
      if ((num(data['shown']) ?? 0) === 0)
        return [
          `No changes in that window; widen --since or drop --fields, or run \`lassi jira issue get ${key}\`.`,
        ];
      const out = [
        `Run \`lassi jira issue get ${key} --comments 5\` for the discussion behind these changes.`,
      ];
      if (data['truncated'] === true)
        out.push('Jira returned a partial changelog; the oldest entries are missing.');
      return out;
    }
    case 'jira comment list': {
      const key = str(data['key'], arg(0, '<KEY>'));
      if ((num(data['total']) ?? 0) === 0)
        return [`No comments yet; run \`lassi jira comment add ${key} --body "..."\` to add one.`];
      return ['Bodies are cut at 200 characters; use --json for the full text.'];
    }
    case 'jira digest': {
      const counts = record(data['counts']);
      const total =
        (num(counts['mentions']) ?? 0) +
        (num(counts['changed']) ?? 0) +
        (num(counts['actions']) ?? 0);
      const truncated = record(data['truncated']);
      if (total === 0)
        return [
          truncated['mine'] === true || truncated['mentions'] === true
            ? 'Nothing found among the fetched issues; raise --limit or narrow --jql.'
            : 'Nothing happened in that window; widen --since (e.g. --since 1w).',
        ];
      return [
        'Run `lassi jira issue get <KEY> --comments 5` on an issue above.',
        `Run \`lassi jira issue changelog <KEY> --since ${str(input.opts['since'], '1d')}\` for one issue's full history.`,
      ];
    }
    case 'jira templates': {
      if (typeof data['name'] === 'string')
        return [
          `Copy the skeleton to a file, fill it in, then run \`lassi jira issue create --template ${data['name']} --summary "..." --file <md> --dry-run\`.`,
        ];
      const templates = data['templates'];
      if (!Array.isArray(templates) || templates.length === 0)
        return ['Add jira.templates to the workspace .lassi.json (see the README, "Templates").'];
      return [
        'Run `lassi jira templates <NAME>` for the description skeleton, then `lassi jira issue create --template <NAME> --summary "..." --file <md> --dry-run`.',
      ];
    }
    case 'jira comment add':
    case 'jira comment edit':
      return [`Run \`lassi jira comment list ${str(data['key'], arg(0, '<KEY>'))}\` to verify.`];
    case 'jira transition list': {
      const key = str(data['key'], arg(0, '<KEY>'));
      if ((num(data['count']) ?? 0) === 0)
        return ['No transitions are available from the current status.'];
      return [
        `Run \`lassi jira transition do ${key} <name>\` (add --field for required screen fields).`,
      ];
    }
    case 'jira attach get':
    case 'confluence attach get':
      return ['Read the saved files with your own tools; nothing binary is printed.'];
    case 'jira link types':
      return ['Run `lassi jira link create <KEY1> <KEY2> --type "<name or phrase>" --dry-run`.'];
    case 'doctor': {
      const summary = record(data['summary']);
      const failing = (data['checks'] as Array<Record<string, unknown>> | undefined)
        ?.filter((c) => c['status'] === 'FAIL')
        .map((c) => String(c['name']));
      if (failing && failing.length > 0) return [`Fix the FAIL rows first: ${failing.join(', ')}.`];
      if ((num(summary['warn']) ?? 0) > 0)
        return ['Only warnings; the CLI is usable as configured.'];
      return ['Everything passes; run the command you came for.'];
    }
    case 'config show':
      return [
        'Edit ~/.lassi.json or the workspace .lassi.json to change a setting; tokens never go in files.',
      ];
    case 'skills install':
      return ['Restart the agent so it discovers the installed skills.'];
    case 'confluence page get': {
      const id = str(data['id'], arg(0, '<ID>'));
      if (typeof data['path'] === 'string') {
        const file = input.opts['out'] as string;
        // Only a cached fetch produced a file that can be written back. The storage branch omits
        // `cache` and the view branch sets it to null, which JSON and TOON both render as a present
        // key, so this asks whether there is a cache rather than whether the key is there. Both
        // formats are rejected by `page validate` and `page update`.
        if (typeof data['cache'] !== 'string' || data['cache'] === '') {
          return [`${file} cannot be updated: it is read-only (no storage cache was written).`];
        }
        return [
          `Edit the file, run \`lassi confluence page validate --file ${file}\`, then \`lassi confluence page update --file ${file}\`.`,
        ];
      }
      const out = [`Run \`lassi confluence page get ${id} --out work/${id}.md\` to edit the page.`];
      const hidden = num(data['hidden']);
      if (hidden !== undefined && hidden > 0)
        out.push(
          `Add --comments or --attachments to see the ${hidden} hidden item${hidden === 1 ? '' : 's'}.`
        );
      return out;
    }
    case 'confluence search': {
      const total = num(data['total']) ?? num(data['shown']) ?? 0;
      if (total === 0) return ['No pages match; loosen the CQL or check the space key.'];
      return ['Run `lassi confluence page get <ID>` for a page as markdown.'];
    }
    case 'confluence page create':
      return [
        `Run \`lassi confluence page get ${str(data['id'], '<ID>')}\` to verify the new page.`,
      ];
    case 'confluence page update':
      return [`Run \`lassi confluence page get ${str(data['id'], arg(0, '<ID>'))}\` to verify.`];
    case 'confluence comment list': {
      const id = arg(0, '<ID>');
      if ((num(data['total']) ?? 0) === 0)
        return [
          `No comments yet; run \`lassi confluence comment add ${id} --body "..."\` to add one.`,
        ];
      return ['Bodies are cut at 200 characters; use --json for the full text.'];
    }
    case 'confluence comment add':
      return [`Run \`lassi confluence comment list ${arg(0, '<ID>')}\` to verify.`];
    case 'confluence stats macros':
      return ['Constructs in the raw-fence table are what the dialect cannot carry yet.'];
    case 'jira issue export':
    case 'confluence page export':
      return ['Run `lassi search index` to make the exported files searchable by meaning.'];
    case 'search index':
      return ['Run `lassi search query "<question>"` to search the index.'];
    case 'search show':
      return [
        'Run `lassi search query "<question>"`; re-run `lassi search index` after new exports.',
      ];
    default:
      return [];
  }
}
