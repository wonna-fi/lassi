import { findSecretLookingKeys } from '@wonna/lassi-core';
import type { Check } from '../types.js';

export const workspaceSecretsCheck: Check = async (ctx) => {
  const name = 'Workspace config secrets';
  const path = ctx.loaded.files.workspace;
  if (!path) return [{ name, status: 'SKIP', detail: 'no workspace .lassi.json' }];
  const keys = findSecretLookingKeys(ctx.loaded.rawWorkspace);
  if (keys.length === 0)
    return [{ name, status: 'PASS', detail: `${path} holds no secret-looking keys` }];
  return [
    {
      name,
      status: 'WARN',
      detail: `${path} contains ${keys.join(', ')}`,
      hint: 'move secrets to ~/.lassi.json or LASSI_*_TOKEN; the workspace file is meant to be versioned',
    },
  ];
};
