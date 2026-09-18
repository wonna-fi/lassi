import { describe, expect, it } from 'vitest';
import { LassiError, attachAliases, isLassiError } from './lassi-error.js';
import { classifyHttpFailure, codeForStatus, fromNetworkError } from './classify.js';
import { EXIT_CODES, exitCodeFor } from './codes.js';
import { parseErrorEnvelope } from './envelope.js';
import { pickHint } from './hints.js';
import { classifyNetworkError } from './network.js';
import { humanLine, toErrorJson, toStderr } from './render.js';

describe('exit codes', () => {
  it('maps every category to the table', () => {
    expect(EXIT_CODES).toEqual({
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
    });
    expect(exitCodeFor('validation')).toBe(5);
  });
});

describe('LassiError', () => {
  it('is detected structurally, not by instanceof', () => {
    const fake = { name: 'LassiError', code: 'usage', message: 'x' };
    expect(isLassiError(fake)).toBe(true);
    expect(isLassiError(new Error('x'))).toBe(false);
    expect(isLassiError(null)).toBe(false);
    expect(isLassiError(new LassiError('auth', 'no token'))).toBe(true);
  });

  it('keeps the cause chain', () => {
    const cause = new Error('inner');
    const err = new LassiError('network', 'outer', { cause });
    expect(err.cause).toBe(cause);
  });

  it('attachAliases inverts the alias map onto the verbatim field errors', () => {
    const err = new LassiError('validation', 'Team is required.', {
      errors: { customfield_10001: 'Team is required.', summary: 'too long' },
    });
    attachAliases(err, { team: 'customfield_10001', other: 'customfield_10002' });
    expect(err.errorsByAlias).toEqual({ team: 'Team is required.' });
    expect(err.errors).toEqual({ customfield_10001: 'Team is required.', summary: 'too long' });
  });

  it('attachAliases leaves errorsByAlias undefined when nothing maps', () => {
    const err = new LassiError('validation', 'x', { errors: { summary: 'too long' } });
    attachAliases(err, { team: 'customfield_10001' });
    expect(err.errorsByAlias).toBeUndefined();
  });
});

describe('parseErrorEnvelope', () => {
  it('passes the Jira envelope through verbatim', () => {
    expect(
      parseErrorEnvelope({
        errorMessages: ['Issue does not exist'],
        errors: { customfield_10001: 'Team is required.' },
      })
    ).toEqual({
      errorMessages: ['Issue does not exist'],
      errors: { customfield_10001: 'Team is required.' },
    });
  });

  it('flattens the Confluence envelope', () => {
    expect(
      parseErrorEnvelope({
        statusCode: 400,
        message: 'Error parsing xhtml: Unexpected close tag </p>',
        reason: 'Bad Request',
        data: {
          authorized: false,
          valid: true,
          errors: [{ message: { key: 'x.y', translation: 'Bad tag' } }],
        },
      })
    ).toEqual({
      message: 'Error parsing xhtml: Unexpected close tag </p>',
      errorMessages: ['Bad tag'],
    });
  });

  it('yields an empty envelope for unknown shapes', () => {
    expect(parseErrorEnvelope('<html>login</html>')).toEqual({});
    expect(parseErrorEnvelope(null)).toEqual({});
    expect(parseErrorEnvelope([1, 2])).toEqual({});
  });

  it('stringifies non-string field errors instead of dropping them', () => {
    expect(parseErrorEnvelope({ errors: { a: { nested: true } } })).toEqual({
      errors: { a: '{"nested":true}' },
    });
  });
});

