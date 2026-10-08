// Calendar days as whole numbers (days since 1970-01-01), so date arithmetic ignores time zones and DST.

export const MS_PER_DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Days since the epoch for a "YYYY-MM-DD" string. */
export function toDay(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / MS_PER_DAY;
}

/** The "YYYY-MM-DD" string of a day. */
export function fromDay(day: number): string {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Today in the local time zone. */
export function todayDay(): number {
  const now = new Date();
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY;
}

/** "14 Oct"; with `weekday`, "Tue 14 Oct". */
export function formatDay(day: number, { weekday = false } = {}): string {
  const date = new Date(day * MS_PER_DAY);
  const text = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  return weekday ? `${WEEKDAYS[date.getUTCDay()]} ${text}` : text;
}

/** Whether a day falls on a Saturday or Sunday. */
export function isWeekend(day: number): boolean {
  const weekday = new Date(day * MS_PER_DAY).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/** "+3 days", "−1 day", "no change". */
export function formatDelta(days: number): string {
  if (days === 0) return "no change";
  const n = Math.abs(days);
  return `${days > 0 ? "+" : "−"}${n} day${n === 1 ? "" : "s"}`;
}
