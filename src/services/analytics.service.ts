import { all, get, parseJson } from "../core/db";
import { bucketKey, localDayIso, periodRange, type Period } from "../util/date";
import { config } from "../core/config";
import { today as streakToday } from "./streak.service";

const tzOf = (userId: string) => get<{ timezone: string }>("SELECT timezone FROM users WHERE id = ?", userId)?.timezone ?? config.timezone;

type Metric = { value: number; prev: number; delta_pct: number | null; unit?: string };

const delta = (value: number, prev: number): number | null => (prev === 0 ? (value === 0 ? 0 : null) : Number((((value - prev) / prev) * 100).toFixed(1)));
const kpi = (value: number, prev: number, unit?: string): Metric => ({
  value: Number(value.toFixed(unit === "%" ? 1 : 0)),
  prev,
  delta_pct: delta(value, prev),
  ...(unit ? { unit } : {}),
});

function countsFor(userId: string, from: string, to: string) {
  const row = get<any>(
    `SELECT
      (SELECT count(*) FROM applications WHERE user_id = ? AND kind = 'application' AND applied_at >= ? AND applied_at < ?) AS applied,
      (SELECT count(*) FROM applications WHERE user_id = ? AND kind = 'pitch' AND applied_at >= ? AND applied_at < ?) AS pitched,
      (SELECT count(*) FROM applications WHERE user_id = ? AND replied_at >= ? AND replied_at < ?) AS replied,
      (SELECT count(*) FROM applications WHERE user_id = ? AND ghosted_at >= ? AND ghosted_at < ?) AS ghosted,
      (SELECT count(*) FROM applications WHERE user_id = ? AND status = 'rejected' AND replied_at >= ? AND replied_at < ?) AS rejected,
      (SELECT count(*) FROM applications WHERE user_id = ? AND status = 'interview' AND replied_at >= ? AND replied_at < ?) AS interview,
      (SELECT count(*) FROM applications WHERE user_id = ? AND status = 'offer' AND replied_at >= ? AND replied_at < ?) AS offer`,
    userId, from, to,
    userId, from, to,
    userId, from, to,
    userId, from, to,
    userId, from, to,
    userId, from, to,
    userId, from, to
  )!;
  const sent = row.applied + row.pitched;
  // response rate is cohort-based: of what you SENT this window, how much was ever answered —
  // event-based replies (to older applications) could push it past 100% (§22.3 donut).
  const cohort = get<any>(
    `SELECT count(*) AS sent,
            sum(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) AS replied
       FROM applications
      WHERE user_id = ? AND kind IN ('application','pitch')
        AND applied_at >= ? AND applied_at < ?`,
    userId, from, to
  )!;
  const response_rate = cohort.sent ? Number(((cohort.replied / cohort.sent) * 100).toFixed(1)) : 0;
  return { ...row, sent, response_rate };
}

/** KPI wall payload (§33.3) — value + prev + delta in one round-trip (§37.4). */
export function summary(userId: string, period: Period = "week") {
  const tz = tzOf(userId);
  const { from, to, prevFrom, prevTo } = periodRange(period, tz);
  const cur = countsFor(userId, from, to);
  const prev = countsFor(userId, prevFrom, prevTo);

  const t = streakToday(userId);
  const medianReply = medianTimeToReply(userId);
  return {
    period,
    range: { from, to, prev_from: prevFrom, prev_to: prevTo },
    kpis: {
      applications: kpi(cur.applied, prev.applied),
      pitched: kpi(cur.pitched, prev.pitched),
      replies: kpi(cur.replied, prev.replied),
      ghosted: kpi(cur.ghosted, prev.ghosted),
      rejected: kpi(cur.rejected, prev.rejected),
      interviews: kpi(cur.interview, prev.interview),
      offers: kpi(cur.offer, prev.offer),
      response_rate: kpi(cur.response_rate, prev.response_rate, "%"),
      streak: t,
    },
    funnel: funnelCounts(userId, from, to),
    median_time_to_reply_days: medianReply.p50,
    p90_time_to_reply_days: medianReply.p90,
  };
}

