/**
 * Curated contact lists (§25.4): published HTML tables of companies with official
 * emails, scraped live from lca.logcluster.org. These cover sectors where OSM is
 * thin (airlines, port terminals, humanitarian agencies, fuel suppliers …) and the
 * emails are the whole point: the pitch cannot be sent without one.
 *
 * Two layers:
 *  1. `LIST_SOURCES` — the hand-picked Nigeria lists behind each pitch sector,
 *     fetched on demand and cached for 24h (what the sector picker uses).
 *  2. the *catalog* — every contact-list page in the site's sitemap (~1,200 pages,
 *     188 countries). `rescanAll` walks it with bounded concurrency, resumes from
 *     pages already fetched in the last 7 days, and reports progress so the UI can
 *     show a live counter. This is where the ~10,000 companies come from.
 *
 * After the lists land, `enrichEmails` visits each company website and picks up the
 * published inbox (mailto: first, then any strict address on the page) so fewer rows
 * end up with "no email available".
 *
 * Parser is deliberately regex-based (no cheerio): tables are flat, cells are
 * `<td><p>text</p></td>` with `&nbsp;` padding and inline links.
 */
import { all, run } from "../core/db";
import { nowIso } from "../util/id";

export type ListSector =
  | "airline"
  | "port"
  | "government"
  | "humanitarian"
  | "laboratory"
  | "fuel"
  | "transporter"
  | "railway"
  | "waste"
  | "supplier"
  | "services"
  | "agriculture";

/** Nigeria's own pages per sector (each sector may own several lists). */
export const LIST_SOURCES: Record<ListSector, string[]> = {
  airline: ["45-nigeria-airport-companies-contact-list"],
  port: ["44-nigeria-port-and-waterways-company-contact-list"],
  government: ["41-nigeria-government-contact-list"],
  humanitarian: ["42-nigeria-humanitarian-agency-contact-list"],
  laboratory: ["43-nigeria-laboratory-and-quality-testing-companies-contactlist"],
  fuel: ["47-nigeria-fuel-providers-contact-list"],
  transporter: ["48-nigeria-transporter-contact-list"],
  railway: ["49-nigeria-railway-companies-contact-list"],
  waste: ["412-nigeria-waste-management-companies-contact-list"],
  supplier: ["410-nigeria-supplier-contact-list"],
  services: ["411-nigeria-additional-services-contact-list"],
  agriculture: ["46-nigeria-storage-and-milling-companies-contact-list"],
};

export const LIST_SECTORS = Object.keys(LIST_SOURCES) as ListSector[];

/** Human labels for the sector picker (the pitch UI renders these verbatim). */
export const LIST_LABELS: Record<ListSector, string> = {
  airline: "Airlines & aviation (curated)",
  port: "Ports & waterways (curated)",
  government: "Government & public sector (curated)",
  humanitarian: "Humanitarian & NGOs (curated)",
  laboratory: "Laboratory & quality testing (curated)",
  fuel: "Fuel & energy suppliers (curated)",
  transporter: "Transporters & logistics (curated)",
  railway: "Railway companies (curated)",
  waste: "Waste management (curated)",
  supplier: "Suppliers & distributors (curated)",
  services: "Additional services (curated)",
  agriculture: "Agriculture & milling (curated)",
};

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" };

