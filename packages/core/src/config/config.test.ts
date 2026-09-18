import { describe, expect, it } from 'vitest';
import { isLassiError } from '../errors/lassi-error.js';
import { memFs } from '../testing/mem-fs.js';
import { ENV_MAP, envLayers } from './env.js';
import { parseJsonc, stripJsonComments } from './jsonc.js';
import { flatten, mergeLayers, unflatten } from './layers.js';
import { loadConfig } from './load.js';
import { expandHome, findWorkspaceConfig } from './paths.js';
import { findSecretLookingKeys } from './secrets.js';

describe('flatten / unflatten', () => {
  it('round-trips nested objects with arrays and null as leaves', () => {
    const obj = {
      jira: { url: 'x', fields: { team: 'customfield_10001' } },
      labels: ['a', 'b'],
      n: null,
    };
    const flat = flatten(obj);
    expect(flat).toEqual({
      'jira.url': 'x',
      'jira.fields.team': 'customfield_10001',
      labels: ['a', 'b'],
      n: null,
    });
    expect(unflatten(flat)).toEqual(obj);
  });

  it('drops empty objects so they cannot clobber earlier layers', () => {
    expect(flatten({ jira: {} })).toEqual({});
  });
});

describe('mergeLayers', () => {
  it('later layers win per leaf and record their source', () => {
    const merged = mergeLayers([
      {
        source: 'global',
        from: '/home/u/.lassi.json',
        values: { 'jira.url': 'g', 'http.retries': 2 },
      },
      {
        source: 'workspace',
        from: '/w/.lassi.json',
        values: { 'jira.fields.team': 'customfield_10001' },
      },
      { source: 'env', from: 'LASSI_JIRA_URL', values: { 'jira.url': 'e' } },
      { source: 'flag', values: { 'output.json': true, 'jira.url': undefined } },
    ]);
    expect(merged.values).toEqual({
      'jira.url': 'e',
      'http.retries': 2,
      'jira.fields.team': 'customfield_10001',
      'output.json': true,
    });
    expect(merged.sources['jira.url']).toEqual({ source: 'env', from: 'LASSI_JIRA_URL' });
    expect(merged.sources['http.retries']).toEqual({
      source: 'global',
      from: '/home/u/.lassi.json',
    });
    expect(merged.sources['output.json']).toEqual({ source: 'flag' });
  });
});

describe('envLayers', () => {
  it('maps every LASSI_* variable to its leaf and names the variable', () => {
    const env = Object.fromEntries(Object.keys(ENV_MAP).map((k) => [k, `v-${k}`]));
    const layers = envLayers(env);
    expect(layers).toHaveLength(Object.keys(ENV_MAP).length);
    for (const layer of layers) {
      const [path, value] = Object.entries(layer.values)[0] as [string, string];
      expect(ENV_MAP[layer.from as string]).toBe(path);
      expect(value).toBe(`v-${layer.from}`);
    }
  });

  it('ignores empty values and unrelated variables', () => {
    expect(envLayers({ LASSI_JIRA_URL: '', LASSI_UNKNOWN: 'x', LASSI_READ_ONLY: '1' })).toEqual([]);
  });
});

describe('jsonc', () => {
  it('strips comments but keeps // inside strings', () => {
    const text = `{
      // global config
      "jira": { "url": "https://jira.example.internal/jira" }, /* block */
      "s": "a\\"b // not a comment"
    }`;
    expect(parseJsonc(text)).toEqual({
      jira: { url: 'https://jira.example.internal/jira' },
      s: 'a"b // not a comment',
    });
    expect(stripJsonComments('{"a":1}')).toBe('{"a":1}');
  });
});

describe('paths', () => {
  it('expands ~ only at the start', () => {
    expect(expandHome('~/.lassi/tokens/t.txt', '/home/u')).toBe('/home/u/.lassi/tokens/t.txt');
    expect(expandHome('~', '/home/u')).toBe('/home/u');
    expect(expandHome('/abs/~/x', '/home/u')).toBe('/abs/~/x');
  });

  it('walks up to the first .lassi.json', async () => {
    const existing = new Set(['/home/u/proj/.lassi.json']);
    const exists = async (p: string): Promise<boolean> => existing.has(p);
    expect(await findWorkspaceConfig('/home/u/proj/a/b', exists)).toBe('/home/u/proj/.lassi.json');
    expect(await findWorkspaceConfig('/tmp/elsewhere', exists)).toBeUndefined();
  });
});

