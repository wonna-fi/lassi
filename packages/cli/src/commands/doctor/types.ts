import type { LassiError, Product } from '@wonna/lassi-core';
import type { Context, ProductClient } from '../../context.js';

export type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
}

export interface ProductState {
  configured: boolean;
  client?: ProductClient;
  error?: LassiError;
}

/** Memoised state shared by the checks so credentials are resolved once. */
export interface DoctorShared {
  products: Map<Product, Promise<ProductState>>;
  versions: Partial<Record<Product, string>>;
  /** Products whose connectivity probe failed; later network checks skip instead of retrying. */
  unreachable: Set<Product>;
}

export type Check = (ctx: Context, shared: DoctorShared) => Promise<CheckResult[]>;

export async function productState(
  ctx: Context,
  shared: DoctorShared,
  product: Product
): Promise<ProductState> {
  let pending = shared.products.get(product);
  if (!pending) {
    pending = (async (): Promise<ProductState> => {
      const section = ctx.config[product];
      const configured = Boolean(section.url || section.token || section.tokenFile);
      if (!configured) return { configured: false };
      try {
        return { configured: true, client: await ctx.product(product) };
      } catch (err) {
        return { configured: true, error: err as LassiError };
      }
    })();
    shared.products.set(product, pending);
  }
  return pending;
}

export const PRODUCTS: Product[] = ['jira', 'confluence'];

export function label(product: Product): string {
  return product === 'jira' ? 'Jira' : 'Confluence';
}
