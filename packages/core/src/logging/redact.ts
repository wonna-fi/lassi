/**
 * Builds a function that replaces every known secret in a string with `***`. Secrets shorter than
 * four characters are ignored so a token like "x" in tests cannot blank out ordinary text.
 */
export function createRedactor(secrets: Iterable<string>): (text: string) => string {
  const values = [...new Set([...secrets].filter((s) => s.length >= 4))].sort(
    (a, b) => b.length - a.length
  );
  if (values.length === 0) return (text) => text;
  return (text) => {
    let out = text;
    for (const secret of values) out = out.split(secret).join('***');
    return out;
  };
}
