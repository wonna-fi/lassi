import type { LassiErrorCode } from './codes.js';

export type Product = 'jira' | 'confluence';

export interface RequestRef {
  method: string;
  /** Path (and query) only; never the origin, headers or bodies. */
  url: string;
}

/**
 * Facts the hint catalogue  needs to choose a next step. Filled by whoever throws, or by
 * the CLI's `enrichError` before rendering. Everything is optional; a missing fact just narrows the
 * set of hints that can fire.
 */
export interface HintContext {
  product?: Product;
  issueKey?: string;
  project?: string;
  issueType?: string;
  pageId?: string;
  workingFile?: string;
  tokenFile?: string;
  aliases?: Record<string, string>;
  readOnlyVar?: string;
  versionFrom?: number;
  versionTo?: number;
  allowedValues?: Record<string, string[]>;
  transition?: boolean;
  operation?: 'create' | 'update' | 'transition' | 'comment' | 'link' | 'search' | 'other';
}

export interface LassiErrorInit {
  http?: number;
  /** Jira's per-field error map, verbatim (keys are raw field ids). */
  errors?: Record<string, string>;
  /** Jira's `errorMessages`, or Confluence's flattened `data.errors`, verbatim. */
  errorMessages?: string[];
  hint?: string;
  request?: RequestRef;
  context?: HintContext;
  cause?: unknown;
}

/**
 * The single error type every command reports. One class with a `code` discriminant: one check
 * (`isLassiError`), a plain JSON projection (`toErrorJson`), and a table lookup for the exit code.
 */
export class LassiError extends Error {
  readonly code: LassiErrorCode;
  readonly http: number | undefined;
  readonly errors: Record<string, string> | undefined;
  readonly errorMessages: string[] | undefined;
  readonly request: RequestRef | undefined;
  errorsByAlias: Record<string, string> | undefined;
  hint: string | undefined;
  context: HintContext;

  constructor(code: LassiErrorCode, message: string, init: LassiErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'LassiError';
    this.code = code;
    this.http = init.http;
    this.errors = init.errors;
    this.errorMessages = init.errorMessages;
    this.request = init.request;
    this.errorsByAlias = undefined;
    this.hint = init.hint;
    this.context = init.context ?? {};
  }
}

/** Structural check so an LassiError from another package copy still classifies. */
export function isLassiError(value: unknown): value is LassiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { name?: unknown }).name === 'LassiError' &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}

/** Adds `errorsByAlias` for every field-id key of `errors` that has an alias. */
export function attachAliases(err: LassiError, aliases: Record<string, string>): LassiError {
  if (!err.errors) return err;
  const byId = new Map<string, string>();
  for (const [alias, id] of Object.entries(aliases)) {
    if (!byId.has(id)) byId.set(id, alias);
  }
  const out: Record<string, string> = {};
  for (const [id, message] of Object.entries(err.errors)) {
    const alias = byId.get(id);
    if (alias !== undefined) out[alias] = message;
  }
  if (Object.keys(out).length > 0) err.errorsByAlias = out;
  err.context = { ...err.context, aliases: { ...err.context.aliases, ...aliases } };
  return err;
}
