export type TokenFileExposure = 'ok' | 'group-readable' | 'world-readable' | 'not-applicable';

/** POSIX mode bits only; Windows ACLs are not inspected. */
export function classifyMode(mode: number, platform: NodeJS.Platform): TokenFileExposure {
  if (platform === 'win32') return 'not-applicable';
  if ((mode & 0o004) !== 0) return 'world-readable';
  if ((mode & 0o040) !== 0) return 'group-readable';
  return 'ok';
}

export async function checkTokenFile(
  path: string,
  stat: (path: string) => Promise<{ mode: number }>,
  platform: NodeJS.Platform
): Promise<TokenFileExposure> {
  const { mode } = await stat(path);
  return classifyMode(mode, platform);
}
