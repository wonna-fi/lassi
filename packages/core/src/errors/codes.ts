/** Error categories; each maps to one exit code. */
export type LassiErrorCode =
  | 'usage'
  | 'auth'
  | 'not_found'
  | 'validation'
  | 'conflict'
  | 'read_only'
  | 'network'
  | 'tls'
  | 'timeout'
  | 'http'
  | 'internal';

export const EXIT_CODES: Readonly<Record<LassiErrorCode, number>> = {
  usage: 2,
  auth: 3,
  not_found: 4,
  validation: 5,
  conflict: 6,
  read_only: 7,
  network: 1,
  tls: 1,
  timeout: 1,
  http: 1,
  internal: 1,
};

export function exitCodeFor(code: LassiErrorCode): number {
  return EXIT_CODES[code];
}
