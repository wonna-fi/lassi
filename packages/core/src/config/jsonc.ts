/**
 * Strips `//` and `/* *\/` comments outside string literals so config files may carry comments
 * (JSONC configuration is supported). String-aware on purpose: every URL contains `//`.
 */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] as string;
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        if (text[j] === '\\') j++;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonComments(text));
}