describe('findSecretLookingKeys', () => {
  it('flags token-like keys and PAT-like values, not file pointers or URLs', () => {
    expect(
      findSecretLookingKeys({
        jira: { token: 'abc', tokenFile: '~/t.txt', url: 'https://jira.example.internal' },
        x: { password: 'p' },
        y: 'A'.repeat(48),
      })
    ).toEqual(['jira.token', 'x.password', 'y']);
    expect(findSecretLookingKeys('nope')).toEqual([]);
  });
});

describe('loadConfig', () => {
  const homedir = '/home/u';
  const cwd = '/home/u/proj/sub';

  it('yields defaults with every source marked default when nothing is configured', async () => {
    const loaded = await loadConfig({ env: {}, cwd, homedir, fs: memFs() });
    expect(loaded.config).toEqual({
      jira: { fields: {}, templates: {} },
      confluence: {},
      output: { json: false, axi: false },
      embeddings: {
        auth: 'bearer',
        azureScope: 'https://cognitiveservices.azure.com/.default',
        batchSize: 64,
        chunkChars: 1500,
        chunkOverlap: 200,
        minScore: 0.33,
      },
      attachments: { dir: './.lassi', maxSizeMb: 50 },
      storage: { exportDir: '/home/u/.lassi/export', indexDir: '/home/u/.lassi/index' },
      http: { timeoutMs: 30_000, retries: 3 },
      tokenPermissionWarning: true,
    });
    expect(loaded.sources['http.timeoutMs']).toEqual({ source: 'default' });
    expect(loaded.files).toEqual({});
    expect(loaded.secrets).toEqual([]);
  });

  it('applies the five layers in order and tracks sources', async () => {
    const fs = memFs({
      '/home/u/.lassi.json': JSON.stringify({
        jira: { url: 'https://jira.example.internal/', tokenFile: '~/.lassi/tokens/jira.txt' },
        http: { retries: 5 },
      }),
      '/home/u/proj/.lassi.json': JSON.stringify({
        jira: { fields: { team: 'customfield_10001' }, defaultProject: 'PROJ' },
      }),
    });
    const loaded = await loadConfig({
      env: { LASSI_JIRA_TOKEN: 'env-token-value' },
      cwd,
      homedir,
      flags: { 'output.json': true },
      fs,
    });
    expect(loaded.config.jira.url).toBe('https://jira.example.internal');
    expect(loaded.config.jira.tokenFile).toBe('/home/u/.lassi/tokens/jira.txt');
    expect(loaded.config.jira.fields).toEqual({ team: 'customfield_10001' });
    expect(loaded.config.jira.token).toBe('env-token-value');
    expect(loaded.config.output.json).toBe(true);
    expect(loaded.config.http.retries).toBe(5);
    expect(loaded.sources['jira.url']).toEqual({ source: 'global', from: '/home/u/.lassi.json' });
    expect(loaded.sources['jira.fields.team']).toEqual({
      source: 'workspace',
      from: '/home/u/proj/.lassi.json',
    });
    expect(loaded.sources['jira.token']).toEqual({ source: 'env', from: 'LASSI_JIRA_TOKEN' });
    expect(loaded.sources['output.json']).toEqual({ source: 'flag' });
    expect(loaded.sources['http.timeoutMs']).toEqual({ source: 'default' });
    expect(loaded.files).toEqual({
      global: '/home/u/.lassi.json',
      workspace: '/home/u/proj/.lassi.json',
    });
    expect(loaded.rawWorkspace).toEqual({
      jira: { fields: { team: 'customfield_10001' }, defaultProject: 'PROJ' },
    });
    expect(loaded.secrets).toEqual(['env-token-value']);
  });

  it('does not apply the global file twice when the walk-up reaches the home directory', async () => {
    const fs = memFs({
      '/home/u/.lassi.json': JSON.stringify({ jira: { url: 'https://jira.example.internal' } }),
    });
    const loaded = await loadConfig({ env: {}, cwd: '/home/u/proj', homedir, fs });
    expect(loaded.files).toEqual({ global: '/home/u/.lassi.json' });
    expect(loaded.sources['jira.url']?.source).toBe('global');
  });

  it('--config replaces only the global file; the workspace file still applies', async () => {
    const fs = memFs({
      '/home/u/.lassi.json': JSON.stringify({ jira: { url: 'https://wrong.example.internal' } }),
      '/etc/alt.json': JSON.stringify({ jira: { url: 'https://alt.example.internal' } }),
      '/home/u/proj/.lassi.json': JSON.stringify({
        jira: { fields: { team: 'customfield_10001' } },
      }),
    });
    const loaded = await loadConfig({ env: {}, cwd, homedir, explicitPath: '/etc/alt.json', fs });
    expect(loaded.config.jira.url).toBe('https://alt.example.internal');
    expect(loaded.config.jira.fields).toEqual({ team: 'customfield_10001' });
    expect(loaded.files).toEqual({
      global: '/etc/alt.json',
      workspace: '/home/u/proj/.lassi.json',
    });
  });

  it('LASSI_CONFIG behaves like --config and a missing explicit file is a usage error', async () => {
    const fs = memFs({ '/etc/alt.json': JSON.stringify({ http: { retries: 2 } }) });
    const loaded = await loadConfig({ env: { LASSI_CONFIG: '/etc/alt.json' }, cwd, homedir, fs });
    expect(loaded.config.http.retries).toBe(2);
    await expect(
      loadConfig({ env: { LASSI_CONFIG: '/etc/missing.json' }, cwd, homedir, fs })
    ).rejects.toMatchObject({
      code: 'usage',
      message: 'config file not found: /etc/missing.json',
    });
  });

  it('rejects invalid JSON, unknown keys and bad URLs as usage errors naming the file', async () => {
    const bad = memFs({ '/home/u/.lassi.json': '{ not json' });
    await expect(loadConfig({ env: {}, cwd, homedir, fs: bad })).rejects.toSatisfy(
      (e: unknown) =>
        isLassiError(e) && e.code === 'usage' && e.message.includes('/home/u/.lassi.json')
    );
    const unknown = memFs({ '/home/u/.lassi.json': JSON.stringify({ jira: { urll: 'x' } }) });
    await expect(loadConfig({ env: {}, cwd, homedir, fs: unknown })).rejects.toSatisfy(
      (e: unknown) => isLassiError(e) && e.code === 'usage' && e.message.includes('urll')
    );
    const badUrl = memFs({
      '/home/u/.lassi.json': JSON.stringify({ jira: { url: 'jira.example.internal' } }),
    });
    await expect(loadConfig({ env: {}, cwd, homedir, fs: badUrl })).rejects.toSatisfy(
      (e: unknown) => isLassiError(e) && e.code === 'usage' && e.message.includes('http(s)')
    );
  });
});

