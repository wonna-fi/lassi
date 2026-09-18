import type { Mention } from '@wonna/lassi-core';
import type { Root } from 'mdast';
import { isTag } from 'domhandler';
import type { ChildNode } from 'domhandler';
import { visit } from 'unist-util-visit';
import { parseStorage } from './xml/parse.js';

/** Resolves Confluence user keys to usernames and back; filled by the CLI from the REST API. */
export interface UserDirectory {
  usernameForKey(key: string): string | undefined;
  keyForUsername(username: string): string | undefined;
}

export function userDirectory(
  entries: Iterable<{ userKey: string; username: string }>
): UserDirectory {
  const byKey = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const { userKey, username } of entries) {
    byKey.set(userKey, username);
    byName.set(username, userKey);
  }
  return {
    usernameForKey: (key) => byKey.get(key),
    keyForUsername: (username) => byName.get(username),
  };
}

export const EMPTY_DIRECTORY: UserDirectory = userDirectory([]);

function walk(nodes: ChildNode[], fn: (el: import('domhandler').Element) => void): void {
  for (const node of nodes) {
    if (!isTag(node)) continue;
    fn(node);
    walk(node.children, fn);
  }
}

/** `ri:user/@ri:userkey` values, unique, in document order; the CLI resolves them before reading. */
export function collectUserKeys(storage: string): string[] {
  const keys = new Set<string>();
  walk(parseStorage(storage).doc.children, (el) => {
    const key = el.name === 'ri:user' ? el.attribs['ri:userkey'] : undefined;
    if (key) keys.add(key);
  });
  return [...keys];
}

/** `ri:user/@ri:username` values, for instances that store mentions by name. */
export function collectUsernames(storage: string): string[] {
  const names = new Set<string>();
  walk(parseStorage(storage).doc.children, (el) => {
    const name = el.name === 'ri:user' ? el.attribs['ri:username'] : undefined;
    if (name) names.add(name);
  });
  return [...names];
}

/** Mentions in a markdown tree: usernames to validate, plus untouched `@{userkey:…}` placeholders. */
export function collectMentions(tree: Root): { usernames: string[]; userKeys: string[] } {
  const usernames = new Set<string>();
  const userKeys = new Set<string>();
  visit(tree, 'mention', (node) => {
    const mention = node as Mention;
    if (mention.username) usernames.add(mention.username);
    else if (mention.userKey) userKeys.add(mention.userKey);
  });
  return { usernames: [...usernames], userKeys: [...userKeys] };
}

/** Later directories fill the gaps of earlier ones (the page's users plus newly validated ones). */
export function mergeUserDirectories(...dirs: UserDirectory[]): UserDirectory {
  return {
    usernameForKey(key) {
      for (const d of dirs) {
        const name = d.usernameForKey(key);
        if (name !== undefined) return name;
      }
      return undefined;
    },
    keyForUsername(username) {
      for (const d of dirs) {
        const key = d.keyForUsername(username);
        if (key !== undefined) return key;
      }
      return undefined;
    },
  };
}