const decode = (s: string): string =>
  s
    .replace(/<[^>]+>/g, " ")
    // &amp; first, so double-escaped entities like &amp;nbsp; decode on the next pass
    .replace(/&amp;/g, "&")
    // &nbsp; or the broken &nbsp the source publishes (no trailing semicolon)
    .replace(/&nbsp;?/gi, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

export const slugName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
// deliverability-shaped: the published lists contain junk like info@.example.com
const STRICT_EMAIL = /^[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;
const findEmails = (s: string): string[] =>
  (s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [])
    .map((e) => e.toLowerCase().replace(/[.,;]+$/, ""))
    .filter((e) => STRICT_EMAIL.test(e));
const looksLikeSite = (s: string) => /^(www\.|https?:\/\/|\w+\.(com|ng|aero|net|org|co)(\/|$))/i.test(s.trim());
// phone cells hold several numbers separated by spaces/plus/pipes/commas,
// e.g. "+234 805 410 0127 +234 807 200 5691" or "Tel : 01-271-6732 | 01-271-6733".
// Excel-corrupted cells like "2.348E+12" fail the digit test and are dropped.
const looksLikePhone = (s: string): boolean => {
  const t = s.replace(/\b(tel|phone|fax|mobile|call)\b\s*[:.]?/gi, "").trim();
  if (!/^[\d+]/.test(t) || !/^[\d\s+.,/()|;:-]+$/.test(t)) return false;
  return (t.match(/\d/g) ?? []).length >= 7;
};

const NG_CITIES = ["lagos", "abuja", "port harcourt", "ikeja", "apapa", "onne", "kano", "calabar", "uyo", "enugu", "ibadan", "kaduna", "warri", "benin", "onitsha", "abroad"];

export const detectCity = (address: string): string => {
  const a = (address ?? "").toLowerCase();
  for (const c of NG_CITIES) if (a.includes(c)) return c.replace(/\b\w/g, (m) => m.toUpperCase());
  return "Nigeria";
};

export interface ListRow {
  external_id: string;
  name: string;
  sector: ListSector;
  city: string;
  address: string | null;
  website: string | null;
  email: string | null;
  email_derived: 0 | 1;
  phone: string | null;
}

/**
 * Parse a contact-list page into rows. Cell roles are detected by content, not
 * position, so a missing column cannot shift the rest: email contains @, website
 * looks like a domain, phone looks like digits, name is the longest remaining
 * alphabetic cell (address is the other long one and never sits first).
 *
 * `pageSlug` disambiguates companies with the same name across the 1,200 worldwide
 * lists (the id becomes list:<sector>:<pageSlug>:<company>).
 */
export function parseContactList(html: string, sector: ListSector, pageSlug?: string): ListRow[] {
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]);
  const out: ListRow[] = [];
  const seen = new Set<string>();
  const prefix = `list:${sector}:${pageSlug ? `${pageSlug}:` : ""}`;

  for (const table of tables) {
    for (const tr of [...table.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((m) => m[0])) {
      const rawCells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => m[1]);
      if (rawCells.length < 4) continue;
      // mailto links often carry the address the anchor text abbreviates
      const mailtoEmails = rawCells.flatMap((c) => findEmails(decode((c.match(/mailto:([^"'?\s]+)/gi) ?? []).join(" "))));
      const cells = rawCells.map((c) => decode(c));
      if (cells.length < 4) continue;

      const siteCell = cells.find((c) => !EMAIL_RE.test(c) && looksLikeSite(c));
      const phoneCell = cells.find((c) => looksLikePhone(c) && !EMAIL_RE.test(c));
      const nameCell = cells.find(
        (c) => c.length > 2 && !EMAIL_RE.test(c) && !looksLikeSite(c) && !looksLikePhone(c) && /[a-z]/i.test(c) && !/^sn$/i.test(c)
      );
      if (!nameCell) continue; // header row or malformed

      const name = nameCell.trim();
      if (/^(airline name|terminals? operator name|company|name|sn)$/i.test(name)) continue; // headers
      if (seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());

      const addressCell = cells.find((c) => c !== nameCell && c.length > 12 && /[a-z]/i.test(c) && !EMAIL_RE.test(c) && !looksLikeSite(c) && !looksLikePhone(c) && c !== phoneCell && c !== siteCell);
      const address = addressCell ?? null;
      // the lists mix columns (a website cell can hold info@..., the email cell can
      // hold two addresses): take the strictest email, preferring the cell that
      // holds the most of them, so the email column wins over a stray one.
      let email: string | null = null;
      let emailCount = 0;
      for (const c of cells) {
        const found = findEmails(c);
        if (found.length > 0 && found.length >= emailCount) {
          emailCount = found.length;
          email = found[0];
        }
      }
      // an empty-looking cell can still hide the address behind a mailto: link
      if (!email && mailtoEmails.length) email = mailtoEmails[0];
      // website: first whitespace-delimited token, entities and trailing punctuation stripped
      const siteToken = (siteCell ?? "")
        .split(/\s/)[0]
        .replace(/&[a-z0-9]*;?$/i, "")
        .replace(/[.,;]+$/, "");
      const website = looksLikeSite(siteToken) ? (/^https?:\/\//i.test(siteToken) ? siteToken : `https://${siteToken}`) : null;
      const derived = !email && website;
      if (!email && !website) continue; // nothing to pitch at on a curated list

      out.push({
        external_id: `${prefix}${slugName(name)}`,
        name,
        sector,
        city: detectCity(address ?? ""),
        address,
        website,
        email: email ?? (derived ? deriveFromSite(website!) : null),
        email_derived: email ? 0 : 1,
        phone: phoneCell?.trim() ?? null,
      });
    }
  }
  return out;
}

const deriveFromSite = (website: string): string | null => {
  try {
    return `info@${new URL(website).hostname.replace(/^www\./i, "").toLowerCase()}`;
  } catch {
    return null;
  }
};

/* ------------------------------- catalog layer ------------------------------ */

export interface ListPage {
  slug: string;
  country: string;
  sector: ListSector | null;
}

let catalogCache: { at: number; pages: ListPage[] } | null = null;
const CATALOG_TTL = 12 * 60 * 60 * 1000;

/** slug → sector, by the category token that follows the country. */
const CATEGORY_RULES: [RegExp, ListSector][] = [
  [/^(airport|airline|aviation)/, "airline"],
  [/^port/, "port"],
  [/^government/, "government"],
  [/^humanitarian/, "humanitarian"],
  [/^laborator/, "laboratory"],
  [/^fuel/, "fuel"],
  [/^(transporter|transport|logistics)/, "transporter"],
  [/^railway/, "railway"],
  [/^waste/, "waste"],
  [/^supplier/, "supplier"],
  [/^(storage|milling)/, "agriculture"],
  [/^(additional|service)/, "services"],
];

const CATEGORY_TOKENS = /^(airport|airline|aviation|port|government|humanitarian|laborator|fuel|transporter|transport|logistics|railway|waste|supplier|storage|milling|additional|service|quality|companies|company|contact)/;

/** `45-nigeria-airport-companies-contact-list` → { country: "nigeria", sector: "airline" }. */
export function pageFromSlug(slug: string): ListPage | null {
  if (!/contact-?list/.test(slug)) return null;
  const parts = slug.split("-");
  if (!/^\d+$/.test(parts[0])) return null;
  const rest = parts.slice(1);
  // country = tokens until the category starts, so multi-word countries survive
  const cut = rest.findIndex((t) => CATEGORY_TOKENS.test(t));
  const countryTokens = cut > 0 ? rest.slice(0, cut) : cut === 0 ? [] : rest;
  const categoryTokens = cut >= 0 ? rest.slice(cut) : rest;
  const category = categoryTokens.join("-");
  const rule = CATEGORY_RULES.find(([re]) => re.test(category));
  return {
    slug,
    country: countryTokens.join(" ").replace(/\b\w/g, (m) => m.toUpperCase()) || "Worldwide",
    sector: rule ? rule[1] : null,
  };
}

/**
 * Every contact-list page in the sitemap (4 shards of ~6,400 URLs today).
 * Cached for 12h: discovery is a network round-trip and the catalog rarely moves.
 */
export async function discoverListPages(force = false): Promise<ListPage[]> {
  if (!force && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL) return catalogCache.pages;
  const urls: string[] = [];
  for (let shard = 1; shard <= 8; shard++) {
    const res = await fetch(`https://lca.logcluster.org/sitemap.xml?page=${shard}`, { headers: UA, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) break;
    const xml = await res.text();
    const found = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    if (!found.length) break;
    urls.push(...found);
    if (found.length < 500 && shard > 1) break; // last shard is short
  }
  const seen = new Set<string>();
  const pages: ListPage[] = [];
  for (const url of urls) {
    const slug = url.replace(/^https?:\/\/lca\.logcluster\.org\//, "").replace(/\/$/, "").split("?")[0];
    if (seen.has(slug)) continue;
    seen.add(slug);
    const page = pageFromSlug(slug);
    if (page?.sector) pages.push(page);
  }
  catalogCache = { at: Date.now(), pages };
  return pages;
}

/* ------------------------------ fetch helpers ------------------------------ */

async function fetchText(url: string, timeout = 20_000, tries = 2): Promise<string> {
  let lastErr: Error | null = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
      if (res.status === 406 || res.status === 403) throw new Error(`logcluster HTTP ${res.status} (${url})`);
      if (!res.ok) throw new Error(`logcluster HTTP ${res.status} (${url})`);
      return await res.text();
    } catch (e) {
      lastErr = e as Error;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  throw lastErr ?? new Error(`fetch failed (${url})`);
}

/** Bounded-concurrency runner; results are pushed in completion order. */
async function pool<T>(items: T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

const upsertRow = (r: ListRow, country: string | null) =>
  run(
    `INSERT INTO pitch_targets (external_id, name, sector, city, country, website, email, email_derived, phone, lat, lon, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
     ON CONFLICT(external_id) DO UPDATE SET name = excluded.name, city = excluded.city, country = excluded.country,
       website = excluded.website, email = CASE WHEN pitch_targets.email_derived = 0 THEN pitch_targets.email ELSE excluded.email END,
       email_derived = CASE WHEN pitch_targets.email_derived = 0 THEN 1 ELSE excluded.email_derived END,
       phone = excluded.phone, fetched_at = excluded.fetched_at`,
    r.external_id, r.name, r.sector, r.city, country, r.website, r.email, r.email_derived, r.phone, nowIso()
  );

/** Fetch one list page, parse it, upsert it; returns the rows parsed. */
async function ingestPage(page: ListPage): Promise<ListRow[]> {
  const html = await fetchText(`https://lca.logcluster.org/${page.slug}`);
  const rows = parseContactList(html, page.sector!, page.slug);
  const now = nowIso();
  for (const r of rows) {
    // detectCity is Nigeria-tuned; outside Nigeria the country is the honest label
    if (r.city === "Nigeria" && page.country.toLowerCase() !== "nigeria") r.city = page.country;
    await upsertRow(r, page.country);
  }
  await run(
    `INSERT INTO sources (name, last_run_at, items_found, error_streak, last_error)
     VALUES (?, ?, ?, 0, NULL)
     ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at, items_found = excluded.items_found, error_streak = 0, last_error = NULL`,
    `pitch:page:${page.slug}`,
    now,
    rows.length
  );
  return rows;
}

/** Fetch a list page and parse it; throws on network/HTTP failure. */
export async function fetchContactList(sector: ListSector): Promise<ListRow[]> {
  const slugs = LIST_SOURCES[sector] ?? [];
  const out: ListRow[] = [];
  for (const slug of slugs) {
    const html = await fetchText(`https://lca.logcluster.org/${slug}`);
    out.push(...parseContactList(html, sector, slug));
  }
  return out;
}

/** Fetch + upsert into pitch_targets; returns how many rows were stored. */
export async function refreshContactList(sector: ListSector): Promise<number> {
  const rows = await fetchContactList(sector);
  const now = nowIso();
  for (const r of rows) await upsertRow(r, "Nigeria");
  await run(
    `INSERT INTO sources (name, last_run_at, items_found, error_streak, last_error)
     VALUES (?, ?, ?, 0, NULL)
     ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at, items_found = excluded.items_found, error_streak = 0, last_error = NULL`,
    `pitch:list:${sector}`,
    now,
    rows.length
  );
  return rows.length;
}

/* --------------------------------- rescan ---------------------------------- */

export interface RescanState {
  status: "idle" | "running" | "done" | "error";
  phase: "lists" | "enrich";
  scope: "all" | "nigeria";
  pages_total: number;
  pages_done: number;
  pages_failed: number;
  pages_skipped: number;
  rows_found: number;
  rows_with_email: number;
  emails_found: number;
  errors: string[];
  started_at: string | null;
  finished_at: string | null;
}

const idleState = (): RescanState => ({
  status: "idle",
  phase: "lists",
  scope: "all",
  pages_total: 0,
  pages_done: 0,
  pages_failed: 0,
  pages_skipped: 0,
  rows_found: 0,
  rows_with_email: 0,
  emails_found: 0,
  errors: [],
  started_at: null,
  finished_at: null,
});

let rescanState: RescanState = idleState();
export const rescanProgress = (): RescanState => ({ ...rescanState, errors: [...rescanState.errors] });

/** Pages fetched in the last 7 days are skipped so a rescan can resume after a timeout. */
const PAGE_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

export interface RescanOptions {
  scope?: "all" | "nigeria";
  categories?: ListSector[];
  limit?: number;
  force?: boolean;
  enrich?: boolean;
}

/**
 * Walk the worldwide catalog (or just Nigeria) and store every company row.
 * Fire-and-forget: the caller returns immediately and polls GET /pitch-targets/rescan.
 * A run never starts twice, and pages already fetched this week are skipped.
 */
export function startRescan(opts: RescanOptions = {}): RescanState {
  if (rescanState.status === "running") return { ...rescanState };
  rescanState = { ...idleState(), status: "running", scope: opts.scope ?? "all", started_at: nowIso() };
  void runRescan(opts).catch((e) => {
    rescanState.status = "error";
    rescanState.errors.push(String((e as Error).message ?? e));
    rescanState.finished_at = nowIso();
  });
  return { ...rescanState };
}

async function runRescan(opts: RescanOptions): Promise<void> {
  const pages = await discoverListPages(!!opts.force);
  let selected = pages;
  if (opts.scope === "nigeria") selected = selected.filter((p) => p.country.toLowerCase() === "nigeria");
  if (opts.categories?.length) selected = selected.filter((p) => !!p.sector && opts.categories!.includes(p.sector));
  if (opts.limit && opts.limit > 0) selected = selected.slice(0, opts.limit);
  rescanState.pages_total = selected.length;

  const fresh = opts.force ? new Set<string>() : new Set(
    (
      await all<{ name: string; last_run_at: string | null }>(
        `SELECT name, last_run_at FROM sources WHERE name LIKE 'pitch:page:%' AND last_run_at >= ?`,
        new Date(Date.now() - PAGE_FRESH_MS).toISOString()
      )
    ).map((r) => r.name.slice("pitch:page:".length))
  );

  let delay = 0;
  await pool(selected, 4, async (page) => {
    if (fresh.has(page.slug)) {
      rescanState.pages_skipped++;
      rescanState.pages_done++;
      return;
    }
    // polite spacing so 1,200 fetches do not look like a burst
    await new Promise((r) => setTimeout(r, delay));
    delay = (delay + 150) % 900;
    try {
      const rows = await ingestPage(page);
      rescanState.pages_done++;
      rescanState.rows_found += rows.length;
      rescanState.rows_with_email += rows.filter((r) => !!r.email && !r.email_derived).length;
    } catch (e) {
      rescanState.pages_done++;
      rescanState.pages_failed++;
      if (rescanState.errors.length < 20) rescanState.errors.push(`${page.slug}: ${(e as Error).message}`);
    }
  });

  await run(
    `INSERT INTO sources (name, last_run_at, items_found, error_streak, last_error)
     VALUES ('pitch:list:all', ?, ?, 0, NULL)
     ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at, items_found = excluded.items_found, error_streak = 0, last_error = NULL`,
    nowIso(),
    rescanState.rows_found
  );

  if (opts.enrich !== false) {
    rescanState.phase = "enrich";
    rescanState.emails_found += await enrichEmails({ limit: 4000 });
  }

  rescanState.status = "done";
  rescanState.finished_at = nowIso();
}

/* --------------------------- website email enrichment ---------------------- */

const FREE_DOMAINS = new Set(["gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "hotmail.com", "outlook.com", "live.com", "aol.com", "icloud.com", "mail.com", "ymail.com", "proton.me", "protonmail.com"]);

/** Strict, deliverability-shaped addresses only; junk like info@.example.com is out. */
const strictEmails = (html: string): string[] =>
  (html.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [])
    .map((e) => e.toLowerCase().replace(/[.,;]+$/, ""))
    .filter((e) => /^[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(e));

/**
 * Visit company websites and pick up the published inbox. Preference order:
 * mailto: link → non-free-domain address in the page → any strict address.
 * Only fills rows whose email is missing or a derived info@ guess.
 */
export async function enrichEmails(opts: { limit?: number; concurrency?: number } = {}): Promise<number> {
  const limit = opts.limit ?? 500;
  const rows = await all<{ external_id: string; website: string; email: string | null; email_derived: number }>(
    `SELECT external_id, website, email, email_derived FROM pitch_targets
     WHERE website IS NOT NULL AND website <> '' AND (email IS NULL OR email_derived = 1)
     ORDER BY fetched_at DESC LIMIT ?`,
    limit
  );
  let found = 0;
  await pool(rows, opts.concurrency ?? 4, async (r) => {
    try {
      const html = await fetchText(r.website, 9_000, 1);
      const all = strictEmails(html);
      const mailto = strictEmails((html.match(/mailto:([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/gi) ?? []).join(" "));
      const pick = mailto[0] ?? all.find((e) => !FREE_DOMAINS.has(e.split("@")[1])) ?? all[0];
      if (!pick) return;
      const wasGuess = !r.email || r.email_derived === 1;
      if (!wasGuess) return;
      await run(`UPDATE pitch_targets SET email = ?, email_derived = 0 WHERE external_id = ?`, pick, r.external_id);
      found++;
    } catch {
      /* site unreachable: keep the row as-is */
    }
  });
  return found;
}
