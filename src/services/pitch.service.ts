/**
 * Pitch-first company search (§25.4): find Nigerian businesses that probably have
 * no software opening but still need software help, plus an email to pitch at.
 *
 * Data is live from OpenStreetMap's Overpass API (free, no key) covering Lagos,
 * Abuja/FCT and Ogun: supermarkets, airports, manufacturers and company offices.
 * Emails come from published contact tags when present, otherwise they are
 * derived as info@domain from the company website and flagged `email_derived`
 * so the UI can be honest about the guess.
 */
import { all, get, run } from "../core/db";
import { notFound, validation } from "../core/errors";
import { newId, nowIso } from "../util/id";
import { createOutreach, PITCH_SUBJECT, PITCH_BODY } from "./outreach.service";

export type Sector = "supermarket" | "airport" | "manufacturing" | "company";

export const SECTORS: Sector[] = ["supermarket", "airport", "manufacturing", "company"];

export const SECTOR_LABELS: Record<Sector, string> = {
  supermarket: "Supermarkets & retail",
  airport: "Airports & aviation",
  manufacturing: "Manufacturing & industry",
  company: "Company offices",
};

/** Bounding boxes are (south, west, north, east), Overpass order. */
export const CITIES = {
  lagos: { label: "Lagos", bbox: [6.35, 3.28, 6.72, 3.68] as const },
  abuja: { label: "Abuja (FCT)", bbox: [8.4, 6.7, 9.4, 7.7] as const },
  ogun: { label: "Ogun", bbox: [6.45, 2.65, 7.15, 3.45] as const },
} as const;

export type CityKey = keyof typeof CITIES;
export const CITY_KEYS = Object.keys(CITIES) as CityKey[];

/** Tag filters per sector; a sector maps to one or more OSM tag matchers. */
const SECTOR_TAGS: Record<Sector, string[]> = {
  supermarket: [`["shop"="supermarket"]`, `["shop"="convenience"]`],
  airport: [`["aeroway"="aerodrome"]`],
  manufacturing: [`["industrial"="manufacturing"]`, `["industrial"="factory"]`, `["craft"="manufacturer"]`, `["man_made"="factory"]`],
  company: [`["office"="company"]`, `["office"="it"]`, `["office"="telecommunication"]`],
};

/** Build the Overpass QL for a city/sector pair. Pure, so tests can assert it. */
export function overpassQuery(city: CityKey, sector: Sector, timeout = 20): string {
  const [s, w, n, e] = CITIES[city].bbox;
  const branches = SECTOR_TAGS[sector]
    .map((tag) => `  node(${s},${w},${n},${e})${tag};\n  way(${s},${w},${n},${e})${tag};`)
    .join("\n");
  return `[out:json][timeout:${timeout}];\n(\n${branches}\n);\nout tags center 300;`;
}

