import { describe, expect, it } from 'vitest';
import { formatLocal, parseAtlassianDate } from './atlassian-date.js';
import { parseSince } from './since.js';

const NOW = new Date('2026-09-04T10:00:00.000Z');

describe('parseSince', () => {
  it('subtracts a duration from now and keeps the relative form', () => {
    expect(parseSince('1d', NOW)).toEqual({
      instant: new Date('2026-09-03T10:00:00.000Z'),
      text: '1d',
      relative: { amount: 1, unit: 'd' },
    });
    expect(parseSince('-2h', NOW).instant.toISOString()).toBe('2026-09-04T08:00:00.000Z');
    expect(parseSince('30m', NOW).instant.toISOString()).toBe('2026-09-04T09:30:00.000Z');
    expect(parseSince('1w', NOW).instant.toISOString()).toBe('2026-08-28T10:00:00.000Z');
  });

  it('reads a day as local midnight, not UTC midnight', () => {
    const since = parseSince('2026-09-01', NOW);
    expect(since.relative).toBeUndefined();
    expect([
      since.instant.getFullYear(),
      since.instant.getMonth(),
      since.instant.getDate(),
    ]).toEqual([2026, 8, 1]);
    expect([since.instant.getHours(), since.instant.getMinutes()]).toEqual([0, 0]);
    expect(parseSince('0099-01-01', NOW).instant.getFullYear()).toBe(99);
  });

  it('accepts an exact date-time with any offset spelling', () => {
    expect(parseSince('2026-09-03T14:02:10.000+0300', NOW).instant.toISOString()).toBe(
      '2026-09-03T11:02:10.000Z'
    );
    expect(parseSince('2026-09-03T11:02:10Z', NOW).instant.toISOString()).toBe(
      '2026-09-03T11:02:10.000Z'
    );
  });

  it('rejects everything else as a usage error that lists the forms', () => {
    for (const bad of [
      '1x',
      '0d',
      'yesterday',
      '2026-13-01',
      '2026-02-30',
      '2026-09-03Tnope',
      '999999999999999999d',
      '2026-02-29T10:00+03:00',
      '2025-04-31T00:00Z',
      '',
    ]) {
      expect(() => parseSince(bad, NOW)).toThrow(/not a duration or a date; accepted: 30m, 2h/);
    }
  });
});

describe('a --since in the future', () => {
  it('is a usage error for a day and for a date-time', () => {
    // It used to be accepted: sinceToJql clamps it to -1m, the client-side cut then rejects
    // everything, and `digest` answered a transposed date with "nothing happened".
    for (const input of ['2026-09-05', '2026-09-04T11:00:00.000Z', '2027-01-01']) {
      expect(() => parseSince(input, NOW)).toThrow(/is in the future/);
    }
  });

  it('still accepts today, which starts at local midnight', () => {
    const today = new Date(NOW);
    const stamp = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(parseSince(stamp, NOW).instant.getTime()).toBeLessThanOrEqual(NOW.getTime());
  });
});

describe('parseAtlassianDate / formatLocal', () => {
  it('treats +0300 and +03:00 alike and returns undefined for garbage', () => {
    expect(parseAtlassianDate('2026-09-03T14:02:10.000+0300')?.toISOString()).toBe(
      '2026-09-03T11:02:10.000Z'
    );
    expect(parseAtlassianDate('2026-09-03T14:02:10.000+03:00')?.toISOString()).toBe(
      '2026-09-03T11:02:10.000Z'
    );
    expect(parseAtlassianDate('never')).toBeUndefined();
  });

  it('formats local wall-clock time as YYYY-MM-DD HH:mm, with the year padded', () => {
    expect(formatLocal(new Date(2026, 8, 3, 9, 5))).toBe('2026-09-03 09:05');
    const early = new Date(2026, 0, 1);
    early.setFullYear(99, 0, 1);
    expect(formatLocal(early)).toBe('0099-01-01 00:00');
  });
});
