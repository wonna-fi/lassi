/**
 * One line, at most `max` characters including the ellipsis. Used wherever a long value has to fit
 * a table cell or an agent payload; `--json` is the escape hatch for the full text.
 */
export function brief(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  let cut = flat.slice(0, Math.max(0, max - 1));
  // Never end on the first half of a surrogate pair: that byte on its own is not a character.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** `RegExp` metacharacters escaped, so a user-supplied string can be matched literally. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
