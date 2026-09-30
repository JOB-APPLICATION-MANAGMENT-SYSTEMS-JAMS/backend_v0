/** Ingestion pipeline types (§34.1). */

export interface RawPosting {
  source: string;
  external_id: string;
  title: string;
  company: string;
  location?: string | null;
  remote?: boolean;
  salary_min?: number | null;
  salary_max?: number | null;
  currency?: string | null;
  seniority?: string | null;
  employment_type?: string | null;
  category?: string;
  description?: string;
  keywords?: string[];
  url: string;
  posted_at?: string | null;
}

export interface JobSource {
  name: string;
  /** Free, no-key endpoints only (open decision: paid APIs excluded from v0). */
  fetch: () => Promise<RawPosting[]>;
}

export const norm = (s: string) =>
  (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(job|role|position|opening|vacancy|remote|work from home|wfh|fulltime|full time|part time)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** dedupe_key = norm(title) | norm(company) | location bucket (§34.3) */
export const dedupeKey = (title: string, company: string, location?: string | null) =>
  `${norm(title)}|${norm(company)}|${norm((location ?? "").split(",")[0] ?? "")}`;

const SENIORITY_RE = [
  { re: /\b(intern(ship)?|placement)\b/i, s: "intern" },
  { re: /\b(junior|jr\.?|entry|graduate|trainee)\b/i, s: "junior" },
  { re: /\b(mid|intermediate)\b/i, s: "mid" },
  { re: /\b(senior|sr\.?)\b/i, s: "senior" },
  { re: /\b(staff|principal|distinguished|lead)\b/i, s: "staff" },
];

export function inferSeniority(title: string, text = ""): string | null {
  for (const { re, s } of SENIORITY_RE) if (re.test(title)) return s;
  for (const { re, s } of SENIORITY_RE) if (re.test(text.slice(0, 400))) return s;
  return null;
}

export function normalize(raw: RawPosting, now = new Date()): Omit<RawPosting, "source" | "external_id"> & { dedupe_key: string; first_seen_at: string } {
  const text = raw.description ?? "";
  // feeds are loosely typed: Jobicy hands back objects where a string is declared,
  // and SQLite refuses to bind an object — coerce every scalar before it hits SQL
  const asText = (v: any): string | null =>
    v == null ? null : typeof v === "string" ? v.trim() || null : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v);
  const asNum = (v: any): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const location = asText(raw.location);
  return {
    title: raw.title.trim(),
    company: asText(raw.company) ?? "Unknown",
    location,
    remote: raw.remote ?? /remote|anywhere|worldwide/i.test(`${raw.location ?? ""} ${text.slice(0, 300)}`),
    salary_min: asNum(raw.salary_min),
    salary_max: asNum(raw.salary_max),
    currency: asText(raw.currency),
    seniority: asText(raw.seniority) ?? inferSeniority(raw.title, text),
    employment_type: asText(raw.employment_type),
    category: raw.category ?? "software_engineering",
    description: (text ?? "").slice(0, 12000),
    keywords: raw.keywords ?? [],
    url: asText(raw.url) ?? "",
    posted_at: asText(raw.posted_at),
    dedupe_key: dedupeKey(raw.title, asText(raw.company) ?? "Unknown", location),
    first_seen_at: now.toISOString(),
  };
}
