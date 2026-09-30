import { all, get, run, parseJson, tx } from "../core/db";
import { notFound, validation } from "../core/errors";
import { newId, nowIso } from "../util/id";
import { skillNames } from "./profile.service";
import { tokenize, expand } from "../search/synonyms";
import { profileSignals } from "./profile-signals";
import { scorePosting } from "./scoring.service";

export interface CVBlock {
  type: "summary" | "experience" | "skills" | "projects" | "education" | "awards" | "custom";
  source?: "profile" | "local";
  ref?: string;
  text?: string;
  title?: string;
  bullets?: string[];
  groups?: string[];
}

export async function listCVs(userId: string, filter: { archetype?: string; category?: string } = {}) {
  const where = ["user_id = ?"];
  const args: any[] = [userId];
  if (filter.archetype) {
    where.push("archetype = ?");
    args.push(filter.archetype);
  }
  if (filter.category) {
    where.push("career_category = ?");
    args.push(filter.category);
  }
  const rows = await all<any>(`SELECT * FROM cvs WHERE ${where.join(" AND ")} ORDER BY updated_at DESC`, ...args);
  return rows.map(shape);
}

const shape = (r: any) => ({
  ...r,
  targeting: parseJson(r.targeting, {}),
  blocks: parseJson(r.blocks, []),
  lineage: parseJson(r.lineage, {}),
});

export async function getCV(userId: string, id: string) {
  const r = await get("SELECT * FROM cvs WHERE id = ? AND user_id = ?", id, userId);
  if (!r) throw notFound("CV");
  return shape(r);
}

export interface CreateCVInput {
  name: string;
  archetype?: "opening" | "pitch";
  career_category?: string;
  targeting?: any;
  blocks?: CVBlock[];
  template_id?: string | null;
  profile_id?: string | null;
}

export async function createCV(userId: string, input: CreateCVInput) {
  const profile = await get("SELECT id FROM profiles WHERE user_id = ?", userId);
  const id = newId();
  const now = nowIso();
  await run(
    `INSERT INTO cvs (id, user_id, profile_id, name, archetype, career_category, targeting, blocks, template_id, lineage, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
    id,
    userId,
    input.profile_id ?? profile?.id ?? null,
    input.name,
    input.archetype ?? "opening",
    input.career_category ?? "software_engineering",
    JSON.stringify(input.targeting ?? {}),
    JSON.stringify(input.blocks ?? (await defaultBlocks(userId))),
    input.template_id ?? null,
    now,
    now
  );
  return getCV(userId, id);
}

/** A sensible default CV assembled from the profile (§24.1, CVs are views over profile data). */
async function defaultBlocks(userId: string): Promise<CVBlock[]> {
  const profile = await get<any>("SELECT * FROM profiles WHERE user_id = ?", userId);
  const identity: any = profile ? parseJson(profile.identity, {}) : {};
  const exps = profile ? await all<any>("SELECT * FROM profile_experiences WHERE profile_id = ? ORDER BY sort_order", profile.id) : [];
  const edu = profile ? await all<any>("SELECT * FROM profile_education WHERE profile_id = ? ORDER BY sort_order", profile.id) : [];
  const blocks: CVBlock[] = [];
  if (identity.pitch || identity.headline) blocks.push({ type: "summary", source: "local", text: identity.pitch ?? identity.headline });
  if (exps.length) blocks.push({ type: "experience", source: "profile" });
  blocks.push({ type: "skills", source: "profile" });
  if (edu.length) blocks.push({ type: "education", source: "profile" });
  return blocks;
}

export async function updateCV(userId: string, id: string, patch: Partial<CreateCVInput>) {
  const existing = await get("SELECT * FROM cvs WHERE id = ? AND user_id = ?", id, userId);
  if (!existing) throw notFound("CV");
  const sets: string[] = ["updated_at = ?"];
  const args: any[] = [nowIso()];
  if (patch.name != null) {
    sets.push("name = ?");
    args.push(patch.name);
  }
  if (patch.archetype != null) {
    sets.push("archetype = ?");
    args.push(patch.archetype);
  }
  if (patch.career_category != null) {
    sets.push("career_category = ?");
    args.push(patch.career_category);
  }
  if (patch.targeting !== undefined) {
    sets.push("targeting = ?");
    args.push(JSON.stringify(patch.targeting));
  }
  if (patch.blocks !== undefined) {
    sets.push("blocks = ?");
    args.push(JSON.stringify(patch.blocks));
  }
  if (patch.template_id !== undefined) {
    sets.push("template_id = ?");
    args.push(patch.template_id);
  }
  await run(`UPDATE cvs SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, ...args, id, userId);
  return getCV(userId, id);
}

