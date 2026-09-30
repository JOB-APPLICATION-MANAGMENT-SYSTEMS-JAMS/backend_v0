/**
 * Walk the whole lca.logcluster.org contact-list catalog from this machine.
 *
 *   pnpm tsx scripts/crawl-logcluster.ts [concurrency]
 *
 * The source throttles aggressive clients by answering HTTP 202 with an empty
 * body (no table). When that starts happening we pause globally and back off
 * exponentially instead of burning through the remaining pages.
 *
 * Progress is persisted to export/state.json so an interrupted run resumes with
 * only the pages not yet fetched. Chunks are exported from the local DB at the
 * end (rows are upserted as they arrive), so even a killed run yields its rows.
 *
 * Two outputs: rows are upserted into the local pitch_targets (so local dev sees
 * the same directory), and `export/rows-NNN.json` chunks are written in the shape
 * POST /pitch-targets/import expects, ready to be pushed to a deployment whose own
 * egress is throttled by the source site.
 */
import fs from "node:fs";
import path from "node:path";
import { discoverListPages, parseContactList, type ListRow, type ListPage } from "../src/services/logcluster";
import { run, all } from "../src/core/db";
import { nowIso } from "../src/util/id";

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" };
const CONCURRENCY = Number(process.argv[2] ?? 4);
const CHUNK = 1000;
const EXPORT_DIR = path.join(process.cwd(), "export");
const STATE_FILE = path.join(EXPORT_DIR, "state.json");
/** Max global pause when the source is answering 202 to everything. */
const MAX_BACKOFF_MS = 120_000;

interface ExportRow {
  external_id: string;
  name: string;
  sector: string;
  city: string | null;
  country: string;
  website: string | null;
  email: string | null;
  email_derived: 0 | 1;
  phone: string | null;
}

const upsertLocal = async (r: ListRow, country: string) => {
  await run(
    `INSERT INTO pitch_targets (external_id, name, sector, city, country, website, email, email_derived, phone, lat, lon, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT(external_id) DO UPDATE SET name = excluded.name, city = excluded.city, country = excluded.country,
       website = excluded.website,
       email = CASE WHEN pitch_targets.email_derived = 0 THEN pitch_targets.email ELSE excluded.email END,
       email_derived = CASE WHEN pitch_targets.email_derived = 0 THEN 1 ELSE pitch_targets.email_derived END,
       phone = excluded.phone, fetched_at = excluded.fetched_at`,
    r.external_id, r.name, r.sector, r.city, country, r.website, r.email, r.email_derived, r.phone, nowIso()
  );
};

/** Throttle marker: HTTP 202 with an empty/non-table body (also used by the sitemap). */
class ThrottledError extends Error {}
/** 200 with a rendered page but no contact table — a country-profile or empty list. */
class EmptyPageError extends Error {}

async function fetchPage(slug: string, tries = 3): Promise<string> {
  let last = "";
  let throttled = false;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`https://lca.logcluster.org/${slug}`, { headers: UA, signal: AbortSignal.timeout(30_000) });
      const text = await res.text();
      if (res.ok && text.includes("<table")) return text;
      if (res.ok && text.includes("</html>")) throw new EmptyPageError(`HTTP 200 (no contact table)`);
      throttled = res.status === 202;
      last = `HTTP ${res.status}${text.includes("<table") ? "" : " (no table)"}`;
    } catch (e) {
      if (e instanceof EmptyPageError) throw e;
      last = (e as Error).message;
      throttled = true; // aborts/timeouts come from the same limiter
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
  }
  if (throttled) throw new ThrottledError(last);
  throw new Error(last);
}

const loadState = (): { done: string[] } => {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { done: [] }; }
};
const saveState = (done: Set<string>) =>
  fs.writeFileSync(STATE_FILE, JSON.stringify({ done: [...done] }));

async function main() {
  const pages = await discoverListPages(true);
  fs.mkdirSync(EXPORT_DIR, { recursive: true });

  const state = loadState();
  const doneSet = new Set(state.done);
  const queue = pages.filter((p) => !doneSet.has(p.slug));
  console.log(`${pages.length} catalog pages · ${doneSet.size} already done · ${queue.length} to fetch`);

  let cursor = 0;
  let failed = 0;
  let empty = 0;
  let throttledStreak = 0;
  let backoffUntil = 0;
  let sinceState = 0;
  const t0 = Date.now();

  const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(queue.length, 1)) }, async () => {
    while (cursor < queue.length) {
      const page: ListPage = queue[cursor++];
      // Global pause shared by every worker while the source is throttling.
      const wait = backoffUntil - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        const html = await fetchPage(page.slug);
        const parsed = parseContactList(html, page.sector!, page.slug);
        for (const r of parsed) {
          const country = page.country;
          if (r.city === "Nigeria" && country.toLowerCase() !== "nigeria") r.city = country;
          await upsertLocal(r, country);
        }
        throttledStreak = 0;
        doneSet.add(page.slug);
      } catch (e) {
        if (e instanceof EmptyPageError) {
          // Page rendered fine but has no contact table — nothing to harvest.
          throttledStreak = 0;
          doneSet.add(page.slug);
          empty++;
        } else if (e instanceof ThrottledError) {
          throttledStreak++;
          backoffUntil = Date.now() + Math.min(5_000 * 2 ** Math.min(throttledStreak, 5), MAX_BACKOFF_MS);
          console.log(`throttled (${e.message}) · pause ${Math.round((backoffUntil - Date.now()) / 1000)}s`);
        } else {
          failed++;
          console.log(`failed ${page.slug}: ${(e as Error).message}`);
        }
      }
      if (++sinceState >= 10) { saveState(doneSet); sinceState = 0; }
      const done = doneSet.size + failed;
      if (done % 25 === 0 || cursor === queue.length) {
        const secs = Math.round((Date.now() - t0) / 1000);
        console.log(`${done}/${pages.length} pages · ${failed} failed · ${secs}s`);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  });
  await Promise.all(workers);
  saveState(doneSet);

  // Export from the local DB so partial/killed runs still produce full chunks.
  const rows = await all<ExportRow>(
    `SELECT external_id, name, sector, city, country, website, email, email_derived, phone FROM pitch_targets ORDER BY sector, country, name`
  );
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map((r) => ({ ...r, city: r.city ?? null, website: r.website ?? null, email: r.email ?? null, phone: r.phone ?? null, email_derived: r.email_derived ? 1 : 0 }));
    const file = path.join(EXPORT_DIR, `rows-${String(Math.floor(i / CHUNK) + 1).padStart(3, "0")}.json`);
    fs.writeFileSync(file, JSON.stringify({ rows: chunk }));
  }
  const withEmail = rows.filter((r) => r.email && !r.email_derived).length;
  const withAny = rows.filter((r) => r.email).length;
  console.log(
    `\ndone: ${doneSet.size}/${pages.length} pages fetched (${empty} had no contact table) · ${rows.length} rows on file · ${withAny} with an email (${withEmail} published) · ${failed} pages failed · chunks in ${EXPORT_DIR}`
  );
  if (doneSet.size < pages.length) {
    console.log(`${pages.length - doneSet.size} pages still pending — rerun the script to resume after the cooldown.`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("crawl failed:", e);
  process.exit(1);
});
