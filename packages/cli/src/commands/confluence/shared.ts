import type { Command } from 'commander';
import {
  collectUserKeys,
  createConfluenceClient,
  createStorageConverter,
  type ConfluenceClient,
  type ConfluencePage,
  type StorageConverter,
  type UserDirectory,
} from '@wonna/lassi-confluence';
import type { Context } from '../../context.js';

const clients = new WeakMap<Context, Promise<ConfluenceClient>>();

/** One Confluence client per command run, built lazily on the context's HTTP client. */
export function confluenceClient(ctx: Context): Promise<ConfluenceClient> {
  let pending = clients.get(ctx);
  if (!pending) {
    pending = ctx.product('confluence').then((p) =>
      createConfluenceClient({
        baseUrl: p.baseUrl,
        http: p.http,
        ...(ctx.config.confluence.downloadUrlSuffix === undefined
          ? {}
          : { downloadUrlSuffix: ctx.config.confluence.downloadUrlSuffix }),
      })
    );
    clients.set(ctx, pending);
  }
  return pending;
}

export function group(parent: Command, name: string, description: string): Command {
  return parent.command(name).description(description);
}

/** `<ID|"SPACE:Title"|URL>` through the client, with `confluence.defaultSpace` for bare titles. */
export function resolvePage(
  ctx: Context,
  client: ConfluenceClient,
  ref: string
): Promise<ConfluencePage> {
  return client.resolvePageRef(ref, ctx.config.confluence.defaultSpace);
}

/**
 * A converter whose user directory covers every `ri:userkey` in the given storage bodies; reader
 * warnings go to stderr so an agent sees why a region became a raw fence without `--verbose`.
 */
export async function converterFor(
  ctx: Context,
  client: ConfluenceClient,
  storages: string[],
  extra: { users?: UserDirectory } = {}
): Promise<StorageConverter> {
  const users =
    extra.users ?? (await client.resolveUserKeys(storages.flatMap((s) => collectUserKeys(s))));
  return createStorageConverter({
    users,
    onWarning: (w) => ctx.logger.warn(`raw fence: ${w.name} at ${w.path}`),
  });
}
