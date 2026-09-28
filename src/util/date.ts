/** Timezone-aware day/period helpers — all buckets computed in the profile timezone (§37.4). */

export function localDayIso(d: Date | string = new Date(), tz = "Africa/Lagos"): string {
  const date = typeof d === "string" ? new Date(d) : d;
  // en-CA yields YYYY-MM-DD; guard against invalid timezone values from bad data
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }
}

export type Period = "day" | "week" | "month" | "year";

/** Inclusive [from, to] ISO range for a period ending now, plus the previous equivalent window. */
export function periodRange(period: Period, tz: string, now = new Date()): { from: string; to: string; prevFrom: string; prevTo: string } {
  const fmt = (d: Date) => d.toISOString();
  let start: Date;
  let prevStart: Date;
  const end = new Date(now.getTime() + 86_400_000);
  switch (period) {
    case "day": {
      start = shiftLocalDay(now, tz, 0);
      prevStart = shiftLocalDay(now, tz, -1);
      end.setTime(start.getTime() + 86_400_000);
      return { from: fmt(start), to: fmt(end), prevFrom: fmt(prevStart), prevTo: fmt(start) };
    }
    case "week": {
      // week starts Monday in profile tz
      const s = shiftLocalDay(now, tz, 0);
      const dow = (new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(s) === "Sun" ? 7 : new Date(s).getUTCDay());
      const back = (dow + 6) % 7;
      start = new Date(s.getTime() - back * 86_400_000);
      prevStart = new Date(start.getTime() - 7 * 86_400_000);
      end.setTime(start.getTime() + 7 * 86_400_000);
      return { from: fmt(start), to: fmt(end), prevFrom: fmt(prevStart), prevTo: fmt(start) };
    }
    case "month": {
      start = shiftLocalDay(now, tz, 0);
      const [y, m] = localDayIso(start, tz).split("-").map(Number);
      start = new Date(Date.UTC(y, m - 1, 1));
      prevStart = new Date(Date.UTC(y, m - 2, 1));
      end.setTime(Date.UTC(y, m, 1));
      return { from: fmt(start), to: fmt(end), prevFrom: fmt(prevStart), prevTo: fmt(start) };
    }
    case "year": {
      const [y] = localDayIso(now, tz).split("-").map(Number);
      start = new Date(Date.UTC(y, 0, 1));
      prevStart = new Date(Date.UTC(y - 1, 0, 1));
      end.setTime(Date.UTC(y + 1, 0, 1));
      return { from: fmt(start), to: fmt(end), prevFrom: fmt(prevStart), prevTo: fmt(start) };
    }
  }
}

/** Shift a day in a timezone: returns UTC instant of local midnight of day+delta. */
export function shiftLocalDay(now: Date, tz: string, delta: number): Date {
  const day = localDayIso(now, tz);
  const [y, m, d] = day.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1, d + delta));
  return target;
}

/** Bucket key for an ISO instant: day/week/month in tz. */
export function bucketKey(iso: string, bucket: Period, tz: string): string {
  const day = localDayIso(iso, tz); // YYYY-MM-DD
  const [y, m, d] = day.split("-").map(Number);
  if (bucket === "day") return day;
  if (bucket === "month") return `${y}-${m.toString().padStart(2, "0")}`;
  if (bucket === "year") return String(y);
  // week (ISO week, Monday start)
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dow);
  return date.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}
