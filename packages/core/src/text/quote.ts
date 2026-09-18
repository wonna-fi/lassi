/**
 * A double-quoted string literal for JQL and CQL. Both languages escape `\` and `"` the same way,
 * and both need the backslash escaped first, or a trailing one turns the closing quote into an
 * escaped quote and the literal never ends.
 */
export function quoteLiteral(value: string): string {
  return `"${value.replace(/[\\"]/g, '\\$&')}"`;
}