export async function deleteCV(userId: string, id: string) {
  const n = await run("DELETE FROM cvs WHERE id = ? AND user_id = ?", id, userId);
  if (!n) throw notFound("CV");
  return { deleted: true };
}

/** Fork with lineage (§20.1 variants). */
export async function duplicateCV(userId: string, id: string, name?: string) {
  const src = await getCV(userId, id);
  const newCvId = newId();
  const now = nowIso();
  await run(
    `INSERT INTO cvs (id, user_id, profile_id, name, archetype, career_category, targeting, blocks, template_id, lineage, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newCvId,
    userId,
    src.profile_id,
    name ?? `${src.name} (copy)`,
    src.archetype,
    src.career_category,
    JSON.stringify(src.targeting),
    JSON.stringify(src.blocks),
    src.template_id,
    JSON.stringify({ forked_from: src.id, forked_at: now }),
    now,
    now
  );
  return getCV(userId, newCvId);
}

/**
 * ATS + JD match report (§20.1 / §24.1): parse-ability, keyword coverage, missing keywords.
 * Never fabricates, "add missing keyword" suggestions are advisory.
 */
export async function matchCV(userId: string, cvId: string, postingId?: string) {
  const cv = await getCV(userId, cvId);
  const skills = await skillNames(userId);
  const posting = postingId ? await get<any>("SELECT * FROM job_postings WHERE id = ? AND user_id = ?", postingId, userId) : null;
  const jdKeywords: string[] = posting ? parseJson(posting.jd_keywords, []) : [];
  const cvText = [cv.blocks.map((b: CVBlock) => `${b.text ?? ""} ${(b.bullets ?? []).join(" ")} ${(b.groups ?? []).join(" ")}`).join(" "), ...skills, cv.name].join(" ").toLowerCase();

  const matched: string[] = [];
  const missing: string[] = [];
  if (jdKeywords.length) {
    for (const kw of jdKeywords) {
      const family = expand(kw);
      (family.some((f) => cvText.includes(f)) ? matched : missing).push(kw);
    }
  }

  const sectionTypes = new Set(cv.blocks.map((b: CVBlock) => b.type));
  const atsChecks = [
    { key: "has_summary", label: "Summary / profile section", ok: sectionTypes.has("summary") || sectionTypes.has("custom"), fix: "Add a 3-line tailored summary" },
    { key: "has_experience", label: "Experience section", ok: sectionTypes.has("experience"), fix: "Add at least one experience block" },
    { key: "has_skills", label: "Skills section (keyword-friendly)", ok: sectionTypes.has("skills"), fix: "Add a skills group, ATS parsers look for it" },
    { key: "length", label: "Length ≤ 2 pages worth of text", ok: cvText.length < 6000, fix: "Trim older roles or bullets" },
    { key: "contact", label: "Contact block present", ok: skills.length >= 0 && !!(await profileHasContact(userId)), fix: "Add email/phone to your profile" },
  ];
  const coverage = jdKeywords.length ? Math.round((matched.length / jdKeywords.length) * 100) : null;
  const signals = await profileSignals(userId);
  const jdScore = posting
    ? scorePosting(signals, { title: posting.title, description: posting.description, companyName: posting.company_name, seniority: posting.seniority, remote: !!posting.remote, location: posting.location, salaryMin: posting.salary_min, salaryMax: posting.salary_max, postedAt: posting.posted_at })
    : null;

  return {
    cv_id: cvId,
    posting_id: postingId ?? null,
    ats: { score: Math.round((atsChecks.filter((c) => c.ok).length / atsChecks.length) * 100), checks: atsChecks },
    keywords: { matched, missing, coverage_pct: coverage, jd_total: jdKeywords.length },
    jd_match: jdScore ? { score: jdScore.score, explain: jdScore.explain } : null,
    suggestions: [
      ...missing.slice(0, 6).map((k) => `Keyword from the JD not in your CV: “${k}” (only add if true)`),
      ...atsChecks.filter((c) => !c.ok).map((c) => c.fix),
    ],
  };
}

async function profileHasContact(userId: string) {
  const p = await get<any>("SELECT identity FROM profiles WHERE user_id = ?", userId);
  if (!p) return false;
  const id = parseJson(p.identity, {} as any);
  return !!id.email || !!id.phone;
}

/** Which CV should be suggested for a posting (§24.1 version targeting). */
export async function suggestCVs(userId: string, postingId?: string) {
  const cvs = await listCVs(userId);
  const posting = postingId ? await get<any>("SELECT * FROM job_postings WHERE id = ? AND user_id = ?", postingId, userId) : null;
  if (!posting) return cvs.map((c) => ({ cv: c, match: null }));
  const jd = new Set(tokenize(`${posting.title} ${parseJson<string[]>(posting.jd_keywords, []).join(" ")}`));
  return cvs
    .map((c) => {
      const targeting = c.targeting ?? {};
      const kw: string[] = targeting.keywords ?? [];
      const hits = kw.filter((k) => jd.has(k.toLowerCase())).length;
      const base = kw.length ? hits / kw.length : 0.3;
      const archBonus = (posting.has_opening ?? true) && c.archetype === "opening" ? 0.15 : 0;
      return { cv: c, match: Number(Math.min(1, base + archBonus).toFixed(2)) };
    })
    .sort((a, b) => (b.match ?? 0) - (a.match ?? 0));
}

/* ----------------------------- templates ----------------------------- */

export async function listTemplates(userId: string, filter: { kind?: string; archetype?: string } = {}) {
  const where = ["user_id = ?"];
  const args: any[] = [userId];
  if (filter.kind) {
    where.push("kind = ?");
    args.push(filter.kind);
  }
  if (filter.archetype) {
    where.push("archetype = ?");
    args.push(filter.archetype);
  }
  return (await all(`SELECT * FROM templates WHERE ${where.join(" AND ")} ORDER BY created_at DESC`, ...args)).map((r: any) => ({ ...r, variables: parseJson(r.variables, []) }));
}

export async function createTemplate(userId: string, t: { kind: string; archetype: string; name: string; subject?: string; body: string; variables?: string[] }) {
  const id = newId();
  const now = nowIso();
  await run(
    `INSERT INTO templates (id, user_id, kind, archetype, name, subject, body, variables, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    t.kind,
    t.archetype,
    t.name,
    t.subject ?? null,
    t.body,
    JSON.stringify(t.variables ?? extractVars(t.body)),
    now,
    now
  );
  return get("SELECT * FROM templates WHERE id = ?", id);
}

export async function updateTemplate(userId: string, id: string, patch: any) {
  const t = await get("SELECT * FROM templates WHERE id = ? AND user_id = ?", id, userId);
  if (!t) throw notFound("Template");
  await run(
    "UPDATE templates SET name = ?, subject = ?, body = ?, variables = ?, updated_at = ? WHERE id = ?",
    patch.name ?? t.name,
    patch.subject ?? t.subject,
    patch.body ?? t.body,
    JSON.stringify(patch.body ? extractVars(patch.body) : parseJson(t.variables, [])),
    nowIso(),
    id
  );
  return get("SELECT * FROM templates WHERE id = ?", id);
}

export async function deleteTemplate(userId: string, id: string) {
  const n = await run("DELETE FROM templates WHERE id = ? AND user_id = ?", id, userId);
  if (!n) throw notFound("Template");
  return { deleted: true };
}

export const extractVars = (body: string) => [...new Set([...body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]))];

/** Merge variables (§24.2): {{a.b}} plus {{var | default: "x"}} fallbacks. */
export function mergeTemplate(body: string, vars: Record<string, any>): string {
  return body.replace(/\{\{\s*([\w.]+)(?:\s*\|\s*default:\s*"?([^"}]*)"?)?\s*\}\}/g, (_m, path: string, dflt?: string) => {
    const v = path.split(".").reduce((acc: any, k) => (acc == null ? acc : acc[k]), vars);
    if (v == null || v === "") return dflt ?? "";
    return String(v);
  });
}

export { tx };
