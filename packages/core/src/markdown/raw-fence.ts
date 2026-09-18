import type { Code, Nodes } from 'mdast';
import type { Dialect } from './converter.js';

/** A raw fence is an ordinary fenced code block whose language names the dialect. */
export const RAW_FENCE_LANGS: Readonly<Record<Dialect, string>> = {
  wiki: 'jira',
  storage: 'confluence',
};

export function rawFence(dialect: Dialect, value: string): Code {
  return { type: 'code', lang: RAW_FENCE_LANGS[dialect], value };
}

export function isRawFence(node: Nodes, dialect?: Dialect): node is Code {
  if (node.type !== 'code') return false;
  const lang = (node as Code).lang;
  if (dialect !== undefined) return lang === RAW_FENCE_LANGS[dialect];
  return lang === RAW_FENCE_LANGS.wiki || lang === RAW_FENCE_LANGS.storage;
}