describe('classifyHttpFailure', () => {
  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [404, 'not_found'],
    [400, 'validation'],
    [422, 'validation'],
    [409, 'conflict'],
    [429, 'http'],
    [500, 'http'],
    [503, 'http'],
  ] as const)('status %i → %s', (status, code) => {
    expect(codeForStatus(status)).toBe(code);
  });

  it('prefers errorMessages, then the first field error, then the status text', () => {
    const base = { method: 'POST', path: '/rest/api/2/issue', product: 'jira' as const };
    expect(
      classifyHttpFailure({
        ...base,
        status: 400,
        json: { errorMessages: ['boom'], errors: { a: 'A' } },
      }).message
    ).toBe('boom');
    expect(
      classifyHttpFailure({ ...base, status: 400, json: { errorMessages: [], errors: { a: 'A' } } })
        .message
    ).toBe('A');
    expect(
      classifyHttpFailure({ ...base, status: 502, statusText: 'Bad Gateway', bodyText: '' }).message
    ).toBe('Bad Gateway');
    expect(classifyHttpFailure({ ...base, status: 502 }).message).toBe('HTTP 502');
  });

  it('records the request as method + path only', () => {
    const err = classifyHttpFailure({
      status: 404,
      method: 'GET',
      path: '/rest/api/2/issue/PROJ-1',
      product: 'jira',
    });
    expect(err.request).toEqual({ method: 'GET', url: '/rest/api/2/issue/PROJ-1' });
    expect(err.context.product).toBe('jira');
    expect(err.http).toBe(404);
  });
});

describe('network errors', () => {
  it('classifies undici cause chains structurally', () => {
    const tls = new TypeError('fetch failed', { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } });
    expect(classifyNetworkError(tls)).toEqual({ kind: 'tls', code: 'SELF_SIGNED_CERT_IN_CHAIN' });
    expect(classifyNetworkError({ name: 'TimeoutError' })).toEqual({ kind: 'timeout' });
    expect(classifyNetworkError(new Error('x', { cause: { code: 'ENOTFOUND' } }))).toEqual({
      kind: 'dns',
      code: 'ENOTFOUND',
    });
    expect(classifyNetworkError(new Error('x', { cause: { code: 'ECONNREFUSED' } }))).toEqual({
      kind: 'refused',
      code: 'ECONNREFUSED',
    });
    expect(classifyNetworkError(new Error('plain'))).toEqual({ kind: 'unknown' });
  });

  it('fromNetworkError picks tls / timeout / network', () => {
    const req = { method: 'GET', url: '/rest/api/2/myself' };
    const tls = fromNetworkError(
      new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } }),
      req
    );
    expect(tls.code).toBe('tls');
    expect(tls.message).toContain('CERT_HAS_EXPIRED');
    const timeout = fromNetworkError({ name: 'TimeoutError' }, req, { timeoutMs: 30000 });
    expect(timeout.code).toBe('timeout');
    expect(timeout.message).toBe('request timed out after 30000 ms');
    expect(fromNetworkError(new Error('weird'), req).code).toBe('network');
  });

  it('tells a caller cancellation apart from a deadline', () => {
    // The deadline aborts with TimeoutError and a caller's own signal with AbortError. Both used to
    // read as "request timed out … check VPN and proxy", for something the caller asked for.
    expect(classifyNetworkError({ name: 'AbortError' })).toEqual({ kind: 'aborted' });
    const cancelled = fromNetworkError({ name: 'AbortError' }, { method: 'GET', url: '/x' });
    expect(cancelled.code).toBe('timeout');
    expect(cancelled.message).toBe('request cancelled');
    expect(cancelled.hint).toContain('cancelled through the signal');
  });
});

