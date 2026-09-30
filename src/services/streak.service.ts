import { all, get, run } from "../core/db";
import { newId, nowIso } from "../util/id";
import { config } from "../core/config";
import { localDayIso } from "../util/date";

interface DayRow {
  day: string;
  applications: number;
  goal: number;
  hit: number;
  streak_value: number;
  any_streak: number;
  frozen: number;
}

const tzOf = async (userId: string) => (await get<{ timezone: string }>("SELECT timezone FROM users WHERE id = ?", userId))?.timezone ?? config.timezone;
const goalOf = async (userId: string) => (await get<{ goal_default: number }>("SELECT goal_default FROM users WHERE id = ?", userId))?.goal_default ?? config.defaultGoal;
const rowFor = (userId: string, day: string) => get<DayRow>("SELECT * FROM streak_events WHERE user_id = ? AND day = ?", userId, day);

const prevDay = (day: string) => new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) && new Date(new Date(`${day}T00:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10);

/** Consecutive qualifying days ending at `day`, walking backwards; today only counts once achieved (§23.1). */
async function computeStreak(userId: string, day: string, field: "hit" | "any"): Promise<number> {
  let streak = 0;
  let cursor = `${day}T00:00:00Z`;
  let first = true;
  for (let i = 0; i < 400; i++) {
    const key = new Date(cursor).toISOString().slice(0, 10);
    const r = await rowFor(userId, key);
    const qualifies = r ? (field === "hit" ? !!r.hit : r.applications >= 1) : false;
    if (qualifies) {
      streak++;
    } else if (!first) {
      break;
    }
    first = false;
    cursor = new Date(new Date(cursor).getTime() - 86_400_000).toISOString();
  }
  return streak;
}

/** 1 freeze per 14 days (§23.1): available when no freeze was used in the last 14 days. */
async function freezesAvailable(userId: string): Promise<number> {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const used = (await get<{ n: number }>("SELECT count(*) AS n FROM streak_events WHERE user_id = ? AND frozen = 1 AND day >= ?", userId, since))!.n;
  return used > 0 ? 0 : 1;
}

/**
 * Record effort toward today's daily goal (§23.1): application=1, pitch=1, follow-up=0.25.
 * Idempotent per-day row; streak moves only on real edges (§42.3). Auto-applies a freeze
 * when the previous day was missed and one is available.
 */
export async function recordEffort(userId: string, weight = 1, atIso?: string) {
  const tz = await tzOf(userId);
  const day = localDayIso(atIso ? new Date(atIso) : new Date(), tz);
  const goal = await goalOf(userId);
  let row = await rowFor(userId, day);

  if (!row) {
    const yKey = prevDay(day);
    const y = await rowFor(userId, yKey);
    let carryHit = y && y.hit ? y.streak_value : 0;
    let carryAny = y && y.applications >= 1 ? y.any_streak : 0;
    // auto-freeze: yesterday missed, freeze available → protect the goal streak (§23.1)
    if (y && !y.hit && !y.frozen && (await freezesAvailable(userId)) > 0) {
      await run("UPDATE streak_events SET frozen = 1, hit = 1, streak_value = ? WHERE user_id = ? AND day = ?", y.streak_value + 1, userId, yKey);
      carryHit = y.streak_value + 1;
    }
    if (!y) {
      carryHit = 0;
      carryAny = 0;
    }
    const hit = weight >= goal;
    await run(
      `INSERT INTO streak_events (day, user_id, applications, goal, hit, streak_value, any_streak, frozen)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      day,
      userId,
      Number(weight.toFixed(2)),
      goal,
      hit ? 1 : 0,
      hit ? carryHit + 1 : carryHit,
      carryAny + 1
    );
  } else {
    const count = Number((row.applications + weight).toFixed(2));
    const hit = count >= goal;
    const streak = hit && !row.hit ? row.streak_value + 1 : row.streak_value;
    await run(
      "UPDATE streak_events SET applications = ?, hit = ?, streak_value = ? WHERE user_id = ? AND day = ?",
      count,
      hit ? 1 : 0,
      streak,
      userId,
      day
    );
  }
  // recompute authoritative values from the log (idempotent under replay, §37.4)
  row = (await rowFor(userId, day))!;
  await run(
    "UPDATE streak_events SET streak_value = ?, any_streak = ? WHERE user_id = ? AND day = ?",
    await computeStreak(userId, day, "hit"),
    await computeStreak(userId, day, "any"),
    userId,
    day
  );
  return today(userId);
}

/** Today's state for the goal ring / topbar chip (§40.2). */
export async function today(userId: string) {
  const tz = await tzOf(userId);
  const day = localDayIso(new Date(), tz);
  const goal = await goalOf(userId);
  const row = await rowFor(userId, day);
  const count = row?.applications ?? 0;
  const hit = !!row?.hit;
  const current = await computeStreak(userId, day, "hit");
  const anyStreak = await computeStreak(userId, day, "any");
  const longest = (await get<{ n: number }>("SELECT COALESCE(MAX(streak_value), 0) AS n FROM streak_events WHERE user_id = ?", userId))!.n;
  return {
    day,
    timezone: tz,
    count,
    goal,
    hit,
    remaining: Math.max(0, Math.round((goal - count) * 100) / 100),
    percent: Math.min(100, Math.round((count / Math.max(1, goal)) * 100)),
    streak: current,
    any_effort_streak: anyStreak,
    longest_streak: Math.max(longest, current),
    frozen: !!row?.frozen,
    freeze_available: await freezesAvailable(userId),
    state: hit ? "blazing" : count === 0 ? "cold" : count / Math.max(1, goal) >= 0.5 ? "burning" : "warming",
  };
}

