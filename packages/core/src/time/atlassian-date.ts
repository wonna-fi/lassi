/**
 * Jira and Confluence print `2026-09-03T14:02:10.000+0300`; `Date.parse` is only guaranteed to
 * accept the `+03:00` form, so the offset is normalised first. Unparseable → undefined.
 */
export function parseAtlassianDate(text: string): Date | undefined {
  const normalised = text.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(normalised);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/**
 * `YYYY-MM-DD HH:mm` in the process's local time zone, for display only. It is deliberately *not*
 * what `sinceToJql` emits: Jira reads an unzoned date literal in the user's profile time zone,
 * which need not be the process's, so the JQL side uses a relative literal instead.
 */
export function formatLocal(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
