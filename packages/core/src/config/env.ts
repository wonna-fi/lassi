import type { Layer } from './layers.js';

/** environment overrides. `LASSI_CONFIG` and `LASSI_READ_ONLY` are runtime inputs, not leaves. */
export const ENV_MAP: Readonly<Record<string, string>> = {
  LASSI_JIRA_URL: 'jira.url',
  LASSI_JIRA_TOKEN: 'jira.token',
  LASSI_JIRA_TOKEN_FILE: 'jira.tokenFile',
  LASSI_CONFLUENCE_URL: 'confluence.url',
  LASSI_CONFLUENCE_TOKEN: 'confluence.token',
  LASSI_CONFLUENCE_TOKEN_FILE: 'confluence.tokenFile',
  LASSI_EMBEDDINGS_URL: 'embeddings.url',
  LASSI_EMBEDDINGS_API_KEY: 'embeddings.apiKey',
  LASSI_EMBEDDINGS_API_KEY_FILE: 'embeddings.apiKeyFile',
  LASSI_EXPORT_DIR: 'storage.exportDir',
  LASSI_INDEX_DIR: 'storage.indexDir',
};

/** One layer per set variable so `config show` can name the variable. Empty values are ignored. */
export function envLayers(env: Record<string, string | undefined>): Layer[] {
  const layers: Layer[] = [];
  for (const [name, path] of Object.entries(ENV_MAP)) {
    const value = env[name];
    if (value === undefined || value === '') continue;
    layers.push({ source: 'env', from: name, values: { [path]: value } });
  }
  return layers;
}
