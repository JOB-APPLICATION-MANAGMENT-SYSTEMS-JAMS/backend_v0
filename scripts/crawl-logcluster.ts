/**
 * Walk the whole lca.logcluster.org contact-list catalog from this machine.
 *
 *   pnpm tsx scripts/crawl-logcluster.ts [concurrency]
 *
 * Two outputs: rows are upserted into the local pitch_targets (so local dev sees the
 * same directory), and `export/rows-NNN.json` chunks are written in the shape
 * POST /pitch-targets/import expects, ready to be pushed to a deployment whose own
 * egress is throttled by the source site.
 */
import fs from "node:fs";
import path from "node:path";
import { discoverListPages, parseContactList, type ListRow, type ListPage } from "../src/services/logcluster";
import { run } from "../src/core/db";
import { nowIso } from "../src/util/id";

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" };
const CONCURRENCY = Number(process.argv[2] ?? 4);
const CHUNK = 1000;
const EXPORT_DIR = path.join(process.cwd(), "export");

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
       email_derived = CASE WHEN pitch_targets.email_derived = 0 THEN 1 ELSE excluded.email_derived END,
       phone = excluded.phone, fetched_at = excluded.fetched_at`,
    r.external_id, r.name, r.sector, r.city, country, r.website, r.email, r.email_derived, r.phone, nowIso()
  );
};

async function fetchPage(slug: string, tries = 3): Promise<string> {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`https://lca.logcluster.org/${slug}`, { headers: UA, signal: AbortSignal.timeout(30_000) });
      const text = await res.text();
      if (res.ok && text.includes("<table")) return text;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  throw new Error(last);
}

async function main() {
  const pages = await discoverListPages(true);
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
  const rows: ExportRow[] = [];
  const failed: string[] = [];
  let done = 0;
  const t0 = Date.now();

  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, pages.length) }, async () => {
    while (cursor < pages.length) {
      const page: ListPage = pages[cursor++];
      try {
        const html = await fetchPage(page.slug);
        const parsed = parseContactList(html, page.sector!, page.slug);
        for (const r of parsed) {
          const country = page.country;
          if (r.city === "Nigeria" && country.toLowerCase() !== "nigeria") r.city = country;
          await upsertLocal(r, country);
          rows.push({
            external_id: r.external_id,
            name: r.name,
            sector: r.sector,
            city: r.city,
            country,
            website: r.website,
            email: r.email,
            email_derived: r.email_derived,
            phone: r.phone,
          });
        }
      } catch (e) {
        failed.push(`${page.slug}: ${(e as Error).message}`);
      }
      done++;
      if (done % 25 === 0) {
        const secs = Math.round((Date.now() - t0) / 1000);
        console.log(`${done}/${pages.length} pages · ${rows.length} rows · ${failed.length} failed · ${secs}s`);
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  });
  await Promise.all(workers);

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const file = path.join(EXPORT_DIR, `rows-${String(Math.floor(i / CHUNK) + 1).padStart(3, "0")}.json`);
    fs.writeFileSync(file, JSON.stringify({ rows: chunk }));
  }
  const withEmail = rows.filter((r) => r.email && !r.email_derived).length;
  const withAny = rows.filter((r) => r.email).length;
  console.log(
    `\ndone: ${rows.length} rows from ${pages.length - failed.length}/${pages.length} pages · ${withAny} with an email (${withEmail} published) · chunks in ${EXPORT_DIR}`
  );
  if (failed.length) console.log(`failed (${failed.length}):\n  ${failed.slice(0, 20).join("\n  ")}`);
  process.exit(failed.length > pages.length / 2 ? 1 : 0);
}

main().catch((e) => {
  console.error("crawl failed:", e);
  process.exit(1);
});
