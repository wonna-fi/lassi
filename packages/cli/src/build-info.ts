import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface BuildInfo {
  version: string;
  sha: string;
  builtAt?: string;
  distribution?: boolean;
}

/** Reads `package.json` and the build-generated `build-info.json` next to it (works from src and dist). */
export function readBuildInfo(): BuildInfo {
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')
  ) as {
    version: string;
  };
  try {
    const info = JSON.parse(
      readFileSync(fileURLToPath(new URL('../build-info.json', import.meta.url)), 'utf8')
    ) as { version?: string; sha?: string; builtAt?: string; distribution?: boolean };
    const out: BuildInfo = { version: pkg.version, sha: info.sha ?? 'unbuilt' };
    if (info.distribution) out.distribution = true;
    if (info.builtAt) out.builtAt = info.builtAt;
    return out;
  } catch {
    return { version: pkg.version, sha: 'unbuilt' };
  }
}

export function formatVersion(info: BuildInfo): string {
  return `lassi ${info.version} (${info.sha})`;
}