export function medianTimeToReply(userId: string): { p50: number | null; p90: number | null } {
  const rows = all<{ first_reply_days: number }>(
    "SELECT first_reply_days FROM applications WHERE user_id = ? AND first_reply_days IS NOT NULL ORDER BY first_reply_days ASC",
    userId
  );
  if (!rows.length) return { p50: null, p90: null };
  const vals = rows.map((r) => Number(r.first_reply_days));
  const pick = (q: number) => vals[Math.min(vals.length - 1, Math.floor(q * vals.length))];
  return { p50: pick(0.5), p90: pick(0.9) };
}

/** Layered funnel field counts (§22.2). */
/**
 * Cohort funnel (§22.2): applications applied within the window, with each downstream
 * outcome measured *within that same cohort* — so bands stay ≤ applied and
 * “% reached a human” can never exceed 100% (independent window-events could, e.g. 114%).
 */
export function funnelCounts(userId: string, from?: string, to?: string) {
  const f = from ?? "1970-01-01";
  const t = to ?? "2999-01-01";
  const row = get<any>(
    `WITH cohort AS (
       SELECT id, status, replied_at FROM applications
       WHERE user_id = ? AND kind = 'application'
         AND COALESCE(applied_at, created_at) >= ? AND COALESCE(applied_at, created_at) < ?
     )
     SELECT
       (SELECT count(*) FROM cohort) AS applied,
       (SELECT count(*) FROM cohort WHERE replied_at IS NOT NULL) AS replied,
       (SELECT count(*) FROM cohort WHERE status = 'ghosted' OR EXISTS (SELECT 1 FROM application_events e WHERE e.app_id = cohort.id AND e.type = 'ghosted')) AS ghosted,
       (SELECT count(*) FROM cohort WHERE status = 'rejected' OR EXISTS (SELECT 1 FROM application_events e WHERE e.app_id = cohort.id AND e.type = 'rejected')) AS rejected,
       (SELECT count(*) FROM cohort WHERE status IN ('interview','offer') OR EXISTS (SELECT 1 FROM application_events e WHERE e.app_id = cohort.id AND e.type IN ('interview','offer'))) AS interview,
       (SELECT count(*) FROM cohort WHERE status = 'offer' OR EXISTS (SELECT 1 FROM application_events e WHERE e.app_id = cohort.id AND e.type = 'offer')) AS offer`,
    userId, f, t
  )!;
  return [
    { key: "applied", label: "Applications", count: row.applied },
    { key: "ghosted", label: "Ghosted / no reply", count: row.ghosted },
    { key: "rejected", label: "Rejected", count: row.rejected },
    { key: "replied", label: "Replied", count: row.replied },
    { key: "interview", label: "1st Interview", count: row.interview },
    { key: "offer", label: "Offers", count: row.offer },
  ];
}

/** Timeseries over application_events (§37.3) — bucketed in the profile timezone. */
export function timeseries(userId: string, metric: "applied" | "replied" | "ghosted" | "rejected" | "interview" | "offer" = "applied", bucket: Period = "day", from?: string) {
  const tz = tzOf(userId);
  const start = from ?? new Date(Date.now() - (bucket === "day" ? 30 : bucket === "week" ? 84 : bucket === "month" ? 365 : 1460) * 86_400_000).toISOString();
  const map = new Map<string, number>();
  const rows =
    metric === "applied"
      ? all<any>("SELECT applied_at AS at FROM applications WHERE user_id = ? AND applied_at IS NOT NULL AND applied_at >= ?", userId, start)
      : metric === "replied"
        ? all<any>("SELECT replied_at AS at FROM applications WHERE user_id = ? AND replied_at IS NOT NULL AND replied_at >= ?", userId, start)
        : metric === "ghosted"
          ? all<any>("SELECT ghosted_at AS at FROM applications WHERE user_id = ? AND ghosted_at IS NOT NULL AND ghosted_at >= ?", userId, start)
          : all<any>(
              `SELECT a.replied_at AS at FROM applications a WHERE a.user_id = ? AND a.status = ? AND a.replied_at IS NOT NULL AND a.replied_at >= ?`,
              userId,
              metric,
              start
            );
  for (const r of rows) {
    if (!r.at) continue;
    const key = bucketKey(r.at, bucket, tz);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([bucket_key, count]) => ({ bucket: bucket_key, count }));
}

