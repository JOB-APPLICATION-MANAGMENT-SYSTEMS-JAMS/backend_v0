/**
 * In-process worker (§29.1: "API does request/response, workers do everything slow").
 * No Redis/ARQ in this environment — a single interval scheduler with jittered phases.
 * Jobs: ghost sweep · ingestion refresh · sequence due-check · daily rollups.
 */
import { ghostSweep } from "../services/application.service";
import { ingestAll } from "../ingestion/ingest";
import { all, run } from "../core/db";
import { config } from "../core/config";
import { localDayIso } from "../util/date";
import { newId } from "../util/id";

let timer: NodeJS.Timeout | null = null;
let tick = 0;

export function startScheduler() {
  if (timer) return;
  timer = setInterval(async () => {
    tick++;
    try {
      if (tick % 5 === 0) {
        const { flipped } = ghostSweep();
        if (flipped) console.log(`[worker] ghost sweep flipped ${flipped} application(s)`);
      }
      if (tick % 30 === 0) {
        // refresh ingestion for the single owner (free sources, low frequency)
        const users = all<{ id: string }>("SELECT id FROM users");
        for (const u of users) {
          const r = await ingestAll(u.id);
          if (r.inserted) console.log(`[worker] ingest +${r.inserted} postings (${r.sources_ok.length} sources ok)`);
        }
      }
      if (tick % 15 === 0) sequenceReminders();
      if (tick % 60 === 0) buildRollups();
    } catch (e: any) {
      console.error("[worker] tick failed:", e.message);
    }
  }, config.workerIntervalMs);
  timer.unref?.();
  console.log(`[worker] scheduler started (interval ${config.workerIntervalMs}ms)`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** v0: notify (chips) instead of autonomous sending (§26.4). */
function sequenceReminders() {
  const due = all<{ id: string; user_id: string; app_id: string; step_no: number }>(
    `SELECT id, user_id, app_id, step_no FROM outreach_messages
     WHERE state = 'scheduled' AND scheduled_at IS NOT NULL AND scheduled_at <= ?`,
    new Date().toISOString()
  );
  for (const d of due) {
    const replied = all("SELECT 1 FROM email_messages WHERE user_id = ? AND direction = 'inbound' AND outreach_id IN (SELECT id FROM outreach_messages WHERE app_id = ?) LIMIT 1", d.user_id, d.app_id);
    if (replied.length) {
      run("UPDATE outreach_messages SET state = 'paused' WHERE id = ?", d.id); // pause on reply (§26.2)
      continue;
    }
    console.log(`[worker] follow-up due: outreach ${d.id} (step ${d.step_no}) — surfaced as a chip`);
    if (d.app_id) run("INSERT INTO application_events (app_id, type, at, actor, payload) VALUES (?, 'note', ?, 'system', ?)", d.app_id, new Date().toISOString(), JSON.stringify({ follow_up_due: d.id }));
  }
}

/** Nightly rollup cache per day (§37.1) — metrics JSONB projection of the event log. */
function buildRollups() {
  const days = all<{ day: string; user_id: string }>(
    `SELECT DISTINCT day, user_id FROM (SELECT substr(at,1,10) AS day, (SELECT user_id FROM applications WHERE id = app_id) AS user_id FROM application_events ORDER BY day DESC LIMIT 5000)`
  );
  for (const d of days) {
    if (!d.user_id || !d.day) continue;
    const metrics = {
      applied: all("SELECT count(*) AS n FROM applications WHERE user_id = ? AND substr(applied_at,1,10) = ?", d.user_id, d.day)[0]?.n ?? 0,
      replied: all("SELECT count(*) AS n FROM applications WHERE user_id = ? AND substr(replied_at,1,10) = ?", d.user_id, d.day)[0]?.n ?? 0,
    };
    run(
      `INSERT INTO daily_rollups (day, user_id, metrics) VALUES (?, ?, ?)
       ON CONFLICT(user_id, day) DO UPDATE SET metrics = excluded.metrics`,
      d.day,
      d.user_id,
      JSON.stringify(metrics)
    );
  }
}

export const runGhostSweep = () => ghostSweep();
export const runIngest = (userId: string) => ingestAll(userId);
export const newRunId = () => newId();
export const todayKey = (tz: string) => localDayIso(new Date(), tz);
