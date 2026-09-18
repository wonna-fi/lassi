export type NetworkErrorKind =
  | 'tls'
  | 'timeout'
  | 'aborted'
  | 'dns'
  | 'refused'
  | 'reset'
  | 'unknown';

const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'CERT_UNTRUSTED',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'EPROTO',
]);

function codeOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function nameOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const name = (err as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

/**
 * Classifies a `fetch` rejection by walking the `cause` chain (undici wraps the socket error one or
 * two levels down). Structural by design: `instanceof` fails across realms and wrapped errors.
 */
export function classifyNetworkError(err: unknown): { kind: NetworkErrorKind; code?: string } {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth++) {
    const name = nameOf(current);
    // The deadline aborts with 'TimeoutError' and a caller's own signal with 'AbortError'
    // (http/deadline.ts states the convention). Reporting a cancellation as a timeout sent a
    // library consumer off to check their VPN for something they asked for themselves.
    if (name === 'TimeoutError') return { kind: 'timeout' };
    if (name === 'AbortError') return { kind: 'aborted' };
    const code = codeOf(current);
    if (code !== undefined) {
      if (TLS_CODES.has(code)) return { kind: 'tls', code };
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { kind: 'dns', code };
      if (code === 'ECONNREFUSED') return { kind: 'refused', code };
      if (code === 'ECONNRESET' || code === 'EPIPE') return { kind: 'reset', code };
      if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT')
        return { kind: 'timeout', code };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return { kind: 'unknown' };
}
