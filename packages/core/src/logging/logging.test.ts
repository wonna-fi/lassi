import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';
import { createRedactor } from './redact.js';

describe('createLogger', () => {
  it('filters by level and formats plain lines', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'warn', write: (l) => lines.push(l) });
    log.error('e');
    log.warn('w');
    log.info('i');
    log.debug('d');
    expect(lines).toEqual(['error: e\n', 'warn: w\n']);
  });

  it('silent writes nothing; debug writes everything', () => {
    const lines: string[] = [];
    createLogger({ level: 'silent', write: (l) => lines.push(l) }).error('e');
    expect(lines).toEqual([]);
    createLogger({ level: 'debug', write: (l) => lines.push(l) }).debug('d');
    expect(lines).toEqual(['debug: d\n']);
  });

  it('passes every line through the redactor', () => {
    const lines: string[] = [];
    const log = createLogger({
      level: 'debug',
      write: (l) => lines.push(l),
      redact: createRedactor(['s3cr3t-token']),
    });
    log.debug('Authorization: Bearer s3cr3t-token');
    expect(lines).toEqual(['debug: Authorization: Bearer ***\n']);
  });
});

describe('createRedactor', () => {
  it('replaces all occurrences of every secret, longest first', () => {
    const redact = createRedactor(['abcd', 'abcdefgh']);
    expect(redact('x abcdefgh y abcd z')).toBe('x *** y *** z');
  });

  it('ignores secrets shorter than four characters and empty lists', () => {
    expect(createRedactor(['x', ''])('x marks the spot')).toBe('x marks the spot');
    expect(createRedactor([])('unchanged')).toBe('unchanged');
  });
});
