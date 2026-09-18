import type { LassiError, RequestRef } from './lassi-error.js';
import type { LassiErrorCode } from './codes.js';

/** Key order is part of the contract. */
export interface ErrorJson {
  code: LassiErrorCode;
  http?: number;
  message: string;
  errors?: Record<string, string>;
  errorsByAlias?: Record<string, string>;
  errorMessages?: string[];
  hint?: string;
  request?: RequestRef;
}

export function toErrorJson(err: LassiError): ErrorJson {
  const out: ErrorJson = { code: err.code, message: err.message };
  if (err.http !== undefined) {
    // Insert `http` between `code` and `message` so the JSON reads in contract order.
    delete (out as Partial<ErrorJson>).message;
    out.http = err.http;
    out.message = err.message;
  }
  if (err.errors !== undefined) out.errors = err.errors;
  if (err.errorsByAlias !== undefined) out.errorsByAlias = err.errorsByAlias;
  if (err.errorMessages !== undefined) out.errorMessages = err.errorMessages;
  if (err.hint !== undefined) out.hint = err.hint;
  if (err.request !== undefined) out.request = err.request;
  return out;
}

function productName(err: LassiError): string | undefined {
  switch (err.context.product) {
    case 'jira':
      return 'Jira';
    case 'confluence':
      return 'Confluence';
    default:
      return undefined;
  }
}

/** The human line: `error: Jira rejected the request (400): Team is required.` */
/** promises one human line then one JSON line; a message may carry newlines. */
function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

export function humanLine(err: LassiError): string {
  const product = productName(err);
  const message = oneLine(err.message);
  if (err.http !== undefined && product !== undefined) {
    return `error: ${product} rejected the request (${err.http}): ${message}`;
  }
  if (err.http !== undefined) return `error: HTTP ${err.http}: ${message}`;
  return `error: ${message}`;
}

/** One human-readable line, then the JSON object on its own line. */
export function toStderr(err: LassiError, redact: (s: string) => string = (s) => s): string {
  return `${redact(humanLine(err))}\n${redact(JSON.stringify(toErrorJson(err)))}\n`;
}
