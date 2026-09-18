import { pathApi, type LassiConfig } from '@wonna/lassi-core';

export interface LassiDirs {
  root: string;
  work: string;
  cache: string;
  attachments(key: string): string;
  /** User-wide export archive, under storage.exportDir. */
  export(product: 'jira' | 'confluence'): string;
  /** User-wide semantic index, under storage.indexDir. */
  index(name: string): string;
}

/** `./.lassi/work`, `./.lassi/cache`, attachments under `<attachments.dir>/<KEY>/`. */
export function lassiDirs(cwd: string, config: LassiConfig, stateDir = '.lassi'): LassiDirs {
  const api = pathApi(cwd);
  const root = api.resolve(cwd, stateDir);
  const attachmentsRoot = api.resolve(cwd, config.attachments.dir);
  return {
    root,
    work: api.join(root, 'work'),
    cache: api.join(root, 'cache'),
    attachments: (key) => api.join(attachmentsRoot, key),
    export: (product) => pathApi(config.storage.exportDir).join(config.storage.exportDir, product),
    index: (name) => pathApi(config.storage.indexDir).join(config.storage.indexDir, name),
  };
}
