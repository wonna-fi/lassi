import { LassiError, isLassiError, type HintContext, type HttpClient } from '@wonna/lassi-core';
import type {
  CreatemetaMode,
  JiraCreateMeta,
  JiraFieldDef,
  JiraFieldMeta,
  JiraFieldMetaMap,
  JiraIssueTypeList,
  JiraIssueTypeMeta,
  JiraProjectRef,
} from './types.js';

interface Page<T> {
  values?: T[];
  total?: number;
  startAt?: number;
  maxResults?: number;
  isLast?: boolean;
}

type FieldMetaWithoutId = Omit<JiraFieldMeta, 'fieldId'> & { fieldId?: string };

interface LegacyIssueType {
  id: string;
  name: string;
  subtask?: boolean;
  fields?: Record<string, FieldMetaWithoutId>;
}

type LegacyProject = JiraProjectRef & { issuetypes?: LegacyIssueType[] };

interface LegacyCreatemeta {
  projects?: LegacyProject[];
}

function projectRef(proj: LegacyProject): JiraProjectRef {
  const ref: JiraProjectRef = { key: proj.key };
  if (proj.id) ref.id = proj.id;
  if (proj.name) ref.name = proj.name;
  return ref;
}

interface Editmeta {
  fields?: Record<string, FieldMetaWithoutId>;
}

export function withIds(fields: Record<string, FieldMetaWithoutId> | undefined): JiraFieldMetaMap {
  const out: JiraFieldMetaMap = {};
  for (const [id, meta] of Object.entries(fields ?? {})) {
    out[id] = { ...meta, fieldId: meta.fieldId ?? id };
  }
  return out;
}

async function drain<T>(http: HttpClient, path: string, context: HintContext): Promise<T[]> {
  const out: T[] = [];
  let startAt = 0;
  for (let i = 0; i < 100; i++) {
    const page = await http.get<Page<T>>(path, { query: { startAt, maxResults: 100 }, context });
    const values = page?.values ?? [];
    out.push(...values);
    startAt += values.length;
    const total = page?.total;
    if (values.length === 0 || page?.isLast === true || (total !== undefined && startAt >= total)) {
      break;
    }
  }
  return out;
}

function unknownType(
  project: string,
  issueType: string,
  known: string[],
  context: HintContext
): LassiError {
  const available = known.length > 0 ? `; available: ${known.join(', ')}` : '';
  return new LassiError(
    'validation',
    `issue type "${issueType}" is not available in ${project}${available}`,
    { context: known.length > 0 ? { ...context, allowedValues: { issueType: known } } : context }
  );
}

/**
 * Jira 9+ serves paginated createmeta and dropped the legacy `expand` form; older servers only
 * have the legacy form. Paginated is tried first. A 404 there is ambiguous (a missing project
 * answers 404 too), so the client switches to legacy only once the legacy form has actually
 * returned the project. Results are memoised per
 * project/type so `issue create` pre-checks and coerces from one fetch.
 */
export class CreatemetaResolver {
  private mode: CreatemetaMode = 'unknown';
  private readonly cache = new Map<string, Promise<JiraCreateMeta>>();
  private readonly http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  currentMode(): CreatemetaMode {
    return this.mode;
  }

  resolve(project: string, issueType?: string): Promise<JiraCreateMeta> {
    const cacheKey = `${project}\u0000${issueType?.toLowerCase() ?? ''}`;
    let pending = this.cache.get(cacheKey);
    if (!pending) {
      pending = this.load(project, issueType).catch((err: unknown) => {
        this.cache.delete(cacheKey);
        throw err;
      });
      this.cache.set(cacheKey, pending);
    }
    return pending;
  }

  /**
   * Issue types only, in one request (two on the legacy fallback). `doctor` uses this to report
   * the createmeta shape: the per-type field metadata behind `resolve` costs one slow request per
   * issue type on a large instance.
   */
  async issueTypes(project: string): Promise<JiraIssueTypeList> {
    const context: HintContext = { product: 'jira', project, operation: 'create' };
    const viaLegacy = async (): Promise<JiraIssueTypeList> => {
      const proj = await this.legacyProject(project, undefined, false, context);
      return {
        project: projectRef(proj),
        issueTypes: (proj.issuetypes ?? []).map((t) => ({
          id: t.id,
          name: t.name,
          subtask: t.subtask ?? false,
        })),
        mode: 'legacy',
      };
    };
    if (this.mode === 'legacy') return viaLegacy();
    try {
      const types = await this.paginatedTypes(project, context);
      this.mode = 'paginated';
      return { project: { key: project }, issueTypes: types, mode: 'paginated' };
    } catch (err) {
      if (!this.mayBeLegacy(err)) throw err;
      return this.settleLegacy(err, viaLegacy);
    }
  }

