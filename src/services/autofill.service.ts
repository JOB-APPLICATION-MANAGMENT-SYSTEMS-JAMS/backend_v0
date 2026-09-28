import { all, get, run, parseJson } from "../core/db";
import { newId, nowIso } from "../util/id";

/**
 * Autofill (§35.2) — field matching with confidence tiers.
 * Pipeline: autocomplete hint → name/id tokens → label similarity → learned history.
 * ≥0.85 fill (green) · 0.55–0.85 fill (amber) · <0.55 leave empty (§35.2).
 */

export interface DetectedField {
  name?: string;
  id?: string;
  label?: string;
  autocomplete?: string;
  placeholder?: string;
  type?: string;
  section?: string;
}

interface Mapping {
  key: string;
  value: string;
  confidence: number;
  method: string;
}

/** Alias dictionary: profile key → phrasings (§19.3 field aliases). */
const BASE_ALIASES: Record<string, string[]> = {
  "identity.full_name": ["full name", "name", "your name", "first and last name", "legal name", "candidate name"],
  "identity.first_name": ["first name", "given name", "fname"],
  "identity.last_name": ["last name", "surname", "family name", "lname"],
  "identity.email": ["email", "email address", "e-mail", "contact email"],
  "identity.phone": ["phone", "phone number", "mobile", "telephone", "contact number"],
  "identity.location": ["location", "city", "address", "where are you based", "current location"],
  "identity.linkedin": ["linkedin", "linkedin url", "linkedin profile", "linkedin profile url"],
  "identity.github": ["github", "github url", "github profile"],
  "identity.website": ["website", "portfolio", "personal site", "homepage"],
  "identity.headline": ["headline", "current position", "title", "about you", "profile summary"],
  "identity.work_authorization": ["work authorization", "authorised to work", "authorized to work", "visa status", "right to work"],
  "identity.salary_expectation": ["salary expectation", "expected salary", "desired salary", "compensation"],
  "posting.url": ["job url", "posting url", "job link", "requisition url"],
  "posting.role": ["job title", "position", "role", "title of role", "what position are you applying for", "job title applied for"],
};

const AUTOCOMPLETE_MAP: Record<string, { key: string; confidence: number }> = {
  name: { key: "identity.full_name", confidence: 0.98 },
  "given-name": { key: "identity.first_name", confidence: 0.98 },
  "family-name": { key: "identity.last_name", confidence: 0.98 },
  email: { key: "identity.email", confidence: 0.99 },
  tel: { key: "identity.phone", confidence: 0.97 },
  "tel-national": { key: "identity.phone", confidence: 0.9 },
  "street-address": { key: "identity.location", confidence: 0.8 },
  address_level2: { key: "identity.location", confidence: 0.75 },
  url: { key: "identity.website", confidence: 0.7 },
  organization: { key: "identity.headline", confidence: 0.6 },
  "organization-title": { key: "posting.role", confidence: 0.6 },
};

/** What the extension can read: field keys + aliases + visibility flags (§35 GET /autofill/schema). */
export function autofillSchema(userId: string) {
  const p = get<any>("SELECT * FROM profiles WHERE user_id = ?", userId);
  const identity: any = p ? parseJson(p.identity, {}) : {};
  const aliases: any = p ? parseJson(p.aliases, {}) : {};
  const merged: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(BASE_ALIASES)) merged[k] = [...v, ...(aliases[k] ?? [])];
  const values: Record<string, string> = {
    "identity.full_name": identity.name ?? "",
    "identity.first_name": identity.first_name ?? (identity.name ?? "").split(" ")[0] ?? "",
    "identity.last_name": identity.last_name ?? (identity.name ?? "").split(" ").slice(1).join(" "),
    "identity.email": identity.email ?? "",
    "identity.phone": identity.phone ?? "",
    "identity.location": identity.location ?? "",
    "identity.linkedin": identity.links?.linkedin ?? "",
    "identity.github": identity.links?.github ?? "",
    "identity.website": identity.links?.website ?? identity.links?.portfolio ?? "",
    "identity.headline": identity.headline ?? "",
    "identity.work_authorization": identity.work_authorization ?? "",
    "identity.salary_expectation": identity.salary_expectation ? String(identity.salary_expectation) : "",
  };
  return {
    fields: Object.keys(merged).map((key) => ({ key, aliases: merged[key], value: values[key] ?? null, visible: identity.visibility?.[key] !== false })),
    guardrails: { never_fill: ["password", "credit_card", "ssn", "cvv"], kill_switch: "settings.autofill_enabled" },
    confidence_policy: { auto_fill: 0.85, fill_flagged: 0.55 },
  };
}