/** Published website → bare domain (https://www.acme.com/ng → acme.com). */
export function domainOf(website: string): string | null {
  const raw = website.trim().replace(/^mailto:/i, "");
  if (!raw) return null;
  try {
    const u = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./i, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Derive the classic official inbox from a domain; null when impossible. */
export function deriveEmail(website: string | null | undefined): { email: string | null; derived: boolean } {
  if (!website) return { email: null, derived: false };
  if (/^mailto:/i.test(website.trim())) return { email: website.trim().slice(7), derived: false };
  const d = domainOf(website);
  return d ? { email: `info@${d}`, derived: true } : { email: null, derived: false };
}

const TAG = (t: any, ...keys: string[]): string | null => {
  for (const k of keys) {
    const v = t[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
};

/**
 * One Overpass element → a pitch target row. Named entities are kept even without
 * contact details: a company with no published email is still a lead (open the site,
 * find the inbox), and dropping them made whole sectors look empty.
 */
export function normalizeElement(el: any, city: CityKey, sector: Sector): any | null {
  const t = el?.tags ?? {};
  const name = TAG(t, "name", "name:en", "brand", "operator");
  if (!name) return null;
  const website = TAG(t, "contact:website", "website", "brand:website", "url");
  const publishedEmail = TAG(t, "contact:email", "email");
  const derived = publishedEmail ? { email: publishedEmail, derived: false } : deriveEmail(website);
  return {
    external_id: `${el.type}/${el.id}`,
    name,
    sector,
    city: CITIES[city].label,
    website: website ?? null,
    email: derived.email,
    email_derived: derived.email && derived.derived ? 1 : 0,
    phone: TAG(t, "contact:phone", "phone") ?? null,
    lat: el.lat ?? el.center?.lat ?? null,
    lon: el.lon ?? el.center?.lon ?? null,
  };
}

/**
 * Talk to Overpass; returns raw JSON elements. The main instance rate-limits and
 * occasionally serves HTML runtime errors, so we fall through to a community mirror
 * before giving up.
 */
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
];

export async function fetchOverpass(query: string, endpoint?: string): Promise<any[]> {
  const endpoints = endpoint ? [endpoint] : OVERPASS_ENDPOINTS;
  let lastError: Error | null = null;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "JAMS-Ingest/0.1 (personal job tracker)" },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(25_000),
      });
      if (res.status === 429 || res.status === 504 || res.status === 502) throw new Error(`Overpass busy HTTP ${res.status} (${url})`);
      if (!res.ok) throw new Error(`Overpass HTTP ${res.status} (${url})`);
      const json = await res.json(); // throws on the HTML error pages Overpass serves when unhappy
      if (Array.isArray(json?.elements)) return json.elements;
      throw new Error(`Overpass malformed response (${url})`);
    } catch (e) {
      lastError = e as Error;
      console.warn(`[pitch] overpass endpoint failed: ${(e as Error).message}`);
    }
  }
  throw lastError ?? new Error("Overpass unreachable");
}

const FRESH_MS = 24 * 60 * 60 * 1000;

async function refreshCitySector(city: CityKey, sector: Sector): Promise<void> {
  const elements = await fetchOverpass(overpassQuery(city, sector));
  const now = nowIso();
  let kept = 0;
  for (const el of elements) {
    const row = normalizeElement(el, city, sector);
    if (!row) continue;
    kept++;
    await run(
      `INSERT INTO pitch_targets (external_id, name, sector, city, website, email, email_derived, phone, lat, lon, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(external_id) DO UPDATE SET name = excluded.name, sector = excluded.sector, city = excluded.city,
         website = excluded.website, email = excluded.email, email_derived = excluded.email_derived,
         phone = excluded.phone, lat = excluded.lat, lon = excluded.lon, fetched_at = excluded.fetched_at`,
      row.external_id, row.name, row.sector, row.city, row.website, row.email, row.email_derived, row.phone, row.lat, row.lon, now
    );
  }
  await run(
    `INSERT INTO sources (name, last_run_at, items_found, error_streak, last_error)
     VALUES (?, ?, ?, 0, NULL)
     ON CONFLICT(name) DO UPDATE SET last_run_at = excluded.last_run_at, items_found = excluded.items_found, error_streak = 0, last_error = NULL`,
    `pitch:${city}:${sector}`,
    now,
    kept
  );
}

export interface PitchSearchParams {
  sector?: Sector;
  city?: CityKey | "all";
  q?: string;
  refresh?: boolean;
  page?: number;
  page_size?: number;
}

