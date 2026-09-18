import { z } from 'zod';
import { LassiError } from '../errors/lassi-error.js';
import { pathApi, resolvePath } from '../fs/paths.js';
import { envLayers } from './env.js';
import { parseJsonc } from './jsonc.js';
import { flatten, mergeLayers, unflatten, type Layer, type SourceInfo } from './layers.js';
import { expandHome, findWorkspaceConfig, WORKSPACE_CONFIG_NAME } from './paths.js';
import { LassiConfigSchema, type LassiConfig } from './schema.js';

export interface ConfigFs {
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  /**
   * Symlinks followed; used to keep a template file inside its directory. Required: without it the
   * containment check below would silently degrade to a lexical comparison, and an in-tree symlink
   * pointing at a credential file would pass.
   */
  realpath(path: string): Promise<string>;
}

/**
 * `path` with symlinks followed as far as the filesystem knows it: the deepest existing ancestor is
 * resolved and the segments below it are re-joined. Resolving only the whole path would fall back to
 * the lexical form for a file that does not exist yet, which then compares against a resolved base
 * in another namespace and reads as an escape under a symlinked workspace root.
 */
async function canonical(fs: ConfigFs, path: string): Promise<string> {
  const api = pathApi(path);
  const below: string[] = [];
  let current = path;
  for (;;) {
    try {
      const resolved = await fs.realpath(current);
      return below.length === 0 ? resolved : api.join(resolved, ...below);
    } catch {
      const parent = api.dirname(current);
      if (parent === current) return path;
      below.unshift(api.basename(current));
      current = parent;
    }
  }
}

export interface LoadConfigOptions {
  env: Record<string, string | undefined>;
  cwd: string;
  homedir: string;
  /** `--config`: replaces the global file only; the workspace walk-up still applies. */
  explicitPath?: string;
  /** Dotted leaf overrides from command-line flags, e.g. `{ 'output.json': true }`. */
  flags?: Record<string, unknown>;
  fs: ConfigFs;
}

export interface LoadedConfig {
  config: LassiConfig;
  /** Local working-file and cache root. */
  workspaceStateDir: string;
  /** Per dotted leaf (including `jira.fields.<alias>`), which layer supplied the value. */
  sources: Record<string, SourceInfo>;
  files: { global?: string; workspace?: string };
  /** Raw parsed workspace file, for `doctor`'s secret check. */
  rawWorkspace?: unknown;
  /** Token values that arrived through the environment; fed to the redactor. */
  secrets: string[];
}

async function fileLayer(
  fs: ConfigFs,
  path: string,
  source: 'global' | 'workspace'
): Promise<{ layer: Layer; raw: unknown } | undefined> {
  if (!(await fs.exists(path))) return undefined;
  const text = await fs.readFile(path);
  let raw: unknown;
  try {
    raw = parseJsonc(text);
  } catch (err) {
    throw new LassiError('usage', `${path}: not valid JSON (${(err as Error).message})`, {
      cause: err,
    });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LassiError('usage', `${path}: expected a JSON object at the top level`);
  }
  return { layer: { source, from: path, values: flatten(raw as Record<string, unknown>) }, raw };
}

/** Common configuration mistakes get a targeted correction. */
const RENAMED_KEYS: Readonly<Record<string, string>> = {
  'embeddings.authHeader': 'embeddings.auth',
};

/**
 * What a workspace `.lassi.json` may set. The file ships inside a checked-out repository,
 * so it is untrusted input: it carries team conventions, but it may not decide which host a request
 * goes to, which file is read as the credential, or whether the credential warnings are shown.
 * An entry ending in `.` matches a whole subtree.
 *
 * This is an allow-list rather than a deny-list so that a key added to the schema later stays out of
 * the workspace layer until someone decides it belongs there. An inline `jira.token` is allowed
 * through on purpose: it cannot redirect anything, and `doctor`'s workspace-secrets check is what
 * tells the user to move it.
 */
