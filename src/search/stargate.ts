/**
 * Optional InfobelPro Stargate firmographics provider (§25.4).
 *
 * Only the one operation we need is implemented: POST /firmographics/v1/search
 * filtered to Nigeria with hasEmail, because an email is what a pitch needs.
 * Gated on STARGATE_API_KEY: without a key this module is never called, and the
 * pitch search stays on OpenStreetMap + curated lists.
 *
 * Reference: backend/openapi.yaml (Stargate OpenAPI 3.1) and the docs at
 * https://stargate.infobelpro.com/docs.
 */
import { config } from "../core/config";
import { run } from "../core/db";
import { nowIso } from "../util/id";

export const stargateEnabled = (): boolean => !!config.stargate.key;

/** Sector → free-text `who` term (searches business name, category and phone). */
export const SECTOR_KEYWORDS: Record<string, string> = {
  supermarket: "supermarket",
  airport: "airport",
  manufacturing: "manufacturing",
  company: "services",
  airline: "airline",
  port: "port terminal",
};

export interface StargateRow {
  external_id: string;
  name: string;
  sector: string;
  city: string;
  website: string | null;
  email: string | null;
  email_derived: 0 | 1;
  phone: string | null;
}

/**
 * One firmographics record → a pitch target row (pure; tested against the shape
 * documented in openapi.yaml). Returns null when the record carries no name.
 */
export function mapFirmographicsRecord(rec: any, sector: string): StargateRow | null {
  const name = (rec?.businessName ?? rec?.companyName ?? "").trim();
  if (!name) return null;
  const email = typeof rec.email === "string" && /@/.test(rec.email) ? rec.email.trim().split(/[\s,]+/)[0].toLowerCase() : null;
  const website = typeof rec.website === "string" && rec.website.trim() ? (/^https?:\/\//i.test(rec.website) ? rec.website : `https://${rec.website.trim()}`) : null;
  const city = (rec.city ?? "").trim() || "Nigeria";
  return {
    external_id: `stargate:${rec.uniqueID ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name,
    sector,
    city,
    website: website ?? (rec.webDomain ? `https://${rec.webDomain}` : null),
    email,
    email_derived: 0, // directory rows carry published emails
    phone: typeof rec.phone === "string" && rec.phone.trim() ? rec.phone.trim() : null,
  };
}

/**
 * Live firmographics search for Nigerian companies in a sector that have an email.
 * Throws on API errors; callers treat that as "provider unavailable, use cache".
 */
export async function stargateSearch(sector: string, city?: string, pageSize = 25): Promise<StargateRow[]> {
  if (!stargateEnabled()) return [];
  const body: Record<string, any> = {
    dataType: 1,
    pageSize,
    countryCodes: ["NG"],
    hasEmail: true,
    sortingOrder: [5],
  };
  const keyword = SECTOR_KEYWORDS[sector] ?? sector;
  if (keyword) body.who = keyword;
  if (city && city !== "all" && city !== "Nigeria") body.cityNames = [city];

  const res = await fetch(`${config.stargate.base}/firmographics/v1/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.stargate.key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Stargate HTTP ${res.status}`);
  const json = await res.json();
  const records = json?.data?.firstPageRecords ?? [];
  return records.map((r: any) => mapFirmographicsRecord(r, sector)).filter(Boolean) as StargateRow[];
}

/** Search + upsert into pitch_targets; returns how many rows were stored. */
export async function refreshStargate(sector: string, city: string): Promise<number> {
  if (!stargateEnabled()) return 0;
  const rows = await stargateSearch(sector, city);
  const now = nowIso();
  for (const r of rows) {
    await run(
      `INSERT INTO pitch_targets (external_id, name, sector, city, website, email, email_derived, phone, lat, lon, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(external_id) DO UPDATE SET name = excluded.name, city = excluded.city, website = excluded.website,
         email = excluded.email, phone = excluded.phone, fetched_at = excluded.fetched_at`,
      r.external_id, r.name, r.sector, r.city, r.website, r.email, r.email_derived, r.phone, now
    );
  }
  return rows.length;
}