/** Cached-then-live search over pitch targets; refreshes stale city/sector pairs. */
export async function searchPitchTargets(p: PitchSearchParams = {}) {
  const sector = p.sector ?? "supermarket";
  if (!SECTORS.includes(sector)) throw validation("Unknown sector");
  const cities: CityKey[] = p.city === "all" || !p.city ? CITY_KEYS : [p.city];
  if (p.city && p.city !== "all" && !CITY_KEYS.includes(p.city as CityKey)) throw validation("Unknown city");

  for (let i = 0; i < cities.length; i++) {
    const city = cities[i];
    // space the fetches: Overpass rate-limits bursty anonymous clients
    if (i > 0) await new Promise((r) => setTimeout(r, 1500));
    // staleness is judged by the last RUN, not row count: a genuinely empty
    // city/sector must not re-trigger Overpass on every request
    const src = await get<{ last_run_at: string | null }>(`SELECT last_run_at FROM sources WHERE name = ?`, `pitch:${city}:${sector}`);
    const ranRecently = !!src?.last_run_at && Date.now() - Date.parse(src.last_run_at) < FRESH_MS;
    if (p.refresh || !ranRecently) {
      try {
        await refreshCitySector(city, sector);
      } catch (e) {
        // Overpass hiccup: serve stale cache if we have it, surface the error otherwise
        const stale = await get<{ n: number }>(`SELECT count(*) AS n FROM pitch_targets WHERE sector = ? AND city = ?`, sector, CITIES[city].label);
        if (!stale?.n) throw e;
        console.warn(`[pitch] refresh failed for ${city}/${sector}, serving cache:`, (e as Error).message);
      }
    }
  }

  const page = Math.max(1, Number(p.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(p.page_size ?? 50)));
  const where = [`sector = ?`, `city IN (${cities.map(() => "?").join(",")})`];
  const args: any[] = [sector, ...cities.map((c) => CITIES[c].label)];
  if (p.q?.trim()) {
    where.push(`lower(name) LIKE ?`);
    args.push(`%${p.q.trim().toLowerCase()}%`);
  }
  const whereSql = where.join(" AND ");
  const total = (await get<{ n: number }>(`SELECT count(*) AS n FROM pitch_targets WHERE ${whereSql}`, ...args))!.n;
  const items = await all(
    `SELECT * FROM pitch_targets WHERE ${whereSql} ORDER BY email_derived ASC, name ASC LIMIT ? OFFSET ?`,
    ...args,
    pageSize,
    (page - 1) * pageSize
  );
  return {
    items,
    sector,
    cities: cities.map((c) => CITIES[c].label),
    pagination: { page, page_size: pageSize, total_count: total, total_pages: Math.max(1, Math.ceil(total / pageSize)) },
  };
}

/**
 * One click: company + contact + pitch application + outreach draft, ready to send.
 * Everything stays a draft until the send endpoint is called (§26.1 confirm rule).
 */
export async function preparePitch(userId: string, externalId: string) {
  const target = await get<any>(`SELECT * FROM pitch_targets WHERE external_id = ?`, externalId);
  if (!target) throw notFound("Pitch target");
  if (!target.email) throw validation("No email available for this company");

  // company (idempotent by name)
  let company = await get<any>(`SELECT id FROM companies WHERE user_id = ? AND lower(name) = ?`, userId, target.name.toLowerCase());
  let companyId = company?.id as string | undefined;
  if (!companyId) {
    companyId = newId();
    await run(
      `INSERT INTO companies (id, user_id, name, domain, tier, careers_url, stack, created_at, updated_at) VALUES (?, ?, ?, ?, 'reach', ?, '[]', ?, ?)`,
      companyId, userId, target.name, target.website ? domainOf(target.website) : null, target.website, nowIso(), nowIso()
    );
  }

  // contact (idempotent by email)
  let contact = await get<any>(`SELECT id FROM contacts WHERE user_id = ? AND lower(email) = ?`, userId, target.email.toLowerCase());
  let contactId = contact?.id as string | undefined;
  if (!contactId) {
    contactId = newId();
    await run(
      `INSERT INTO contacts (id, user_id, company_id, name, role, email, source_note, never_contact, created_at)
       VALUES (?, ?, ?, 'General enquiries', ?, ?, ?, 0, ?)`,
      contactId, userId, companyId, SECTOR_LABELS[target.sector as Sector] ?? null, target.email,
      `OpenStreetMap ${target.sector}${target.email_derived ? " (derived)" : ""}`, nowIso()
    );
  }

  const appId = newId();
  const now = nowIso();
  await run(
    `INSERT INTO applications (id, user_id, company_id, contact_id, kind, status, role_title, company_name, source, url, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pitch', 'saved', ?, ?, 'pitch_target', ?, ?, ?)`,
    appId, userId, companyId, contactId, `Software help pitch`, target.name, target.website, now, now
  );

  const msg = await createOutreach(userId, { app_id: appId, contact_id: contactId, subject: PITCH_SUBJECT, body: PITCH_BODY });

  return {
    application_id: appId,
    outreach_id: (msg as any).id,
    company: { id: companyId, name: target.name },
    contact: { id: contactId, email: target.email, email_derived: !!target.email_derived },
    target,
  };
}