/** GitHub-style heatmap intensity (§22.3): 366 days from streak_events. */
export function heatmap(userId: string, year?: number) {
  const tz = tzOf(userId);
  const y = year ?? Number(localDayIso(new Date(), tz).slice(0, 4));
  const rows = all<any>("SELECT day, applications, goal, hit, streak_value FROM streak_events WHERE user_id = ? AND day LIKE ?", userId, `${y}-%`);
  return {
    year: y,
    days: rows.map((r) => ({ day: r.day, count: r.applications, goal: r.goal, hit: !!r.hit, streak: r.streak_value })),
  };
}

/** “What's working” (§22.3): funnels by source/company/cv/template/category. */
export function breakdown(userId: string, by: "source" | "company" | "cv" | "template" | "category" = "source", from?: string) {
  const start = from ?? new Date(Date.now() - 365 * 86_400_000).toISOString();
  const col =
    by === "company"
      ? "company_name"
      : by === "cv"
        ? "cv_id"
        : by === "template"
          ? "template_id"
          : by === "category"
            ? "kind"
            : "source";
  const rows = all<any>(
    `SELECT COALESCE(${col}, 'unknown') AS key,
            count(*) AS sent,
            sum(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) AS replied,
            sum(CASE WHEN status IN ('interview','offer') THEN 1 ELSE 0 END) AS interviews,
            sum(CASE WHEN status = 'offer' THEN 1 ELSE 0 END) AS offers
     FROM applications
     WHERE user_id = ? AND COALESCE(applied_at, created_at) >= ? AND status != 'saved'
     GROUP BY 1 ORDER BY interviews DESC, replied DESC, sent DESC`,
    userId,
    start
  );
  return rows.map((r) => ({
    key: r.key,
    sent: r.sent,
    replied: r.replied,
    interviews: r.interviews,
    offers: r.offers,
    rate: r.sent ? Number(((r.replied / r.sent) * 100).toFixed(1)) : 0,
  }));
}

/** Time-to-reply histogram with p50/p90 (§22.3). */
export function timeToReplyHistogram(userId: string) {
  const vals = all<{ first_reply_days: number }>(
    "SELECT first_reply_days FROM applications WHERE user_id = ? AND first_reply_days IS NOT NULL",
    userId
  ).map((r) => Number(r.first_reply_days));
  const buckets = [0, 0, 0, 0, 0, 0, 0, 0]; // 0-2,2-4,4-7,7-10,10-14,14-21,21-30,30+
  for (const v of vals) {
    if (v < 2) buckets[0]++;
    else if (v < 4) buckets[1]++;
    else if (v < 7) buckets[2]++;
    else if (v < 10) buckets[3]++;
    else if (v < 14) buckets[4]++;
    else if (v < 21) buckets[5]++;
    else if (v < 30) buckets[6]++;
    else buckets[7]++;
  }
  const sorted = [...vals].sort((a, b) => a - b);
  return {
    labels: ["0-2d", "2-4d", "4-7d", "7-10d", "10-14d", "14-21d", "21-30d", "30d+"],
    counts: buckets,
    p50: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    p90: sorted.length ? sorted[Math.floor(sorted.length * 0.9)] : null,
    ghost_threshold: config.ghostAfterDays,
  };
}

export { config };