describe('an explicit --config path', () => {
  it('is resolved against the cwd, so it is not read again as the workspace layer', async () => {
    // Relative, and run from the directory that holds it: the walk-up returns the absolute form, so
    // the two strings differed and the same file loaded twice — the second time under the workspace
    // rules, which refuse a URL and a token file.
    const fs = memFs({
      '/home/u/proj/.lassi.json': JSON.stringify({
        jira: { url: 'https://jira.example.internal', tokenFile: '/t/token.txt' },
      }),
    });
    const loaded = await loadConfig({
      env: {},
      cwd: '/home/u/proj',
      homedir: '/home/u',
      explicitPath: '.lassi.json',
      fs,
    });
    expect(loaded.config.jira.url).toBe('https://jira.example.internal');
    expect(loaded.files).toEqual({ global: '/home/u/proj/.lassi.json' });
    expect(loaded.sources['jira.url']).toMatchObject({ source: 'global' });

    const viaEnv = await loadConfig({
      env: { LASSI_CONFIG: '.lassi.json' },
      cwd: '/home/u/proj',
      homedir: '/home/u',
      fs,
    });
    expect(viaEnv.config.jira.tokenFile).toBe('/t/token.txt');
  });

  it('is the same file as a symlink the walk-up finds, so it still replaces only the global layer', () => {
    // `.lassi.json` links to `config/lassi.json`; passing the target explicitly gave two spellings of
    // one file, so it loaded twice and the second copy was judged by the workspace rules.
    const base = memFs({
      '/home/u/proj/config/lassi.json': JSON.stringify({
        jira: { url: 'https://jira.example.internal', tokenFile: '/t/token.txt' },
      }),
      '/home/u/proj/.lassi.json': 'a symlink in real life',
    });
    const linked = {
      ...base,
      realpath: async (path: string) =>
        path === '/home/u/proj/.lassi.json'
          ? '/home/u/proj/config/lassi.json'
          : base.realpath(path),
    };
    return expect(
      loadConfig({
        env: {},
        cwd: '/home/u/proj',
        homedir: '/home/u',
        explicitPath: 'config/lassi.json',
        fs: linked,
      }).then((l) => l.files)
    ).resolves.toEqual({ global: '/home/u/proj/config/lassi.json' });
  });

  it('treats an empty LASSI_CONFIG as unset, and an empty --config as a mistake', async () => {
    // Optional interpolation produces an empty value routinely. Resolving it gave the current
    // directory, which exists, so the read failed as EISDIR and surfaced as exit 1.
    const fs = memFs({
      '/home/u/.lassi.json': JSON.stringify({ jira: { url: 'https://jira.example.internal' } }),
    });
    const loaded = await loadConfig({
      env: { LASSI_CONFIG: '  ' },
      cwd: '/home/u/proj',
      homedir: '/home/u',
      fs,
    });
    expect(loaded.files).toEqual({ global: '/home/u/.lassi.json' });
    await expect(
      loadConfig({ env: {}, cwd: '/home/u/proj', homedir: '/home/u', explicitPath: '', fs })
    ).rejects.toSatisfy(
      (e: unknown) => isLassiError(e) && e.code === 'usage' && e.message.includes('--config needs')
    );
  });
});

