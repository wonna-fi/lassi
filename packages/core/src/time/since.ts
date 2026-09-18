import { LassiError } from '../errors/index.js';
import { parseAtlassianDate } from './atlassian-date.js';

export type SinceUnit = 'm' | 'h' | 'd' | 'w';

export interface Since {
  /** The exact cut every client-side filter uses. */
  instant: Date;
  /** What the user wrote, for messages. */
  text: string;
  /** Present for `1d`-style input, so a product can hand Jira its own relative literal. */
  relative?: { amount: number; unit: SinceUnit };
}

export const SINCE_FORMS =
  '30m, 2h, 1d, 1w (a leading "-" is allowed), YYYY-MM-DD (local midnight), or an ISO 8601 date-time such as 2026-09-06T10:00+03:00';

const UNIT_MS: Record<SinceUnit, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** `--since` on any command: a duration back from `now`, a day, or an exact date-time. */
export function parseSince(text: string, now: Date): Since {
  const input = text.trim();
  const usage = (): LassiError =>
    new LassiError(
      'usage',
      `--since: "${text}" is not a duration or a date; accepted: ${SINCE_FORMS}`
    );
  const relative = /^-?(\d+)([mhdw])$/.exec(input);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2] as SinceUnit;
    if (amount <= 0) throw usage();
    const instant = new Date(now.getTime() - amount * UNIT_MS[unit]);
    if (!Number.isFinite(instant.getTime())) throw usage();
    return { instant, text, relative: { amount, unit } };
  }
  // A `--since` after `now` describes a window that has not happened. sinceToJql clamps it to -1m
  // and the client-side cut then rejects everything, so a transposed date read as "nothing
  // happened" rather than as the mistake it is.
  const future = (instant: Date): LassiError =>
    new LassiError('usage', `--since: "${text}" is in the future`, {
      hint: `pass a past date or a duration such as 1d; the window would start at ${instant.toISOString()}`,
    });
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (day) {
    // A day means the user's day, not UTC's: `new Date('YYYY-MM-DD')` would be midnight UTC.
    const [year, month, date] = [Number(day[1]), Number(day[2]), Number(day[3])];
    const instant = new Date(year, month - 1, date);
    // The constructor reads a year below 100 as 19xx; setFullYear does not.
    instant.setFullYear(year, month - 1, date);
    if (
      instant.getFullYear() !== year ||
      instant.getMonth() !== month - 1 ||
      instant.getDate() !== date
    )
      throw usage();
    // Local midnight, so today is always in the past.
    if (instant.getTime() > now.getTime()) throw future(instant);
    return { instant, text };
  }
  const stamp = /^(\d{4})-(\d{2})-(\d{2})T/.exec(input);
  if (!stamp) throw usage();
  // `Date.parse` rolls February 29 of a common year into March; the calendar day is checked first.
  const [year, month, date] = [Number(stamp[1]), Number(stamp[2]), Number(stamp[3])];
  const calendar = new Date(Date.UTC(year, month - 1, date));
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== date) throw usage();
  const instant = parseAtlassianDate(input);
  if (!instant) throw usage();
  if (instant.getTime() > now.getTime()) throw future(instant);
  return { instant, text };
}