  private async load(project: string, issueType: string | undefined): Promise<JiraCreateMeta> {
    const context: HintContext = { product: 'jira', project, operation: 'create' };
    if (issueType) context.issueType = issueType;
    if (this.mode === 'legacy') return this.legacy(project, issueType, context);
    try {
      const meta = await this.paginated(project, issueType, context);
      this.mode = 'paginated';
      return meta;
    } catch (err) {
      if (!this.mayBeLegacy(err)) throw err;
      return this.settleLegacy(err, () => this.legacy(project, issueType, context));
    }
  }

  private mayBeLegacy(err: unknown): boolean {
    return this.mode === 'unknown' && isLassiError(err) && err.code === 'not_found';
  }

  /** After a paginated 404 the legacy form decides whether the endpoint or the project is missing. */
  private async settleLegacy<T>(paginatedErr: unknown, run: () => Promise<T>): Promise<T> {
    try {
      const result = await run();
      this.mode = 'legacy';
      return result;
    } catch (err) {
      // Both forms answered 404: the project is missing (or this is Jira 9 without the legacy
      // form), so the first answer, which names the project, is the one to report.
      if (isLassiError(err) && err.http === 404) throw paginatedErr;
      throw err;
    }
  }

  private async legacyProject(
    project: string,
    issueType: string | undefined,
    withFields: boolean,
    context: HintContext
  ): Promise<LegacyProject> {
    const raw = await this.http.get<LegacyCreatemeta>('/rest/api/2/issue/createmeta', {
      query: {
        projectKeys: project,
        ...(issueType ? { issuetypeNames: issueType } : {}),
        ...(withFields ? { expand: 'projects.issuetypes.fields' } : {}),
      },
      context,
    });
    const proj = raw?.projects?.[0];
    if (!proj) {
      throw new LassiError('not_found', `project ${project} not found or not creatable`, {
        context,
      });
    }
    return proj;
  }

  private async legacy(
    project: string,
    issueType: string | undefined,
    context: HintContext
  ): Promise<JiraCreateMeta> {
    const proj = await this.legacyProject(project, issueType, true, context);
    const issueTypes: JiraIssueTypeMeta[] = (proj.issuetypes ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      subtask: t.subtask ?? false,
      fields: withIds(t.fields),
    }));
    if (issueType && issueTypes.length === 0) throw unknownType(project, issueType, [], context);
    return { project: projectRef(proj), issueTypes, mode: 'legacy' };
  }

  private paginatedTypes(
    project: string,
    context: HintContext
  ): Promise<Array<{ id: string; name: string; subtask: boolean }>> {
    return drain<{ id: string; name: string; subtask?: boolean }>(
      this.http,
      `/rest/api/2/issue/createmeta/${encodeURIComponent(project)}/issuetypes`,
      context
    ).then((types) => types.map((t) => ({ id: t.id, name: t.name, subtask: t.subtask ?? false })));
  }

  private async paginated(
    project: string,
    issueType: string | undefined,
    context: HintContext
  ): Promise<JiraCreateMeta> {
    const base = `/rest/api/2/issue/createmeta/${encodeURIComponent(project)}/issuetypes`;
    const types = await this.paginatedTypes(project, context);
    const wanted = issueType?.toLowerCase();
    const selected = wanted
      ? types.filter((t) => t.name.toLowerCase() === wanted || t.id === issueType)
      : types;
    if (issueType && selected.length === 0) {
      throw unknownType(
        project,
        issueType,
        types.map((t) => t.name),
        context
      );
    }
    const issueTypes: JiraIssueTypeMeta[] = [];
    for (const t of selected) {
      const fields = await drain<JiraFieldMeta>(
        this.http,
        `${base}/${encodeURIComponent(t.id)}`,
        context
      );
      const map: JiraFieldMetaMap = {};
      for (const f of fields) map[f.fieldId] = f;
      issueTypes.push({ id: t.id, name: t.name, subtask: t.subtask, fields: map });
    }
    return { project: { key: project }, issueTypes, mode: 'paginated' };
  }
}

export async function editmeta(http: HttpClient, key: string): Promise<JiraFieldMetaMap> {
  const raw = await http.get<Editmeta>(`/rest/api/2/issue/${encodeURIComponent(key)}/editmeta`, {
    context: { product: 'jira', issueKey: key, operation: 'update' },
  });
  return withIds(raw?.fields);
}

export async function listFields(http: HttpClient): Promise<JiraFieldDef[]> {
  return (await http.get<JiraFieldDef[]>('/rest/api/2/field')) ?? [];
}
