/**
 * The nightly window dreams run in, in the bb server's local time: from `start` up to `end`, both
 * "HH:MM". An end before the start crosses midnight (22:00–04:00). A dream starts only inside the
 * window; one that is running when the window closes finishes, and nothing starts after it.
 */
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseClock(value: string): number | null {
  const match = TIME.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function isClock(value: string): boolean {
  return parseClock(value) !== null;
}

function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/** Whether `now` is inside the window. An empty window (start equals end) is never open. */
export function inWindow(now: Date, start: string, end: string): boolean {
  const from = parseClock(start);
  const to = parseClock(end);
  if (from === null || to === null || from === to) return false;
  const minute = minuteOfDay(now);
  return from < to ? minute >= from && minute < to : minute >= from || minute < to;
}

/** When the window that `now` is in closes, or null when `now` is outside it. */
export function windowClosesAt(now: Date, start: string, end: string): Date | null {
  if (!inWindow(now, start, end)) return null;
  const to = parseClock(end) as number;
  const closes = new Date(now);
  closes.setHours(Math.floor(to / 60), to % 60, 0, 0);
  if (closes.getTime() <= now.getTime()) closes.setDate(closes.getDate() + 1);
  return closes;
}

/** When the window next opens at or after `now` (now itself when it is open). */
export function windowOpensAt(now: Date, start: string, end: string): Date | null {
  if (inWindow(now, start, end)) return now;
  const from = parseClock(start);
  const to = parseClock(end);
  if (from === null || to === null || from === to) return null;
  const opens = new Date(now);
  opens.setHours(Math.floor(from / 60), from % 60, 0, 0);
  if (opens.getTime() <= now.getTime()) opens.setDate(opens.getDate() + 1);
  return opens;
}
