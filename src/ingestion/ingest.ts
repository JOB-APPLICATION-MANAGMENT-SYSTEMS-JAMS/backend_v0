import { all, get, run } from "../core/db";
import { newId, nowIso } from "../util/id";
import { SOURCES } from "./sources";
import { normalize } from "./base";
import { profileSignals } from "../services/profile-signals";
import { scorePosting, extractKeywords } from "../services/scoring.service";
import { dedupeKey } from "./base";

export interface IngestResult {
  sources_ok: string[];
  sources_failed: { source: string; error: string }[];
  inserted: number;
  deduped: number;
  refreshed: number;
  took_ms: number;
}

/** Pull from every enabled source, normalise, dedupe across sources, score for this profile (§34.1). */
export async function ingestAll(userId: string, opts: { sources?: string[] } = {}): Promise<IngestResult> {
  const t0 = Date.now();
  const signals = await profileSignals(userId);
  const enabled = opts.sources?.length ? opts.sources : (await all<{ name: string; enabled: number }>("SELECT name, enabled FROM sources WHERE enabled = 1")).map((s) => s.name);
  const sources_ok: string[] = [];
  const sources_failed: { source: string; error: string }[] = [];
  let inserted = 0;
  let deduped = 0;
  let refreshed = 0;

  const existingKeys = new Map(
    (await all<{ id: string; dedupe_key: string; first_seen_at: string; source: string; external_id: string }>(
      "SELECT id, dedupe_key, first_seen_at, source, external_id FROM job_postings WHERE user_id = ?",
      userId
    )).map((r) => [`${r.source}:${r.external_id}`, r])
  );
  const keySeen = new Set((await all<{ dedupe_key: string }>("SELECT dedupe_key FROM job_postings WHERE user_id = ? AND created_at >= ?", userId, new Date(Date.now() - 30 * 86_400_000).toISOString())).map((r) => r.dedupe_key));

  for (const src of SOURCES) {
    if (!enabled.includes(src.name)) continue;
    try {
      const raw = await src.fetch();
      let found = 0;
      for (const item of raw) {
        const n = normalize(item);
        const uniq = `${src.name}:${item.external_id}`;
        if (existingKeys.has(uniq)) {
          refreshed++;
          continue;
        }
        // cross-source twin collapse (§34.3)
        if (keySeen.has(n.dedupe_key)) {
          deduped++;
          continue;
        }
        const scored = scorePosting(signals, {
          title: n.title,
          description: n.description,
          companyName: n.company,
          seniority: n.seniority,
          remote: !!n.remote,
          location: n.location,
          salaryMin: n.salary_min,
          salaryMax: n.salary_max,
          postedAt: n.posted_at,
        });
        const keywords = n.keywords?.length ? n.keywords : extractKeywords(`${n.title} ${n.description ?? ""}`);
        await run(
          `INSERT INTO job_postings (id, user_id, company_name, source, external_id, title, location, remote, salary_min, salary_max, currency,
             seniority, employment_type, career_category, description, jd_keywords, url, posted_at, first_seen_at, last_seen_at, score, explain, dedupe_key, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
          newId(),
          userId,
          n.company,
          src.name,
          item.external_id,
          n.title,
          n.location,
          n.remote ? 1 : 0,
          n.salary_min,
          n.salary_max,
          n.currency,
          n.seniority,
          n.employment_type,
          n.category ?? "software_engineering",
          n.description,
          JSON.stringify(keywords),
          n.url,
          n.posted_at,
          nowIso(),
          nowIso(),
          scored.score,
          JSON.stringify(scored.explain),
          n.dedupe_key,
          nowIso()
        );
        keySeen.add(n.dedupe_key);
        inserted++;
        found++;
      }
      sources_ok.push(src.name);
      await run(
        `INSERT INTO sources (name, enabled, last_run_at, items_found, error_streak, last_error) VALUES (?, 1, ?, ?, 0, NULL)
         ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at, items_found = excluded.items_found, error_streak = 0, last_error = NULL`,
        src.name,
        nowIso(),
        found
      );
    } catch (e: any) {
      sources_failed.push({ source: src.name, error: String(e.message ?? e) });
      await run(
        `INSERT INTO sources (name, enabled, last_run_at, items_found, error_streak, last_error) VALUES (?, 1, NULL, 0, 1, ?)
         ON CONFLICT(name) DO UPDATE SET error_streak = sources.error_streak + 1, last_error = excluded.last_error`,
        src.name,
        String(e.message ?? e)
      );
    }
  }

  // expire postings not seen in 14d (§34.1)
  await run("UPDATE job_postings SET status = 'expired' WHERE user_id = ? AND last_seen_at < ? AND status = 'open'", userId, new Date(Date.now() - 14 * 86_400_000).toISOString());

  return { sources_ok, sources_failed, inserted, deduped, refreshed, took_ms: Date.now() - t0 };
}

/** Source health (debug page visibility, §34.1). */
export async function sourceHealth() {
  // pitch:* rows track Overpass refreshes for the pitch panel; they are not job boards
  const rows = (await all<any>("SELECT * FROM sources ORDER BY name")).filter((r) => !r.name.startsWith("pitch:"));
  const known = SOURCES.map((s) => s.name);
  for (const name of known) if (!rows.find((r: any) => r.name === name)) rows.push({ name, enabled: 1, last_run_at: null, items_found: 0, error_streak: 0, last_error: null });
  return rows;
}
