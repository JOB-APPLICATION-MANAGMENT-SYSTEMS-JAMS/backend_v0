/**
 * Curated Nigerian contact lists (§25.4): published HTML tables of companies with
 * official emails, scraped live from lca.logcluster.org. These cover sectors where
 * OSM is thin (airlines, port terminals) and the emails are the whole point: the
 * pitch cannot be sent without one.
 *
 * Parser is deliberately regex-based (no cheerio): tables are flat, cells are
 * `<td><p>text</p></td>` with `&nbsp;` padding and inline links.
 */
import { run } from "../core/db";
import { nowIso } from "../util/id";

export type ListSector = "airline" | "port";

/** Slug on lca.logcluster.org per sector. More lists can be appended here. */
export const LIST_SOURCES: Record<ListSector, string> = {
  airline: "45-nigeria-airport-companies-contact-list",
  port: "44-nigeria-port-and-waterways-company-contact-list",
};

export const LIST_SECTORS = Object.keys(LIST_SOURCES) as ListSector[];

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) JAMS-Ingest/0.1" };

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
 */
export function parseContactList(html: string, sector: ListSector): ListRow[] {
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]);
  const out: ListRow[] = [];
  const seen = new Set<string>();

  for (const table of tables) {
    for (const tr of [...table.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((m) => m[0])) {
      const cells = [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => decode(m[1]));
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
      // The lists mix columns (a website cell can hold info@..., the email cell can
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
      // website: first whitespace-delimited token, entities and trailing punctuation stripped
      const siteToken = (siteCell ?? "")
        .split(/\s/)[0]
        .replace(/&[a-z0-9]*;?$/i, "")
        .replace(/[.,;]+$/, "");
      const website = looksLikeSite(siteToken) ? (/^https?:\/\//i.test(siteToken) ? siteToken : `https://${siteToken}`) : null;
      const derived = !email && website;
      if (!email && !website) continue; // nothing to pitch at on a curated list

      out.push({
        external_id: `list:${sector}:${slugName(name)}`,
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

/** Fetch a list page and parse it; throws on network/HTTP failure. */
export async function fetchContactList(sector: ListSector): Promise<ListRow[]> {
  const res = await fetch(`https://lca.logcluster.org/${LIST_SOURCES[sector]}`, { headers: UA, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`logcluster HTTP ${res.status} (${sector})`);
  return parseContactList(await res.text(), sector);
}

/** Fetch + upsert into pitch_targets; returns how many rows were stored. */
export async function refreshContactList(sector: ListSector): Promise<number> {
  const rows = await fetchContactList(sector);
  const now = nowIso();
  for (const r of rows) {
    await run(
      `INSERT INTO pitch_targets (external_id, name, sector, city, website, email, email_derived, phone, lat, lon, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(external_id) DO UPDATE SET name = excluded.name, city = excluded.city, website = excluded.website,
         email = excluded.email, email_derived = excluded.email_derived, phone = excluded.phone, fetched_at = excluded.fetched_at`,
      r.external_id, r.name, r.sector, r.city, r.website, r.email, r.email_derived, r.phone, now
    );
  }
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