describe('the workspace layer is untrusted', () => {
  const homedir = '/home/u';
  const cwd = '/home/u/proj/sub';

  it.each([
    [{ jira: { url: 'http://evil.example.com' } }, 'may not set jira.url'],
    [{ jira: { tokenFile: '/home/u/.ssh/id_ed25519' } }, 'may not set jira.tokenFile'],
    [{ confluence: { url: 'http://evil.example.com' } }, 'confluence.url'],
    [{ confluence: { tokenFile: '/t/x.txt' } }, 'confluence.tokenFile'],
    [{ embeddings: { url: 'http://evil.example.com' } }, 'embeddings.url'],
    [{ embeddings: { apiKeyFile: '/t/x.txt' } }, 'embeddings.apiKeyFile'],
    [{ embeddings: { auth: 'azure-ad' } }, 'embeddings.auth'],
    [{ embeddings: { azureScope: 'https://scope.example.com/.default' } }, 'embeddings.azureScope'],
    [{ tokenPermissionWarning: false }, 'tokenPermissionWarning'],
  ])('refuses a workspace file that sets %j', async (workspace, needle) => {
    const fs = memFs({
      '/home/u/.lassi.json': JSON.stringify({ jira: { url: 'https://jira.example.internal' } }),
      '/home/u/proj/.lassi.json': JSON.stringify(workspace),
    });
    await expect(loadConfig({ env: {}, cwd, homedir, fs })).rejects.toSatisfy(
      (e: unknown) => isLassiError(e) && e.code === 'usage' && e.message.includes(needle)
    );
  });

  it('names every refused key at once and points at the global file', async () => {
    const fs = memFs({
      '/home/u/proj/.lassi.json': JSON.stringify({
        jira: { url: 'http://evil.example.com', tokenFile: '/home/u/.ssh/id_ed25519' },
      }),
    });
    await expect(loadConfig({ env: {}, cwd, homedir, fs })).rejects.toSatisfy(
      (e: unknown) =>
        isLassiError(e) &&
        e.message.includes('jira.tokenFile, jira.url') &&
        (e.hint ?? '').includes('~/.lassi.json')
    );
  });

  it('still takes team conventions and tuning from the workspace file', async () => {
    const fs = memFs({
      '/home/u/.lassi.json': JSON.stringify({
        jira: { url: 'https://jira.example.internal', tokenFile: '/t/token.txt' },
      }),
      '/home/u/proj/.lassi.json': JSON.stringify({
        jira: { fields: { team: 'customfield_10001' }, defaultProject: 'PROJ', token: 'oops' },
        confluence: { defaultSpace: 'DEV' },
        output: { json: true },
        attachments: { maxSizeMb: 10 },
        http: { retries: 5 },
        embeddings: { model: 'text-embedding-3-small', chunkChars: 800, minScore: 0.4 },
      }),
    });
    const loaded = await loadConfig({ env: {}, cwd, homedir, fs });
    expect(loaded.config.jira.url).toBe('https://jira.example.internal');
    expect(loaded.config.jira.defaultProject).toBe('PROJ');
    expect(loaded.config.jira.fields).toEqual({ team: 'customfield_10001' });
    expect(loaded.config.confluence.defaultSpace).toBe('DEV');
    expect(loaded.config.output.json).toBe(true);
    expect(loaded.config.attachments.maxSizeMb).toBe(10);
    expect(loaded.config.http.retries).toBe(5);
    expect(loaded.config.embeddings.chunkChars).toBe(800);
    // An inline token cannot redirect anything; `doctor` is what tells the user to move it.
    expect(loaded.config.jira.token).toBe('oops');
  });

  it('lets the global file and the environment keep setting the host and the credential', async () => {
    const fs = memFs({
      '/home/u/.lassi.json': JSON.stringify({
        jira: { url: 'https://jira.example.internal', tokenFile: '/t/token.txt' },
      }),
      '/home/u/proj/.lassi.json': JSON.stringify({ jira: { defaultProject: 'PROJ' } }),
    });
    const loaded = await loadConfig({
      env: { LASSI_CONFLUENCE_URL: 'https://confluence.example.internal' },
      cwd,
      homedir,
      fs,
    });
    expect(loaded.config.jira.tokenFile).toBe('/t/token.txt');
    expect(loaded.config.confluence.url).toBe('https://confluence.example.internal');
  });
});

