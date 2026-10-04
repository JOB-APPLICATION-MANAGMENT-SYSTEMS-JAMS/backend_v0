import { all, get, run, parseJson } from "../core/db";
import { newId, nowIso } from "../util/id";
import { reconcileIdentity } from "./profile.service";

/**
 * Autofill (§35.2), field matching with confidence tiers.
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
  /** position of the detected field in the request, so the extension can line results up */
  field_index: number;
}

/** Alias dictionary: profile key → phrasings (§19.3 field aliases). */
const BASE_ALIASES: Record<string, string[]> = {
  "identity.full_name": ["full name", "name", "your name", "first and last name", "legal name", "candidate name"],
  "identity.first_name": ["first name", "given name", "fname", "preferred name", "preferred first name"],
  "identity.last_name": ["last name", "surname", "family name", "lname", "family surname"],
  "identity.middle_name": ["middle name", "middle initial", "second name"],
  "identity.email": ["email", "email address", "e-mail", "contact email"],
  "identity.phone": ["phone", "phone number", "mobile", "telephone", "contact number"],
  "identity.location": ["location", "where are you based", "current location"],
  "identity.linkedin": ["linkedin", "linkedin url", "linkedin profile", "linkedin profile url"],
  "identity.github": ["github", "github url", "github profile"],
  "identity.website": ["website", "portfolio", "personal site", "homepage"],
  "identity.headline": ["headline", "current position", "title", "about you", "profile summary"],
  "identity.work_authorization": ["work authorization", "authorised to work", "authorized to work", "visa status", "right to work", "legally authorized to work", "legally authorised to work", "work eligibility", "authorized to work in the united states"],
  "identity.sponsorship": ["sponsorship", "require sponsorship", "requires sponsorship", "visa sponsorship", "sponsor employment visa", "employment visa status", "sponsor you", "h-1b", "tn visa"],
  "identity.relocation": ["relocate", "relocation", "willing to relocate", "need to relocate", "live locally", "come in to the office", "days per week"],
  "identity.salary_expectation": ["salary expectation", "expected salary", "desired salary", "compensation"],
  "identity.graduation_year": ["graduating", "graduation year", "anticipate graduating", "expected graduation", "grad year", "graduation date"],
  "identity.school": ["school", "university", "college", "institution", "school name"],
  "identity.degree": ["degree", "degree type", "degree program"],
  "identity.field_of_study": ["discipline", "field of study", "major", "concentration"],
  "identity.heard_about": ["how did you hear", "where did you hear", "heard about this", "how did you find", "source"],
  // Career-portal demographics (Qore/AppZone-style applications). gender is
  // sensitive: it only ever fills from an explicit saved answer (see matchFields).
  "identity.date_of_birth": ["date of birth", "dob", "birth date", "birthday"],
  "identity.marital_status": ["marital status", "marital"],
  "identity.gender": ["gender", "sex"],
  "identity.nationality": ["nationality"],
  "identity.religion": ["religion"],
  "identity.hobbies": ["hobbies", "hobby", "interests"],
  // granular address — "Address" routes to street (falls back to location),
  // "City" to city (same fallback), so older profiles keep filling as before
  "identity.street": ["street", "address line 1", "address"],
  "identity.city": ["city", "town"],
  "identity.state": ["state", "province", "state/province", "region"],
  "identity.country": ["country"],
  "identity.zip": ["zip", "zip/postal code", "postal code", "postcode"],
  // education extras
  "identity.grade": ["grade", "degree class", "class of degree"],
  "identity.cgpa": ["cgpa", "gpa"],
  "identity.other_qualifications": ["other qualifications", "other qualifications obtained"],
  // experience & employment (the portal typo 'Currrent' is a real field label)
  "identity.experience_years": ["experience in years", "years of experience", "experience years", "total experience"],
  "identity.experience_months": ["experience in months", "months of experience", "experience months"],
  "identity.current_employer": ["current employer", "present employer", "current company"],
  "identity.current_job_role": ["current job role", "currrent job role", "current role", "current designation", "current title"],
  "identity.current_responsibilities": ["job responsibilities (current)", "responsibilities (current)", "current responsibilities"],
  "identity.previous_employer": ["previous employer", "prior employer", "last employer", "former employer"],
  "identity.previous_job_role": ["previous job role", "prior job role", "last job role"],
  "identity.previous_responsibilities": ["job responsibilities (previous)", "responsibilities (previous)", "previous responsibilities"],
  "identity.current_salary": ["current salary", "current salary (per annum)", "present salary"],
  // referees — numbered aliases win on numbered labels; key 1 also carries the
  // unnumbered phrasings so a bare "Referee Name" defaults to referee 1
  "identity.referee1_name": ["referee name 1", "referee 1 name", "referee name", "referee"],
  "identity.referee1_email": ["referee email 1", "referee email"],
  "identity.referee1_phone": ["referee phone 1", "referee mobile number 1", "referee phone", "referee mobile number"],
  "identity.referee1_address": ["referee address 1", "referee address"],
  "identity.referee2_name": ["referee name 2", "referee 2 name"],
  "identity.referee2_email": ["referee email 2"],
  "identity.referee2_phone": ["referee phone 2", "referee mobile number 2"],
  "identity.referee2_address": ["referee address 2"],
  "identity.facebook": ["facebook", "fb url"],
  "identity.twitter": ["twitter", "x (formerly twitter)", "x profile", "x handle"],
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
export async function autofillSchema(userId: string) {
  const p = await get<any>("SELECT * FROM profiles WHERE user_id = ?", userId);
  // reconcile first/last/full from whichever name key holds it, and fall back to
  // the account email — an untouched profile should still fill its email field
  const identity: any = p ? reconcileIdentity(parseJson(p.identity, {})) : {};
  const u = await get<any>("SELECT email FROM users WHERE id = ?", userId);
  if (u?.email && !identity.email) identity.email = u.email;
  const aliases: any = p ? parseJson(p.aliases, {}) : {};
  // education lives in its own table; the first row answers school/degree/discipline
  // selects — but an answer edited on /autofill (saved into identity) wins, so the
  // candidate's explicit edit is never silently overridden by the seeded row
  const edu: any[] = p ? await all<any>("SELECT * FROM profile_education WHERE profile_id = ? ORDER BY sort_order LIMIT 1", p.id) : [];
  const e0 = edu[0];
  const merged: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(BASE_ALIASES)) merged[k] = [...v, ...(aliases[k] ?? [])];
  const values: Record<string, string> = {
    "identity.full_name": identity.name || identity.full_name || "",
    "identity.first_name": identity.first_name || (identity.name || "").split(" ")[0] || "",
    "identity.last_name": identity.last_name || (identity.name || "").split(" ").slice(1).join(" ") || "",
    "identity.email": identity.email ?? "",
    "identity.phone": identity.phone ?? "",
    "identity.location": identity.location ?? "",
    "identity.linkedin": identity.links?.linkedin ?? "",
    "identity.github": identity.links?.github ?? "",
    "identity.website": identity.links?.website ?? identity.links?.portfolio ?? "",
    "identity.headline": identity.headline ?? "",
    "identity.work_authorization": identity.work_authorization ?? "",
    "identity.sponsorship": identity.sponsorship ?? "",
    "identity.relocation": identity.relocation ?? "",
    "identity.salary_expectation": identity.salary_expectation ? String(identity.salary_expectation) : "",
    "identity.middle_name": identity.middle_name ?? "",
    "identity.graduation_year": identity.graduation_year ? String(identity.graduation_year) : "",
    "identity.school": identity.school || e0?.school || "",
    "identity.degree": identity.degree || e0?.degree || "",
    "identity.field_of_study": identity.field_of_study || e0?.field || "",
    "identity.heard_about": identity.heard_about ?? "",
    "identity.date_of_birth": identity.date_of_birth ?? "",
    "identity.marital_status": identity.marital_status ?? "",
    "identity.gender": identity.gender ?? "",
    "identity.nationality": identity.nationality ?? "",
    "identity.religion": identity.religion ?? "",
    "identity.hobbies": identity.hobbies ?? "",
    // Address/City fall back to the one-line location so profiles that only
    // filled "Location" keep answering those portal fields exactly as before
    "identity.street": identity.street || identity.location || "",
    "identity.city": identity.city || identity.location || "",
    "identity.state": identity.state ?? "",
    "identity.country": identity.country ?? "",
    "identity.zip": identity.zip ?? "",
    "identity.grade": identity.grade ?? "",
    "identity.cgpa": identity.cgpa ?? "",
    "identity.other_qualifications": identity.other_qualifications ?? "",
    "identity.experience_years": identity.experience_years ?? "",
    "identity.experience_months": identity.experience_months ?? "",
    "identity.current_employer": identity.current_employer ?? "",
    "identity.current_job_role": identity.current_job_role ?? "",
    "identity.current_responsibilities": identity.current_responsibilities ?? "",
    "identity.previous_employer": identity.previous_employer ?? "",
    "identity.previous_job_role": identity.previous_job_role ?? "",
    "identity.previous_responsibilities": identity.previous_responsibilities ?? "",
    "identity.current_salary": identity.current_salary ?? "",
    "identity.referee1_name": identity.referee1_name ?? "",
    "identity.referee1_email": identity.referee1_email ?? "",
    "identity.referee1_phone": identity.referee1_phone ?? "",
    "identity.referee1_address": identity.referee1_address ?? "",
    "identity.referee2_name": identity.referee2_name ?? "",
    "identity.referee2_email": identity.referee2_email ?? "",
    "identity.referee2_phone": identity.referee2_phone ?? "",
    "identity.referee2_address": identity.referee2_address ?? "",
    "identity.facebook": identity.links?.facebook ?? "",
    "identity.twitter": identity.links?.twitter ?? "",
  };
  // Custom Q&A from the /autofill page: profile.autofill_answers =
  // [{ match: "question snippet", answer: "your answer" }] — each becomes a
  // matchable key so recurring exam questions answer themselves verbatim.
  const answers = Array.isArray(identity.autofill_answers) ? identity.autofill_answers : [];
  for (const [i, a] of answers.entries()) {
    const m = String(a?.match ?? "").trim();
    const ans = String(a?.answer ?? "").trim();
    if (!m || !ans) continue;
    merged[`custom.answer_${i}`] = [m];
    values[`custom.answer_${i}`] = ans;
  }
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

/** EEOC / voluntary self-identification: never auto-answer (human choice, §35.2 guardrail). */
const isSelfIdentification = (label: string) =>
  /disabilit|veteran|race\b|racial|ethnic|hispanic|latino|latinx|gender|sex\b|sexual orientation|transgender|non.?binary|self.?identif/i.test(label);

/**
 * Sensitive self-ID keys: we never *infer* these (§35.2), but if the candidate
 * explicitly saved an answer in their own profile we fill exactly that — it is
 * their stated choice, same as any other answer. Word-boundary match only, so
 * "transgender" never receives the gender value.
 */
const SENSITIVE_KEYS = ["identity.gender"];
const sensitiveAnswer = (label: string, aliasMap: Map<string, string[]>, values: Map<string, string>) => {
  const L = normalize(label);
  for (const key of SENSITIVE_KEYS) {
    const v = values.get(key);
    if (!v) continue;
    for (const a of aliasMap.get(key) ?? []) {
      const n = normalize(a);
      if (!n) continue;
      if (L === n || new RegExp(`\\b${n}\\b`).test(L)) return { key, value: v };
    }
  }
  return null;
};

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Server-side field matching, easily improved in one place (§35 autofill/match). */
export async function matchFields(userId: string, host: string, fields: DetectedField[]): Promise<{ mappings: Mapping[]; skipped: string[]; skip_reasons: { field: string; reason: string }[] }> {
  const schema = await autofillSchema(userId);
  const values = new Map(schema.fields.map((f) => [f.key, f.value ?? ""]));
  // merged alias map (base + profile-edited aliases + custom answers) — the
  // profile page's alias editor used to be decorative; matching now reads it
  const aliasMap = new Map<string, string[]>(schema.fields.map((f) => [f.key, f.aliases ?? []]));
  const isCustom = (key: string) => key.startsWith("custom.");
  const history = new Map(
    (await all<any>("SELECT field_signature, profile_key FROM field_history WHERE user_id = ? AND host = ?", userId, host)).map((h) => [h.field_signature, h.profile_key])
  );

  const mappings: Mapping[] = [];
  const skipped: string[] = [];
  const skip_reasons: { field: string; reason: string }[] = [];
  const skip = (field: string, reason: string) => {
    skipped.push(field);
    skip_reasons.push({ field, reason });
  };

  for (const [index, f] of fields.entries()) {
    if (isPassword(f)) {
      skip(f.name ?? f.id ?? "password", "sensitive — never filled");
      continue; // guardrail: never fill password fields (§35.2)
    }
    if (f.label && isSelfIdentification(f.label)) {
      const explicit = sensitiveAnswer(f.label, aliasMap, values);
      if (explicit) {
        // the candidate saved this answer themselves — fill it, never infer one
        mappings.push({ key: explicit.key, value: explicit.value, confidence: 0.9, method: "explicit", field_index: index });
      } else {
        skip(f.label, "voluntary self-identification — your answer, not ours");
      }
      continue; // guardrail: EEOC self-ID questions are the candidate's call, not ours
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

    // 3. name/id token match — token SETS (not substrings), and the most
    // specific alias wins so "first_name" maps to first_name, not full_name
    if (!best && (f.name || f.id)) {
      const tokens = new Set(
        `${f.name ?? ""} ${f.id ?? ""}`
          .toLowerCase()
          .replace(/[_-]/g, " ")
          .split(/\s+/)
          .filter(Boolean)
      );
      let rank = 0;
      for (const [key, aliases] of aliasMap) {
        if (isCustom(key)) continue;
        for (const alias of aliases) {
          const words = alias.split(" ");
          if (!words.every((w) => tokens.has(w))) continue;
          const r = words.length * 100 + alias.length;
          if (r > rank) {
            rank = r;
            best = { key, confidence: 0.9, method: "name" };
          }
        }
      }
    }

    // 3.5. the candidate's own pre-written answers (/autofill page) win over
    // dictionary matching: if the question contains their snippet, use it
    if (!best && f.label) {
      const L = normalize(f.label);
      for (const [key, aliases] of aliasMap) {
        if (!isCustom(key)) continue;
        for (const alias of aliases) {
          const a = normalize(alias);
          if (a.length >= 6 && L.includes(a)) {
            best = { key, confidence: 0.9, method: "custom" };
            break;
          }
        }
        if (best) break;
      }
    }

    // 3.6. exact label match — normalized label equals an alias verbatim. Must run
    // before the fuzzy step: dice can score a *shorter* alias at 1.0 too
    // ("Referee Name 2" bigrams contain all of "referee name"'s), and first-seen
    // would then keep referee1 for a referee-2 field. Exact wins deterministically.
    if (!best && f.label) {
      const L = normalize(f.label);
      if (L) {
        for (const [key, aliases] of aliasMap) {
          if (isCustom(key)) continue;
          if (aliases.some((a) => normalize(a) === L)) {
            best = { key, confidence: 0.92, method: "label_exact" };
            break;
          }
        }
      }
    }

    // 4. label similarity ≥ 0.55 (spec: rapidfuzz ≥ 85/100 on well-formed labels)
    if (!best && f.label) {
      for (const [key, aliases] of aliasMap) {
        if (isCustom(key)) continue;
        for (const alias of aliases) {
          const s = similarity(f.label, alias);
          if (s >= 0.55 && (!best || s > best.confidence)) best = { key, confidence: Number(s.toFixed(2)), method: "label" };
        }
      }
    }

    // 4b. label containment: long exam-style questions ("Will you now or in the future
    // require sponsorship for employment visa status (e.g., H-1B, TN, etc.)?") never reach
    // 0.55 against a short alias — if the question *contains* an alias phrase, match it.
    // Also runs when step 4 fired: a phrase present verbatim beats bigram similarity,
    // correcting stem-misses ("Highest Qualification / Degree" fuzzy-matches
    // "other qualifications" via the shared stem but truly contains "degree").
    // Never overrides history/autocomplete/name/custom — those keep priority.
    if (f.label && (!best || best.method === "label")) {
      const L = normalize(f.label);
      let hit: { key: string; aliasLen: number } | null = null;
      for (const [key, aliases] of aliasMap) {
        if (isCustom(key)) continue;
        for (const alias of aliases) {
          const a = normalize(alias);
          if (a.length < 5 || !L.includes(a)) continue;
          if (!hit || a.length > hit.aliasLen) hit = { key, aliasLen: a.length };
        }
      }
      if (hit) {
        // long, specific phrase ⇒ green; short keyword ⇒ amber (fill but flagged)
        const confidence = hit.aliasLen >= 15 ? 0.86 : 0.78;
        if (!best || confidence > best.confidence) best = { key: hit.key, confidence, method: "label_contains" };
      }
    }

    if (!best) {
      skip(f.label ?? f.name ?? "unknown", "no confident match — left empty rather than guessed");
      continue;
    }
    if (!values.get(best.key)) {
      skip(f.label ?? f.name ?? best.key, `no profile data for ${best.key} — add it in your profile`);
      continue;
    }
    mappings.push({ key: best.key, value: values.get(best.key)!, confidence: Math.min(1, best.confidence), method: best.method, field_index: index });
  }

  return { mappings, skipped, skip_reasons };
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