const WORKSPACE_ALLOWED: readonly string[] = [
  'jira.token',
  'jira.fields.',
  'jira.defaultProject',
  'jira.branchPattern',
  'jira.templates.',
  'confluence.token',
  'confluence.defaultSpace',
  'confluence.downloadUrlSuffix',
  'output.',
  'attachments.',
  'http.',
  'embeddings.apiKey',
  'embeddings.model',
  'embeddings.apiVersion',
  'embeddings.dimensions',
  'embeddings.batchSize',
  'embeddings.chunkChars',
  'embeddings.chunkOverlap',
  'embeddings.minScore',
];

function refusedFromWorkspace(values: Record<string, unknown>): string[] {
  return Object.keys(values)
    .filter(
      (key) => !WORKSPACE_ALLOWED.some((a) => (a.endsWith('.') ? key.startsWith(a) : key === a))
    )
    .sort();
}

/** precedence: defaults < ~/.lassi.json (or --config/LASSI_CONFIG) < workspace .lassi.json < env < flags. */
export async function loadConfig(opts: LoadConfigOptions): Promise<LoadedConfig> {
  const layers: Layer[] = [];
  const files: LoadedConfig['files'] = {};

  // An empty `LASSI_CONFIG` is unset, the way `${VAR:-default}` reads it: optional interpolation
  // produces one routinely, and resolving `''` gives the current directory, which exists and then
  // fails as EISDIR on the read. An empty `--config` is a mistake worth naming instead.
  if (opts.explicitPath !== undefined && opts.explicitPath.trim() === '') {
    throw new LassiError('usage', '--config needs a path');
  }
  const fromEnv = opts.env['LASSI_CONFIG']?.trim();
  const homeApi = pathApi(opts.homedir);
  const homeConfig = homeApi.join(opts.homedir, WORKSPACE_CONFIG_NAME);
  // Resolved against the injected cwd: `--config .lassi.json` run from the directory that holds it
  // would otherwise stay relative while the walk-up returns an absolute path, so the same file would
  // load a second time as the workspace layer and be judged by the workspace rules below.
  const configured = opts.explicitPath ?? (fromEnv ? fromEnv : undefined);
  const globalPath =
    configured === undefined
      ? homeConfig
      : resolvePath(opts.cwd, expandHome(configured, opts.homedir));
  const global = await fileLayer(opts.fs, globalPath, 'global');
  if (global) {
    layers.push(global.layer);
    files.global = globalPath;
  } else if (configured !== undefined) {
    throw new LassiError('usage', `config file not found: ${globalPath}`);
  }

  // The home file is the global layer by definition. Without this the walk-up finds it again for
  // any cwd under $HOME and loads it as the higher-precedence workspace layer, which would let
  // `~/.lassi.json` quietly outrank an explicit `--config` and send writes to the wrong instance.
  const workspacePath = await findWorkspaceConfig(opts.cwd, (p) => opts.fs.exists(p));
  let rawWorkspace: unknown;
  // By identity, not by string: `.lassi.json` can be a symlink to the file `--config` names, and two
  // spellings of one file would load it twice — the second time under the workspace rules.
  const sameFile = async (a: string, b: string): Promise<boolean> =>
    a === b || (await canonical(opts.fs, a)) === (await canonical(opts.fs, b));
  if (
    workspacePath !== undefined &&
    !(await sameFile(workspacePath, globalPath)) &&
    !(await sameFile(workspacePath, homeConfig))
  ) {
    const workspace = await fileLayer(opts.fs, workspacePath, 'workspace');
    if (workspace) {
      const refused = refusedFromWorkspace(workspace.layer.values);
      if (refused.length > 0) {
        throw new LassiError(
          'usage',
          `${workspacePath}: a workspace config may not set ${refused.join(', ')}`,
          {
            hint: 'move these to ~/.lassi.json or the LASSI_* environment variables; a workspace file travels with the repository, so it may not choose the host, credential or shared storage roots',
          }
        );
      }
      layers.push(workspace.layer);
      files.workspace = workspacePath;
      rawWorkspace = workspace.raw;
    }
  }

  layers.push(...envLayers(opts.env));
  if (opts.flags) layers.push({ source: 'flag', values: opts.flags });

  const merged = mergeLayers(layers);
  const where = [files.global, files.workspace].filter(Boolean).join(', ') || 'environment/flags';
  for (const [old, current] of Object.entries(RENAMED_KEYS)) {
    if (merged.values[old] !== undefined) {
      throw new LassiError('usage', `invalid configuration (${where}): "${old}" was renamed`, {
        hint: `use "${current}" instead of "${old}"`,
      });
    }
  }
  const parsed = LassiConfigSchema.safeParse(unflatten(merged.values));
  if (!parsed.success) {
    throw new LassiError(
      'usage',
      `invalid configuration (${where}):\n${z.prettifyError(parsed.error)}`
    );
  }
  const config = parsed.data;
  const cwdApi = pathApi(opts.cwd);
  const workspaceStateDir = cwdApi.join(opts.cwd, '.lassi');
  for (const key of ['exportDir', 'indexDir'] as const) {
    const source = merged.sources[`storage.${key}`];
    const base =
      source?.source === 'global' && source.from
        ? pathApi(source.from).dirname(source.from)
        : opts.homedir;
    // Shared storage must not change when an agent changes its working directory.
    config.storage[key] = resolvePath(base, expandHome(config.storage[key], opts.homedir));
  }
  if (config.embeddings.auth === 'azure-ad') {
    if (config.embeddings.apiKey !== undefined || config.embeddings.apiKeyFile !== undefined) {
      throw new LassiError(
        'usage',
        'embeddings.auth is "azure-ad", so embeddings.apiKey / apiKeyFile / LASSI_EMBEDDINGS_API_KEY would be ignored; remove them or choose "bearer" / "api-key"'
      );
    }
  } else if (merged.values['embeddings.azureScope'] !== undefined) {
    throw new LassiError(
      'usage',
      `embeddings.azureScope only applies to embeddings.auth "azure-ad" (configured: "${config.embeddings.auth}")`
    );
  }
  if (config.output.json && config.output.axi) {
    throw new LassiError(
      'usage',
      'output.json and output.axi are mutually exclusive; set at most one of them (or pass --json / --axi)'
    );
  }
  if (config.jira.tokenFile)
    config.jira.tokenFile = expandHome(config.jira.tokenFile, opts.homedir);
  if (config.confluence.tokenFile) {
    config.confluence.tokenFile = expandHome(config.confluence.tokenFile, opts.homedir);
  }
  if (config.embeddings.apiKeyFile) {
    config.embeddings.apiKeyFile = expandHome(config.embeddings.apiKeyFile, opts.homedir);
  }
  // Loop-invariant, and only needed when some template names a file: the credential paths are the
  // same for every template, and one workspace directory is shared by all of its templates.
  let credentialPaths: Promise<string[]> | undefined;
  const credentials = (): Promise<string[]> => {
    credentialPaths ??= Promise.all(
      [config.jira.tokenFile, config.confluence.tokenFile, config.embeddings.apiKeyFile]
        .filter((c): c is string => c !== undefined)
        .map((c) => canonical(opts.fs, resolvePath(opts.cwd, c)))
    );
    return credentialPaths;
  };
  const canonicalDirs = new Map<string, Promise<string>>();
  const canonicalDir = (dir: string): Promise<string> => {
    let pending = canonicalDirs.get(dir);
    if (!pending) {
      pending = canonical(opts.fs, dir);
      canonicalDirs.set(dir, pending);
    }
    return pending;
  };
  for (const [name, template] of Object.entries(config.jira.templates)) {
    // A dot would already have split into nesting in the dotted-path merge; zod's own key check
    // only says "invalid key", so the rule is stated here.
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new LassiError(
        'usage',
        `jira.templates: "${name}" is not a valid name; template names are letters, digits, "-" and "_"`
      );
    }
    if (template.description !== undefined && template.descriptionFile !== undefined) {
      throw new LassiError(
        'usage',
        `jira.templates.${name}: set description or descriptionFile, not both`
      );
    }
    if (template.descriptionFile !== undefined) {
      // Relative to the file that set it, so a team-versioned workspace file can point at a
      // sibling `templates/bug.md` whatever directory the command runs from. A checked-out
      // workspace file is untrusted, so it may only name files inside its own directory; the
      // template read is a plain `lassi jira templates` read that hosts auto-approve, and nothing
      // may turn it into `cat ~/.lassi/tokens/jira.txt`.
      const key = `jira.templates.${name}.descriptionFile`;
      const info = merged.sources[key];
      const from = info?.from;
      const dir = from ? pathApi(from).dirname(from) : opts.cwd;
      const workspace = info?.source === 'workspace';
      const resolved = resolvePath(
        dir,
        workspace ? template.descriptionFile : expandHome(template.descriptionFile, opts.homedir)
      );
      const api = pathApi(dir);
      const canonicalFile = await canonical(opts.fs, resolved);
      if (workspace) {
        // Every rule is applied to the configured path and to the symlink target, because a
        // repository can commit a symlink: `templates/bug.md -> .env` is contained, ends in `.md`
        // and is not under `.git`, and `lassi jira templates` would print the secret it points at.
        const pairs: Array<[string, string]> = [
          [dir, resolved],
          [await canonicalDir(dir), canonicalFile],
        ];
        // Lexically and then with symlinks followed: an in-tree link to a file outside is outside.
        const escapes = pairs.some(([base, target]) => {
          const relative = api.relative(base, target);
          return relative.startsWith('..') || api.isAbsolute(relative);
        });
        if (escapes || /^~([\\/]|$)/.test(template.descriptionFile)) {
          throw new LassiError(
            'usage',
            `${key}: a workspace file may only name files inside ${dir} (got ${template.descriptionFile})`
          );
        }
        // Inside the workspace is not enough: `.env` and `.git/config` are in there too, and
        // `lassi jira templates <name>` prints whatever this points at under a read hosts auto-approve.
        if (pairs.some(([, target]) => !/\.(?:md|markdown)$/i.test(target))) {
          throw new LassiError(
            'usage',
            `${key}: a workspace file may only name a .md or .markdown file (got ${template.descriptionFile})`
          );
        }
        if (
          pairs.some(([base, target]) => api.relative(base, target).split(/[\\/]/).includes('.git'))
        ) {
          throw new LassiError(
            'usage',
            `${key}: a workspace file may not name a file under .git (got ${template.descriptionFile})`
          );
        }
      }
      if ((await credentials()).includes(canonicalFile)) {
        throw new LassiError('usage', `${key}: ${resolved} is a credential file, not a template`);
      }
      // The path as configured, not the symlink target: `lassi jira templates`, `--json` and `doctor`
      // all show this, and an alien path there is confusing. The canonical form decided the checks.
      template.descriptionFile = resolved;
    }
  }
  if (config.embeddings.chunkOverlap >= config.embeddings.chunkChars) {
    throw new LassiError(
      'usage',
      'embeddings.chunkOverlap must be smaller than embeddings.chunkChars'
    );
  }

  const sources: Record<string, SourceInfo> = {};
  for (const path of Object.keys(flatten(config as unknown as Record<string, unknown>))) {
    sources[path] = merged.sources[path] ?? { source: 'default' };
  }

  const secrets = [config.jira.token, config.confluence.token, config.embeddings.apiKey].filter(
    (t): t is string => typeof t === 'string' && t.length > 0
  );

  const out: LoadedConfig = { config, workspaceStateDir, sources, files, secrets };
  if (rawWorkspace !== undefined) out.rawWorkspace = rawWorkspace;
  return out;
}
