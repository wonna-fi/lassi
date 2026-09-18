export type Params = Array<[string, string]>;

const KEY = /^[A-Za-z][\w:.-]*$/;

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * `key=value` words separated by spaces, the one grammar shared by code-block meta, image titles,
 * `{jira:KEY params}` and `<!-- toc params -->`. Values with whitespace, quotes or `=` are quoted.
 */
export function encodeParams(pairs: Params): string {
  return pairs
    .map(
      ([key, value]) => `${key}=${/[\s"=\\]/.test(value) || value === '' ? quote(value) : value}`
    )
    .join(' ');
}

/** Inverse of `encodeParams`; `undefined` when the text does not follow the grammar. */
export function decodeParams(text: string): Params | undefined {
  const out: Params = [];
  let i = 0;
  const skipSpace = (): void => {
    while (i < text.length && /\s/.test(text[i] as string)) i++;
  };
  skipSpace();
  while (i < text.length) {
    const eq = text.indexOf('=', i);
    if (eq === -1) return undefined;
    const key = text.slice(i, eq);
    if (!KEY.test(key)) return undefined;
    i = eq + 1;
    let value = '';
    if (text[i] === '"') {
      i++;
      let closed = false;
      while (i < text.length) {
        const ch = text[i] as string;
        if (ch === '\\' && i + 1 < text.length) {
          value += text[i + 1];
          i += 2;
          continue;
        }
        if (ch === '"') {
          closed = true;
          i++;
          break;
        }
        value += ch;
        i++;
      }
      if (!closed) return undefined;
      if (i < text.length && !/\s/.test(text[i] as string)) return undefined;
    } else {
      const start = i;
      while (i < text.length && !/[\s"]/.test(text[i] as string)) i++;
      value = text.slice(start, i);
      if (value === '' || text[i] === '"') return undefined;
    }
    out.push([key, value]);
    skipSpace();
  }
  return out;
}
