import { joinFrontmatter } from '@wonna/lassi-core';

export const FLOW_KEYS = ['counts', 'lassi'];

/** One YAML layout for stdout and `--out` files; `comments` become trailing `# name` notes. */
export function renderEntity(
  frontmatter: Record<string, unknown>,
  body: string,
  comments?: Record<string, string>
): string {
  return joinFrontmatter(frontmatter, body, {
    flowKeys: FLOW_KEYS,
    ...(comments ? { comments } : {}),
  });
}
