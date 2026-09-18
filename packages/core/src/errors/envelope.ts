export interface ErrorEnvelope {
  message?: string;
  errors?: Record<string, string>;
  errorMessages?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
}

/**
 * Extracts the parts of an Atlassian error body that the contract passes through verbatim.
 *
 * Jira DC:        `{ "errorMessages": [...], "errors": { "<fieldId>": "<message>" } }`
 * Confluence DC:  `{ "statusCode": 400, "message": "...", "reason": "...",
 *                    "data": { "errors": [ { "message": { "key": "...", "translation": "..." } } ] } }`
 * Anything else yields `{}`; callers fall back to the HTTP status text.
 */
export function parseErrorEnvelope(json: unknown): ErrorEnvelope {
  if (!isRecord(json)) return {};
  const out: ErrorEnvelope = {};

  const errors = stringMap(json['errors']);
  if (errors) out.errors = errors;

  const errorMessages = stringList(json['errorMessages']);
  if (errorMessages) out.errorMessages = errorMessages;

  if (typeof json['message'] === 'string' && json['message'].length > 0) {
    out.message = json['message'];
  }

  const data = json['data'];
  if (isRecord(data) && Array.isArray(data['errors'])) {
    const flattened: string[] = [];
    for (const entry of data['errors']) {
      if (!isRecord(entry)) continue;
      const message = entry['message'];
      if (typeof message === 'string') {
        flattened.push(message);
      } else if (isRecord(message)) {
        const text = message['translation'] ?? message['key'];
        if (typeof text === 'string') flattened.push(text);
      }
    }
    if (flattened.length > 0) out.errorMessages = [...(out.errorMessages ?? []), ...flattened];
  }

  return out;
}
