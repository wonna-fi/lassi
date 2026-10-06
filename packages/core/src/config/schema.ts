import { z } from 'zod';

const url = z
  .string()
  .regex(/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/, 'must be an http(s) URL')
  .transform((u) => u.replace(/\/+$/, ''));

const product = {
  url: url.optional(),
  /** Only ever arrives through the env layer; `doctor` warns when a file contains it. */
  token: z.string().optional(),
  tokenFile: z.string().optional(),
};

const jiraFieldObject = z.strictObject({
  id: z.string(),
  /** Custom fields are read-only unless this is true; other fields are writable unless false. */
  editable: z.boolean().optional(),
  /** `wiki` shows the value as Markdown and converts it back on update; `raw` leaves it as Jira sends it. */
  format: z.enum(['raw', 'wiki']).optional(),
  /** Leaves the field out of working files, issue output and exports. */
  exclude: z.boolean().optional(),
});

/** A field id, or the id with its policy. */
export type JiraFieldEntry = string | z.infer<typeof jiraFieldObject>;

/**
 * Checked by hand rather than as a union: a union reports only "Invalid input" at the alias, and
 * the object's own issues (a missing `id`, an unknown `format`) are what tell the user the fix.
 * A string is kept as written, so `doctor` can still tell the shorthand from the object form.
 */
const jiraFieldEntry = z.custom<JiraFieldEntry>().check((ctx) => {
  const value = ctx.value;
  if (typeof value === 'string') return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    ctx.issues.push({
      code: 'custom',
      message: 'expected a field id or { "id": "...", "editable": true }',
      input: value,
    });
    return;
  }
  const parsed = jiraFieldObject.safeParse(value);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.issues.push({ code: 'custom', message: issue.message, path: issue.path, input: value });
  }
});

/** Unknown keys fail fast (exit 2) instead of being silently ignored. */
export const LassiConfigSchema = z.strictObject({
  jira: z
    .strictObject({
      ...product,
      /** alias -> field id, or { id, editable, format, exclude } (workspace file). */
      fields: z.record(z.string(), jiraFieldEntry).default({}),
      defaultProject: z.string().optional(),
      /** Regular expression whose first capture group is the issue key in a branch name (`.` as the key). */
      branchPattern: z.string().optional(),
      /** `issue create --template <name>` defaults; values as they would be passed to `--field`. */
      templates: z
        .record(
          z.string(),
          z.strictObject({
            type: z.string().optional(),
            project: z.string().optional(),
            summary: z.string().optional(),
            fields: z
              .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
              .default({}),
            description: z.string().optional(),
            /** Relative to the config file that sets it; `~` expanded. */
            descriptionFile: z.string().optional(),
          })
        )
        .default({}),
    })
    .prefault({}),
  confluence: z
    .strictObject({
      ...product,
      defaultSpace: z.string().optional(),
      /** Appended to `_links.download` when the instance needs e.g. `download=true`. */
      downloadUrlSuffix: z.string().optional(),
    })
    .prefault({}),
  output: z
    .strictObject({ json: z.boolean().default(false), axi: z.boolean().default(false) })
    .prefault({}),
  attachments: z
    .strictObject({
      dir: z.string().default('./.lassi'),
      maxSizeMb: z.number().positive().default(50),
    })
    .prefault({}),
  /** User-wide archives and indexes; workspace config cannot redirect shared storage. */
  storage: z
    .strictObject({
      exportDir: z
        .string()
        .refine((s) => s.trim().length > 0, 'must not be empty')
        .default('~/.lassi/export'),
      indexDir: z
        .string()
        .refine((s) => s.trim().length > 0, 'must not be empty')
        .default('~/.lassi/index'),
    })
    .prefault({}),
  http: z
    .strictObject({
      timeoutMs: z.number().int().positive().default(30_000),
      retries: z.number().int().min(1).max(10).default(3),
    })
    .prefault({}),
  /** OpenAI-compatible `/embeddings` endpoint for `lassi search index|query`. */
  embeddings: z
    .strictObject({
      url: url.optional(),
      model: z.string().optional(),
      /** Only ever arrives through the env layer; `doctor` warns when a file contains it. */
      apiKey: z.string().optional(),
      apiKeyFile: z.string().optional(),
      /** `bearer` (OpenAI-style key), `api-key` (Azure OpenAI key), `azure-ad` (Entra ID token from `az login`). */
      auth: z.enum(['bearer', 'api-key', 'azure-ad']).default('bearer'),
      /** Token scope for `azure-ad`; the Azure OpenAI / Foundry default. */
      azureScope: z
        .string()
        .regex(
          /^[0-9a-zA-Z-_.:/]+$/,
          'must be an Entra ID scope such as https://cognitiveservices.azure.com/.default'
        )
        .default('https://cognitiveservices.azure.com/.default'),
      /** Azure OpenAI needs `?api-version=…` on every call. */
      apiVersion: z.string().optional(),
      dimensions: z.number().int().positive().optional(),
      batchSize: z.number().int().positive().max(2048).default(64),
      chunkChars: z.number().int().min(200).default(1500),
      chunkOverlap: z.number().int().min(0).default(200),
      /**
       * Cosine similarity below which `search query` calls a chunk noise (model-dependent).
       * Excludes 1: vectors are float32, so even an identical text scores just under it.
       */
      minScore: z.number().min(0).lt(1).default(0.33),
    })
    .prefault({}),
  /** WSL paths under /mnt/c always report 777, so the warning must be suppressible. */
  tokenPermissionWarning: z.boolean().default(true),
});

export type LassiConfig = z.infer<typeof LassiConfigSchema>;
export type IssueTemplate = LassiConfig['jira']['templates'][string];
export type ProductConfig = LassiConfig['jira'] | LassiConfig['confluence'];