export async function setGoal(userId: string, goal: number, timezone?: string) {
  await run("UPDATE users SET goal_default = ?, updated_at = ? WHERE id = ?", Math.max(1, Math.min(500, Math.round(goal))), nowIso(), userId);
  if (timezone) await run("UPDATE users SET timezone = ? WHERE id = ?", timezone, userId);
  return today(userId);
}

const BADGES: { key: string; label: string; check: (s: any) => boolean }[] = [
  { key: "first_100", label: "First 100 applications", check: (s) => s.applications >= 100 },
  { key: "streak_7", label: "7-day streak", check: (s) => s.longest_streak >= 7 },
  { key: "streak_30", label: "30-day streak", check: (s) => s.longest_streak >= 30 },
  { key: "replies_10", label: "10 replies", check: (s) => s.replies >= 10 },
  { key: "first_interview", label: "First interview", check: (s) => s.interviews >= 1 },
  { key: "first_offer", label: "First offer", check: (s) => s.offers >= 1 },
  { key: "goal_hit", label: "Daily goal hit", check: (s) => s.goal_hits >= 1 },
];

/** Badges are pure projections of the event log (§23.1), persisted once on unlock. */
export async function badges(userId: string) {
  const stats = (await get<any>(
    `SELECT
       (SELECT count(*) FROM applications WHERE user_id = ? AND status != 'saved') AS applications,
       (SELECT count(*) FROM applications WHERE user_id = ? AND replied_at IS NOT NULL) AS replies,
       (SELECT count(*) FROM applications WHERE user_id = ? AND status = 'interview') AS interviews,
       (SELECT count(*) FROM applications WHERE user_id = ? AND status = 'offer') AS offers,
       (SELECT count(*) FROM streak_events WHERE user_id = ? AND hit = 1) AS goal_hits,
       (SELECT COALESCE(MAX(streak_value),0) FROM streak_events WHERE user_id = ?) AS longest_streak`,
    userId,
    userId,
    userId,
    userId,
    userId,
    userId
  ))!;
  const unlocked = new Map(
    (await all<{ badge_key: string; unlocked_at: string }>("SELECT badge_key, unlocked_at FROM badges WHERE user_id = ?", userId)).map((b) => [b.badge_key, b.unlocked_at])
  );
  for (const b of BADGES) {
    const done = b.check(stats) || unlocked.has(b.key);
    if (done && !unlocked.has(b.key)) {
      // portable upsert-ignore (works in SQLite and Postgres)
      await run("INSERT INTO badges (id, user_id, badge_key, unlocked_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING", newId(), userId, b.key, nowIso());
      unlocked.set(b.key, nowIso());
    }
  }
  return BADGES.map((b) => {
    const done = b.check(stats) || unlocked.has(b.key);
    return { key: b.key, label: b.label, unlocked: done, unlocked_at: unlocked.get(b.key) ?? null };
  });
}

/** Victory mode (§23.1 “I got a job”), inline status write avoids a circular service import. */
export async function victory(userId: string, payload: { offer_source: "manual" | "email"; application_id?: string }) {
  const p = await get<any>("SELECT * FROM profiles WHERE user_id = ?", userId);
  if (p) {
    const prefs = JSON.parse(p.prefs ?? "{}");
    prefs.victory = { at: nowIso(), source: payload.offer_source, application_id: payload.application_id ?? null };
    await run("UPDATE profiles SET prefs = ?, version = version + 1, updated_at = ? WHERE id = ?", JSON.stringify(prefs), nowIso(), p.id);
  }
  if (payload.application_id) {
    const app = await get<any>("SELECT * FROM applications WHERE id = ? AND user_id = ?", payload.application_id, userId);
    if (app && app.status !== "offer") {
      await run("UPDATE applications SET status = 'offer', replied_at = COALESCE(replied_at, ?), updated_at = ? WHERE id = ?", nowIso(), nowIso(), app.id);
      await run("INSERT INTO application_events (app_id, type, at, actor, payload) VALUES (?, 'status_changed', ?, 'user', ?)", app.id, nowIso(), JSON.stringify({ from: app.status, to: "offer" }));
      await run("INSERT INTO application_events (app_id, type, at, actor, payload) VALUES (?, 'offer', ?, 'user', null)", app.id, nowIso());
    }
  }
  const t = await today(userId);
  const totals = (await get<any>(
    `SELECT (SELECT count(*) FROM applications WHERE user_id = ?) AS applications,
            (SELECT COALESCE(SUM(applications),0) FROM streak_events WHERE user_id = ?) AS effort,
            (SELECT min(created_at) FROM applications WHERE user_id = ?) AS first_at`,
    userId,
    userId,
    userId
  ))!;
  return {
    celebrated: true,
    summary: {
      applications: totals.applications,
      effort: totals.effort,
      days: totals.first_at ? Math.max(1, Math.round((Date.now() - new Date(totals.first_at).getTime()) / 86_400_000)) : 0,
      streak: t.streak,
    },
  };
}

export async function streakHistory(userId: string, days = 120) {
  return all(
    "SELECT day, applications, goal, hit, streak_value, frozen FROM streak_events WHERE user_id = ? ORDER BY day DESC LIMIT ?",
    userId,
    days
  );
}