describe('jira.templates', () => {
  const homedir = '/home/u';
  const cwd = '/home/u/proj/sub';

  it('resolves descriptionFile against the file that set it and expands ~', async () => {
    const fs = memFs({
      '/home/u/.lassi.json': JSON.stringify({
        jira: { templates: { home: { descriptionFile: '~/tpl/home.md' } } },
      }),
      '/home/u/proj/.lassi.json': JSON.stringify({
        jira: {
          templates: {
            bug: {
              type: 'Bug',
              fields: { team: 'Platform', points: 3 },
              descriptionFile: 'templates/bug.md',
            },
            abs: { descriptionFile: '/home/u/proj/docs/abs.md' },
          },
        },
      }),
    });
    const loaded = await loadConfig({ env: {}, cwd, homedir, fs });
    expect(loaded.config.jira.templates).toEqual({
      home: { fields: {}, descriptionFile: '/home/u/tpl/home.md' },
      bug: {
        type: 'Bug',
        fields: { team: 'Platform', points: 3 },
        descriptionFile: '/home/u/proj/templates/bug.md',
      },
      abs: { fields: {}, descriptionFile: '/home/u/proj/docs/abs.md' },
    });
    expect(loaded.sources['jira.templates.bug.type']).toEqual({
      source: 'workspace',
      from: '/home/u/proj/.lassi.json',
    });
  });

  it('keeps a workspace descriptionFile inside its directory and never reads a credential file', async () => {
    for (const file of ['../secret.md', '/etc/passwd', '~/.lassi/tokens/jira.txt']) {
      const fs = memFs({
        '/home/u/proj/.lassi.json': JSON.stringify({
          jira: { templates: { bug: { descriptionFile: file } } },
        }),
      });
      await expect(loadConfig({ env: {}, cwd, homedir, fs })).rejects.toSatisfy(
        (e: unknown) =>
          isLassiError(e) && e.code === 'usage' && e.message.includes('inside /home/u/proj')
      );
    }
    const token = memFs({
      '/home/u/.lassi.json': JSON.stringify({
        jira: {
          tokenFile: '~/.lassi/tokens/jira.txt',
          templates: { bug: { descriptionFile: '~/.lassi/tokens/jira.txt' } },
        },
      }),
    });
    await expect(loadConfig({ env: {}, cwd, homedir, fs: token })).rejects.toSatisfy(
      (e: unknown) =>
        isLassiError(e) && e.code === 'usage' && e.message.includes('is a credential file')
    );
    const envToken = memFs({
      '/home/u/.lassi.json': JSON.stringify({
        jira: { templates: { bug: { descriptionFile: '/t/token.txt' } } },
      }),
    });
    await expect(
      loadConfig({ env: { LASSI_JIRA_TOKEN_FILE: '/t/token.txt' }, cwd, homedir, fs: envToken })
    ).rejects.toSatisfy((e: unknown) => isLassiError(e) && e.message.includes('credential'));
    // A relative tokenFile is read from the cwd, so it is compared as such.
    const relativeToken = memFs({
      '/home/u/.lassi.json': JSON.stringify({
        jira: {
          tokenFile: 'sub/token.txt',
          templates: { bug: { descriptionFile: 'sub/token.txt' } },
        },
      }),
    });
    await expect(
      loadConfig({ env: {}, cwd: homedir, homedir, fs: relativeToken })
    ).rejects.toSatisfy((e: unknown) => isLassiError(e) && e.message.includes('credential'));
  });

  it('lets a workspace template name only a markdown file, never a dotfile or .git', async () => {
    for (const file of ['.env', '.git/config', 'templates/notes.txt', 'templates']) {
      const fs = memFs({
        '/home/u/proj/.lassi.json': JSON.stringify({
          jira: { templates: { bug: { descriptionFile: file } } },
        }),
        '/home/u/proj/.env': 'JIRA_TOKEN=secret',
        '/home/u/proj/.git/config': '[remote "origin"]',
        '/home/u/proj/templates/notes.txt': 'plain',
      });
      await expect(loadConfig({ env: {}, cwd, homedir, fs })).rejects.toSatisfy(
        (e: unknown) =>
          isLassiError(e) && e.code === 'usage' && e.message.includes('may only name a')
      );
    }
    const dotGitMarkdown = memFs({
      '/home/u/proj/.lassi.json': JSON.stringify({
        jira: { templates: { bug: { descriptionFile: '.git/notes.md' } } },
      }),
      '/home/u/proj/.git/notes.md': '## Steps',
    });
    await expect(loadConfig({ env: {}, cwd, homedir, fs: dotGitMarkdown })).rejects.toSatisfy(
      (e: unknown) => isLassiError(e) && e.message.includes('under .git')
    );
    // The global file is the user's own, so it keeps naming whatever it likes.
    const global = memFs({
      '/home/u/.lassi.json': JSON.stringify({
        jira: { templates: { bug: { descriptionFile: 'notes.txt' } } },
      }),
      '/home/u/notes.txt': 'plain',
    });
    const loaded = await loadConfig({ env: {}, cwd, homedir, fs: global });
    expect(loaded.config.jira.templates['bug']?.descriptionFile).toBe('/home/u/notes.txt');
  });

  it('applies the workspace file rules to the symlink target, not just the name', async () => {
    // A repository can commit a symlink: the link is contained, ends in `.md` and is not under
    // `.git`, so every rule passed on the name while `templates` would print what it points at.
    const base = memFs({
      '/home/u/proj/.lassi.json': JSON.stringify({
        jira: { templates: { bug: { descriptionFile: 'templates/bug.md' } } },
      }),
      '/home/u/proj/templates/bug.md': 'a symlink in real life',
      '/home/u/proj/.env': 'JIRA_TOKEN=secret',
      '/home/u/proj/.git/config': '[remote "origin"]',
    });
    const linkTo = (target: string) => ({
      ...base,
      realpath: async (path: string) =>
        path === '/home/u/proj/templates/bug.md' ? target : base.realpath(path),
    });
    await expect(
      loadConfig({ env: {}, cwd, homedir, fs: linkTo('/home/u/proj/.env') })
    ).rejects.toSatisfy(
      (e: unknown) => isLassiError(e) && e.message.includes('may only name a .md or .markdown file')
    );
    await expect(
      loadConfig({ env: {}, cwd, homedir, fs: linkTo('/home/u/proj/.git/notes.md') })
    ).rejects.toSatisfy((e: unknown) => isLassiError(e) && e.message.includes('under .git'));
  });

  it('accepts a template file that does not exist yet under a symlinked workspace root', async () => {
    const base = memFs({
      '/tmp/ws/.lassi.json': JSON.stringify({
        jira: { templates: { bug: { descriptionFile: 'templates/bug.md' } } },
      }),
    });
    // What macOS does with /tmp: the root resolves elsewhere, and the template file is not written
    // yet, so only the existing part of the path can be resolved.
    const symlinked = {
      ...base,
      realpath: async (path: string) =>
        (await base.realpath(path)).replace(/^\/tmp\/ws/, '/private/tmp/ws'),
    };
    const loaded = await loadConfig({ env: {}, cwd: '/tmp/ws', homedir, fs: symlinked });
    expect(loaded.config.jira.templates['bug']?.descriptionFile).toBe('/tmp/ws/templates/bug.md');
  });

  it('follows symlinks before deciding that a template file is inside the workspace', async () => {
    const base = memFs({
      '/home/u/proj/.lassi.json': JSON.stringify({
        jira: { templates: { bug: { descriptionFile: 'templates/link.md' } } },
      }),
      '/home/u/proj/templates/link.md': 'a symlink in real life',
      '/home/u/proj/templates/real.md': '## Steps',
    });
    const linked = {
      ...base,
      realpath: async (path: string) =>
        path === '/home/u/proj/templates/link.md' ? '/home/u/.lassi/tokens/jira.txt' : path,
    };
    await expect(loadConfig({ env: {}, cwd, homedir, fs: linked })).rejects.toSatisfy(
      (e: unknown) => isLassiError(e) && e.message.includes('inside /home/u/proj')
    );
    const inside = memFs({
      '/home/u/proj/.lassi.json': JSON.stringify({
        jira: { templates: { bug: { descriptionFile: 'templates/real.md' } } },
      }),
      '/home/u/proj/templates/real.md': '## Steps',
    });
    const loaded = await loadConfig({ env: {}, cwd, homedir, fs: inside });
    expect(loaded.config.jira.templates['bug']?.descriptionFile).toBe(
      '/home/u/proj/templates/real.md'
    );
    // The symlink decided the checks, but the path the user configured is what gets stored and shown.
    const shown = {
      ...inside,
      realpath: async (path: string) =>
        path === '/home/u/proj/templates/real.md' ? '/home/u/proj/templates/target.md' : path,
    };
    const kept = await loadConfig({ env: {}, cwd, homedir, fs: shown });
    expect(kept.config.jira.templates['bug']?.descriptionFile).toBe(
      '/home/u/proj/templates/real.md'
    );
  });

  it('rejects both description forms, a dotted name and an unknown key as usage errors', async () => {
    const cases: Array<[unknown, string]> = [
      [{ bug: { description: 'x', descriptionFile: 'y.md' } }, 'not both'],
      [{ 'bug x': { type: 'Bug' } }, 'template names'],
      // A dot nests in the dotted-path merge, so it surfaces as an unknown key under `bug`.
      [{ 'bug.x': { type: 'Bug' } }, 'Unrecognized key: "x"'],
      [{ bug: { typo: 'Bug' } }, 'typo'],
    ];
    for (const [templates, needle] of cases) {
      const fs = memFs({ '/home/u/.lassi.json': JSON.stringify({ jira: { templates } }) });
      await expect(loadConfig({ env: {}, cwd, homedir, fs })).rejects.toSatisfy(
        (e: unknown) => isLassiError(e) && e.code === 'usage' && e.message.includes(needle)
      );
    }
  });
});