/** Simple token similarity in [0,1] (rapidfuzz-free, deterministic). */
export function similarity(a: string, b: string): number {
  const A = a.toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim();
  const B = b.toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim();
  if (!A || !B) return 0;
  if (A === B) return 1;
  const ta = new Set(A.split(/\s+/));
  const tb = new Set(B.split(/\s+/));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const jaccard = inter / Math.max(1, new Set([...ta, ...tb]).size);
  // bigram dice for substring-y labels
  const bigrams = (s: string) => {
    const out: string[] = [];
    for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
    return out;
  };
  const ga = bigrams(A);
  const gb = bigrams(B);
  const gi = ga.filter((g) => gb.includes(g)).length;
  const dice = ga.length && gb.length ? (2 * gi) / (ga.length + gb.length) : 0;
  return Math.max(jaccard, dice);
}

const isPassword = (f: DetectedField) => /password|passwd|pwd/i.test(`${f.name ?? ""} ${f.id ?? ""} ${f.autocomplete ?? ""} ${f.type ?? ""}`) || f.type === "password";

/** Server-side field matching — easily improved in one place (§35 autofill/match). */
export function matchFields(userId: string, host: string, fields: DetectedField[]): { mappings: Mapping[]; skipped: string[] } {
  const schema = autofillSchema(userId);
  const values = new Map(schema.fields.map((f) => [f.key, f.value ?? ""]));
  const history = new Map(
    all<any>("SELECT field_signature, profile_key FROM field_history WHERE user_id = ? AND host = ?", userId, host).map((h) => [h.field_signature, h.profile_key])
  );

  const mappings: Mapping[] = [];
  const skipped: string[] = [];

  for (const f of fields) {
    if (isPassword(f)) {
      skipped.push(f.name ?? f.id ?? "password");
      continue; // guardrail: never fill password fields (§35.2)
    }
    const signature = `${f.name ?? ""}|${f.autocomplete ?? ""}|${(f.label ?? "").toLowerCase().slice(0, 40)}`;
    let best: { key: string; confidence: number; method: string } | null = null;

    // 1. learned history (strongest: starts at 0.99)
    const learned = history.get(signature);
    if (learned) best = { key: learned, confidence: 0.99, method: "history" };

    // 2. autocomplete hint
    if (!best && f.autocomplete && AUTOCOMPLETE_MAP[f.autocomplete]) {
      const m = AUTOCOMPLETE_MAP[f.autocomplete];
      best = { key: m.key, confidence: m.confidence, method: "autocomplete" };
    }

    // 3. name/id token match
    if (!best && (f.name || f.id)) {
      const tokens = `${f.name ?? ""} ${f.id ?? ""}`.toLowerCase().replace(/[_-]/g, " ");
      for (const [key, aliases] of Object.entries(BASE_ALIASES)) {
        for (const alias of aliases) {
          if (tokens.includes(alias.split(" ")[0]) && alias.split(" ").every((w) => tokens.includes(w))) {
            best = { key, confidence: 0.9, method: "name" };
            break;
          }
        }
        if (best) break;
      }
    }

    // 4. label similarity ≥ 0.55 (spec: rapidfuzz ≥ 85/100 on well-formed labels)
    if (!best && f.label) {
      for (const [key, aliases] of Object.entries(BASE_ALIASES)) {
        for (const alias of aliases) {
          const s = similarity(f.label, alias);
          if (s >= 0.55 && (!best || s > best.confidence)) best = { key, confidence: Number(s.toFixed(2)), method: "label" };
        }
      }
    }

    if (!best || !values.get(best.key)) {
      skipped.push(f.label ?? f.name ?? "unknown");
      continue;
    }
    mappings.push({ key: best.key, value: values.get(best.key)!, confidence: Math.min(1, best.confidence), method: best.method });
  }

  return { mappings, skipped };
}

/** Confirmed fill → learned mapping (§35.2 “gets smarter” loop). */
export function confirmMapping(userId: string, host: string, fieldSignature: string, profileKey: string) {
  run(
    `INSERT INTO field_history (id, user_id, host, field_signature, profile_key, confirmed_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, host, field_signature) DO UPDATE SET profile_key = excluded.profile_key, confirmed_at = excluded.confirmed_at`,
    newId(),
    userId,
    host,
    fieldSignature,
    profileKey,
    nowIso()
  );
  return { learned: true };
}
