import type { LassiError } from './lassi-error.js';

type Rule = (err: LassiError) => string | undefined;

function aliasNote(err: LassiError): string {
  const aliases = err.context.aliases;
  if (!aliases || !err.errors) return '';
  const byId = new Map<string, string>();
  for (const [alias, id] of Object.entries(aliases)) if (!byId.has(id)) byId.set(id, alias);
  const notes = Object.keys(err.errors)
    .map((id) => {
      const alias = byId.get(id);
      return alias ? `alias '${alias}' maps to ${id}` : undefined;
    })
    .filter((n): n is string => n !== undefined);
  return notes.length > 0 ? `; ${notes.join(', ')}` : '';
}

function aliasedFields(err: LassiError): string[] {
  const aliases = err.context.aliases;
  if (!aliases || !err.errors) return [];
  const byId = new Map<string, string>();
  for (const [alias, id] of Object.entries(aliases)) if (!byId.has(id)) byId.set(id, alias);
  return Object.keys(err.errors)
    .map((id) => byId.get(id))
    .filter((a): a is string => a !== undefined);
}

function allowedValuesNote(err: LassiError): string {
  const allowed = err.context.allowedValues;
  if (!allowed) return '';
  const parts = Object.entries(allowed).map(([field, values]) => `${field}: ${values.join(', ')}`);
  return parts.length > 0 ? ` Allowed values — ${parts.join('; ')}.` : '';
}

/** hint catalogue as an ordered rule list; the first match wins. */
const RULES: Rule[] = [
  (e) =>
    e.code === 'read_only'
      ? `${e.context.readOnlyVar ?? 'LASSI_READ_ONLY'} is set; unset it to allow writes (--dry-run is still allowed).`
      : undefined,
  (e) =>
    e.code === 'auth'
      ? `Check the token${e.context.tokenFile ? ` in ${e.context.tokenFile}` : ''} and run \`lassi doctor\`.`
      : undefined,
  (e) =>
    e.code === 'tls'
      ? 'The server certificate is not trusted by Node; set NODE_EXTRA_CA_CERTS=/path/to/custom-ca.pem (or NODE_USE_SYSTEM_CA=1) and run `lassi doctor`.'
      : undefined,
  (e) => {
    // Jira computing allowed values for a large edit screen, not the network.
    if (e.code !== 'timeout' || !/\/editmeta(\?|$)/.test(e.request?.url ?? '')) return undefined;
    return 'Jira did not finish computing the edit metadata in time; retry when it is less busy, or change only fields that need no allowed values (summary, labels, assignee, description).';
  },
  (e) => {
    if (e.code !== 'timeout' || !/\/createmeta(?:\/|\?|$)/.test(e.request?.url ?? ''))
      return undefined;
    return 'Jira did not finish computing the create metadata in time; run `lassi jira issue createmeta <PROJECT> --type <TYPE>` when it is less busy to warm the cache, or increase http.timeoutMs in your config.';
  },
  (e) =>
    e.code === 'timeout'
      ? 'The request timed out; check VPN and proxy settings (NODE_USE_ENV_PROXY=1 when a proxy is required) and run `lassi doctor`.'
      : undefined,
  (e) =>
    e.code === 'network'
      ? 'Could not reach the server; check the URL in `lassi config show`, VPN and proxy settings, then run `lassi doctor`.'
      : undefined,
  (e) => {
    if (e.code !== 'conflict') return undefined;
    const { versionFrom, versionTo, pageId, issueKey, workingFile } = e.context;
    const target = workingFile ?? '<same file>';
    if (pageId !== undefined) {
      const versions =
        versionFrom !== undefined && versionTo !== undefined
          ? ` (v${versionFrom} → v${versionTo})`
          : '';
      return `Page changed on server${versions}; run \`lassi confluence page get ${pageId} --out ${target}\` and re-apply your edit.`;
    }
    if (issueKey !== undefined) {
      return `Issue changed on server; run \`lassi jira issue get ${issueKey} --out ${target}\` and re-apply your edit.`;
    }
    return 'The item changed on the server; fetch it again and re-apply your edit.';
  },
  (e) => {
    if (e.code !== 'validation' || e.context.product !== 'jira') return undefined;
    const { project, issueType, issueKey, transition, operation } = e.context;
    if (transition && issueKey) {
      return `Run \`lassi jira issue transition list ${issueKey}\` to see the required screen fields.${allowedValuesNote(e)}`;
    }
    if ((operation === 'create' || issueKey === undefined) && project) {
      const type = issueType ? ` --type ${issueType}` : '';
      if (e.context.createmetaCachedAt !== undefined) {
        return `The create metadata was cached at ${e.context.createmetaCachedAt}; run \`lassi jira issue createmeta ${project}${type}\` to refresh required fields and allowed values.${allowedValuesNote(e)}`;
      }
      const fields = aliasedFields(e);
      if (fields.length > 0) {
        const flags = fields.map((f) => `--field ${f}=<value>`).join(' ');
        return `Add ${flags}; run \`lassi jira issue createmeta ${project}${type}\` for allowed values.${allowedValuesNote(e)}`;
      }
      return `Run \`lassi jira issue createmeta ${project}${type}\` to see required fields and allowed values.${allowedValuesNote(e)}`;
    }
    if (issueKey && e.context.editmetaCachedAt !== undefined) {
      return `The edit metadata was cached at ${e.context.editmetaCachedAt}, possibly from another issue of the same project and type; run \`lassi jira issue editmeta ${issueKey}\` to refresh it${aliasNote(e)}.`;
    }
    if (issueKey) {
      const cachedAt = e.context.allowedValuesCachedAt;
      if (cachedAt !== undefined) {
        return `The allowed values were cached at ${cachedAt}; run \`lassi jira issue editmeta ${issueKey}\` to refresh them${aliasNote(e)}.${allowedValuesNote(e)}`;
      }
      return `Run \`lassi jira issue editmeta ${issueKey}\` to see editable fields and allowed values${aliasNote(e)}.${allowedValuesNote(e)}`;
    }
    return undefined;
  },
  (e) =>
    e.code === 'validation' && e.context.product === 'confluence' && e.context.pageId
      ? `Run \`lassi confluence page validate --file <file>\` to see the server's parse error, or \`lassi confluence page get ${e.context.pageId} --format storage\` to inspect the original.`
      : undefined,
  (e) => {
    if (e.code !== 'not_found') return undefined;
    if (e.context.issueKey)
      return `Check the issue key ${e.context.issueKey}; run \`lassi jira issue search\` to look it up.`;
    if (e.context.pageId)
      return `Check the page id or title; run \`lassi confluence search\` to look it up.`;
    return undefined;
  },
];

/** Returns the catalogue hint for an error, or undefined when no rule applies. */
export function pickHint(err: LassiError): string | undefined {
  for (const rule of RULES) {
    const hint = rule(err);
    if (hint !== undefined) return hint;
  }
  return undefined;
}