describe('pickHint', () => {
  it('missing required field on create → createmeta with the alias flag', () => {
    const err = new LassiError('validation', 'Team is required.', {
      http: 400,
      errors: { customfield_10001: 'Team is required.' },
      context: { product: 'jira', project: 'PROJ', issueType: 'Bug', operation: 'create' },
    });
    attachAliases(err, { team: 'customfield_10001' });
    expect(pickHint(err)).toBe(
      'Add --field team=<value>; run `lassi jira issue createmeta PROJ --type Bug` for allowed values.'
    );
  });

  it('create failure without aliases → createmeta', () => {
    const err = new LassiError('validation', 'x', {
      http: 400,
      errors: { customfield_10002: 'req' },
      context: { product: 'jira', project: 'PROJ', operation: 'create' },
    });
    expect(pickHint(err)).toBe(
      'Run `lassi jira issue createmeta PROJ` to see required fields and allowed values.'
    );
  });

  it('unknown field on update → editmeta', () => {
    const err = new LassiError('validation', 'x', {
      http: 400,
      errors: { customfield_10001: 'cannot be set' },
      context: {
        product: 'jira',
        issueKey: 'PROJ-1',
        operation: 'update',
        aliases: { team: 'customfield_10001' },
      },
    });
    expect(pickHint(err)).toBe(
      "Run `lassi jira issue editmeta PROJ-1` to see editable fields and allowed values; alias 'team' maps to customfield_10001."
    );
  });

  it('invalid allowed value appends the values when cheaply available', () => {
    const err = new LassiError('validation', 'x', {
      http: 400,
      errors: { priority: 'bad' },
      context: {
        product: 'jira',
        issueKey: 'PROJ-1',
        allowedValues: { priority: ['High', 'Low'] },
      },
    });
    expect(pickHint(err)).toContain('Allowed values — priority: High, Low.');
  });

  it('transition with screen fields → transition list', () => {
    const err = new LassiError('validation', 'x', {
      http: 400,
      context: { product: 'jira', issueKey: 'PROJ-1', transition: true },
    });
    expect(pickHint(err)).toBe(
      'Run `lassi jira transition list PROJ-1` to see the required screen fields.'
    );
  });

  it('Confluence version drift → page get into the same file', () => {
    const err = new LassiError('conflict', 'x', {
      context: {
        product: 'confluence',
        pageId: '123456',
        versionFrom: 12,
        versionTo: 13,
        workingFile: 'work/123456.md',
      },
    });
    expect(pickHint(err)).toBe(
      'Page changed on server (v12 → v13); run `lassi confluence page get 123456 --out work/123456.md` and re-apply your edit.'
    );
  });

  it('401 → token file path and doctor', () => {
    const err = new LassiError('auth', 'x', {
      http: 401,
      context: { tokenFile: '/home/u/dev/tokens/jira_token.txt' },
    });
    expect(pickHint(err)).toBe(
      'Check the token in /home/u/dev/tokens/jira_token.txt and run `lassi doctor`.'
    );
  });

  it('TLS → NODE_EXTRA_CA_CERTS', () => {
    expect(pickHint(new LassiError('tls', 'x'))).toContain('NODE_EXTRA_CA_CERTS');
  });

  it('read-only block names the env var', () => {
    expect(
      pickHint(new LassiError('read_only', 'x', { context: { readOnlyVar: 'LASSI_READ_ONLY' } }))
    ).toBe('LASSI_READ_ONLY is set; unset it to allow writes (--dry-run is still allowed).');
  });

  it('returns undefined when no rule applies', () => {
    expect(pickHint(new LassiError('usage', 'bad flag'))).toBeUndefined();
  });
});

describe('rendering', () => {
  it('reproduces byte for byte', () => {
    const err = new LassiError('validation', 'Team is required.', {
      http: 400,
      errors: { customfield_10001: 'Team is required.' },
      errorMessages: [],
      request: { method: 'POST', url: '/rest/api/2/issue' },
      context: { product: 'jira', project: 'PROJ', issueType: 'Bug', operation: 'create' },
    });
    attachAliases(err, { team: 'customfield_10001' });
    err.hint = pickHint(err);
    expect(toStderr(err)).toBe(
      'error: Jira rejected the request (400): Team is required.\n' +
        '{"code":"validation","http":400,"message":"Team is required.","errors":{"customfield_10001":"Team is required."},"errorsByAlias":{"team":"Team is required."},"errorMessages":[],"hint":"Add --field team=<value>; run `lassi jira issue createmeta PROJ --type Bug` for allowed values.","request":{"method":"POST","url":"/rest/api/2/issue"}}\n'
    );
  });

  it('omits absent parts and keeps key order', () => {
    const err = new LassiError('usage', 'unknown alias');
    expect(Object.keys(toErrorJson(err))).toEqual(['code', 'message']);
    expect(humanLine(err)).toBe('error: unknown alias');
    const withHttp = new LassiError('http', 'Bad Gateway', { http: 502 });
    expect(Object.keys(toErrorJson(withHttp))).toEqual(['code', 'http', 'message']);
    expect(humanLine(withHttp)).toBe('error: HTTP 502: Bad Gateway');
  });

  it('applies the redactor to both lines', () => {
    const err = new LassiError('auth', 'token secret-token-value rejected', { http: 401 });
    const out = toStderr(err, (s) => s.split('secret-token-value').join('***'));
    expect(out).not.toContain('secret-token-value');
    expect(out.split('\n').filter(Boolean)).toHaveLength(2);
  });
});