describe('resolvePath / displayPath', () => {
  it('keeps the flavour of an absolute argument and follows the cwd otherwise', async () => {
    const { displayPath, resolvePath } = await import('../fs/paths.js');
    expect(resolvePath('/home/u/proj', 'work/x.md')).toBe('/home/u/proj/work/x.md');
    expect(resolvePath('/home/u/proj', '/tmp/x')).toBe('/tmp/x');
    expect(resolvePath('/home/u/proj', '//tmp/archive')).toBe('/tmp/archive');
    expect(resolvePath('/home/u/proj', '//tmp/archive/a\\b.md')).toBe('/tmp/archive/a\\b.md');
    expect(resolvePath('/home/u/proj', '\\\\files.example.internal\\users\\u')).toBe(
      '\\\\files.example.internal\\users\\u'
    );
    expect(resolvePath('/home/u/proj', 'C:\\Temp\\x')).toBe('C:\\Temp\\x');
    expect(resolvePath('C:\\work', 'sub\\y.md')).toBe('C:\\work\\sub\\y.md');
    expect(resolvePath('D:\\work', '//files.example.internal/users/u/archive')).toBe(
      '\\\\files.example.internal\\users\\u\\archive'
    );
    expect(displayPath('/home/u/proj', '/home/u/proj/.lassi/cache/x.json')).toBe(
      '.lassi/cache/x.json'
    );
    expect(displayPath('/home/u/proj', 'C:\\Temp\\x')).toBe('C:\\Temp\\x');
  });
});
