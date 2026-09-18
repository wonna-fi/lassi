import { isLassiError } from '@wonna/lassi-core';
import { createEmbeddingsClient, type EmbeddingsClient } from '@wonna/lassi-search';
import type { Context } from '../../context.js';

const clients = new WeakMap<Context, Promise<EmbeddingsClient>>();

export function embeddingsClient(ctx: Context): Promise<EmbeddingsClient> {
  let pending = clients.get(ctx);
  if (!pending) {
    pending = ctx.embeddings().then((cfg) => {
      const client = createEmbeddingsClient({
        http: cfg.http,
        model: cfg.model,
        batchSize: cfg.batchSize,
        logger: ctx.logger,
        ...(cfg.apiVersion === undefined ? {} : { apiVersion: cfg.apiVersion }),
        ...(cfg.dimensions === undefined ? {} : { dimensions: cfg.dimensions }),
      });
      if (cfg.auth !== 'azure-ad') return client;
      // A token Entra issued but the endpoint refused is a tenant, scope or role problem, not a
      // key problem; the product-token hint ("check the token") would send the user the wrong way.
      return {
        model: client.model,
        async embed(texts) {
          try {
            return await client.embed(texts);
          } catch (err) {
            if (isLassiError(err) && err.code === 'auth' && err.hint === undefined) {
              err.hint =
                'Entra ID issued a token but the endpoint refused it: check that `az login --tenant <id>` matches the resource tenant, that embeddings.azureScope is the endpoint audience, and that your account holds the Cognitive Services OpenAI User role';
            }
            throw err;
          }
        },
      };
    });
    clients.set(ctx, pending);
  }
  return pending;
}

export const DEFAULT_INDEX_NAME = 'default';
