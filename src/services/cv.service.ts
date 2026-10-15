import { all, get, run, parseJson, tx } from "../core/db";
import { notFound, validation } from "../core/errors";
import { newId, nowIso } from "../util/id";
import { getProfile, skillNames } from "./profile.service";
import { tokenize, expand } from "../search/synonyms";
import { profileSignals } from "./profile-signals";
import { scorePosting } from "./scoring.service";
import { buildCvDoc, estimateCvDoc, type CvDoc } from "../lib/cv-document";

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
 * ATS + JD match report (§20.1 / §24.1).
 *
 * Real-world ATS behaviour, not a checklist of headings: the things that actually
 * cost someone an interview are a missing contact field a parser cannot find, a
 * section it cannot segment, an undated role that breaks tenure maths, a
 * description with no figures in it, and — when there is a job description —
 * keywords that never appear. Each check says what was looked at and what it
 * found, so the panel can be specific instead of showing a bare percentage.
 *
 * Never fabricates. Every suggestion is advisory and phrased so the reader decides.
 */
type Severity = "critical" | "important" | "polish";

/** Weight in the readiness score. A missing email and an unquantified line are not
 *  the same kind of problem, and averaging them equally is how a report ends up
 *  saying 80% about a CV a parser cannot read. */
const WEIGHT: Record<Severity, number> = { critical: 3, important: 2, polish: 1 };

export interface AtsCheck {
  key: string;
  label: string;
  ok: boolean;
  severity: Severity;
  /** what was actually looked at */
  evidence: string;
  fix: string;
}

/** A line carries a figure if it has a number, a percentage, or money in it.
 *  Recruiters scan for these and ranking models often weight them. */
const QUANTIFIED = /(\d|%|\bper cent\b|[$€£₦])/;

export async function matchCV(userId: string, cvId: string, postingId?: string) {
  const cv = await getCV(userId, cvId);
  const profile = await getProfile(userId);
  const posting = postingId ? await get<any>("SELECT * FROM job_postings WHERE id = ? AND user_id = ?", postingId, userId) : null;
  const jdKeywords: string[] = posting ? parseJson(posting.jd_keywords, []) : [];

  // Ask the document, not the block text: the page count below is the page the
  // printer produces, and the lines counted are the lines that get rendered.
  const doc = buildCvDoc(cv, profile);
  const { pages } = estimateCvDoc(doc);
  const id: any = profile.identity ?? {};
  const blocks: any[] = Array.isArray(cv.blocks) ? cv.blocks : [];
  const types = new Set(blocks.map((b) => b.type));

  const bodyLines = doc.sections.flatMap((sec) =>
    sec.lines.flatMap((l) => (l.k === "entry" ? l.body : l.k === "prose" ? [l.text] : [])),
  );
  const quantified = bodyLines.filter((l) => QUANTIFIED.test(l)).length;

  const words = doc.sections
    .map((sec) => [
      sec.head,
      ...sec.lines.map((l) =>
        l.k === "entry" ? [l.title, l.org, ...l.body].filter(Boolean).join(" ") : l.k === "prose" ? l.text : l.items.join(" "),
      ),
    ].join(" "))
    .join(" ");
  const cvText = [words, (profile.skills ?? []).map((s: any) => s.name).join(" "), doc.name].join(" ").toLowerCase();

  const matched: string[] = [];
  const missing: string[] = [];
  for (const kw of jdKeywords) {
    const family = expand(kw);
    (family.some((f) => cvText.includes(f)) ? matched : missing).push(kw);
  }
  const coverage = jdKeywords.length ? Math.round((matched.length / jdKeywords.length) * 100) : null;

  const expCount = (profile.experiences ?? []).length;
  const eduCount = (profile.education ?? []).length;
  const datedTotal = expCount + eduCount;
  const undated =
    (profile.experiences ?? []).filter((e: any) => !String(e.start_date ?? "").trim()).length +
    (profile.education ?? []).filter((e: any) => !String(e.start_date ?? "").trim()).length;

  // What the CV is aimed at: the posting it is tailored to, the keywords the user
  // pinned to it, or their own headline. `career_category` is deliberately not
  // used — it is a taxonomy tag that defaults to a value nobody chose, and asking
  // a document to contain "software_engineering" would be noise, not advice.
  const pinned: string = Array.isArray(cv.targeting?.keywords) ? String(cv.targeting.keywords.join(" ")).trim() : "";
  const target: string = String(posting?.title ?? "").trim() || pinned || String(id.headline ?? "").trim();
  const targetWords = target.toLowerCase().split(/[^a-z0-9+#.]+/).filter((w) => w.length > 2);
  const targetHit = targetWords.length ? targetWords.filter((w) => cvText.includes(w)).length / targetWords.length : 1;

  const has = (t: string) => types.has(t);
  // The contact row as it will print, not as the profile form holds it: the
  // document is what the parser and the recruiter actually see.
  const inHeader = (icon: CvDoc["contact"][number]["icon"]) => doc.contact.find((c) => c.icon === icon);
  const mail = inHeader("mail");
  const phone = inHeader("phone");
  const headerLinks = (["linkedin", "github", "globe"] as const).map(inHeader).filter(Boolean);

  const checks: AtsCheck[] = [
    {
      key: "email",
      label: "Email address in the contact row",
      severity: "critical",
      ok: !!mail,
      evidence: mail ? `${mail.label} prints in the header` : "the header has no email address",
      fix: "Add your email on the Profile page — every parser looks for it first",
    },
    {
      key: "phone",
      label: "Phone number in the contact row",
      severity: "important",
      ok: !!phone,
      evidence: phone ? `${phone.label} prints in the header` : "the header has no phone number",
      fix: "Add a phone number on the Profile page",
    },
    {
      key: "link",
      label: "At least one profile link",
      severity: "polish",
      ok: headerLinks.length > 0,
      evidence: headerLinks.length ? headerLinks.map((l) => l!.label).join(", ") : "no GitHub, LinkedIn or site in the header",
      fix: "Add a GitHub or LinkedIn link on the Profile page",
    },
    {
      key: "experience",
      label: "Experience section",
      severity: "important",
      ok: has("experience"),
      evidence: has("experience") ? `${expCount} dated role${expCount === 1 ? "" : "s"}` : "no experience block in this CV",
      fix: "Add an experience block — parsers segment sections by their headings",
    },
    {
      key: "education",
      label: "Education section",
      severity: "important",
      ok: has("education"),
      evidence: has("education") ? `${eduCount} entr${eduCount === 1 ? "y" : "ies"}` : "no education block in this CV",
      fix: "Add an education block",
    },
    {
      key: "skills",
      label: "Skills section (keyword-friendly)",
      severity: "important",
      ok: has("skills"),
      evidence: has("skills") ? `${(profile.skills ?? []).length} skills listed` : "no skills block in this CV",
      fix: "Add a skills block — it is the cheapest place to match a job description",
    },
    {
      key: "summary",
      label: "Summary / profile section",
      severity: "polish",
      ok: has("summary") || has("custom"),
      evidence: has("summary") || has("custom") ? "present" : "no summary block in this CV",
      fix: "Add a three-line summary aimed at the role you want",
    },
    {
      key: "dates",
      label: "Every role and school has a start date",
      severity: "important",
      ok: datedTotal === 0 || undated === 0,
      evidence:
        datedTotal === 0
          ? "nothing dated yet"
          : undated
            ? `${undated} of ${datedTotal} entries lack a start date`
            : `all ${datedTotal} dated`,
      fix: "Add start dates — tenure maths and gap detection both need them",
    },
    {
      key: "length",
      label: "Length ≤ 2 pages as printed",
      severity: "important",
      ok: pages <= 2,
      evidence: `renders as ${pages} page${pages === 1 ? "" : "s"}`,
      fix: "Trim older roles or drop the least relevant lines",
    },
    {
      key: "quantified",
      label: "Some lines quantify an outcome",
      severity: "polish",
      ok: bodyLines.length > 0 && quantified / bodyLines.length >= 0.25,
      evidence: `${quantified} of ${bodyLines.length} lines carry a figure`,
      fix: "Put a figure in a quarter of your lines: users, %, time or money saved",
    },
  ];

  if (targetWords.length) {
    checks.push({
      key: "target",
      label: `Names the target role`,
      severity: "important",
      ok: targetHit >= 0.5,
      evidence: `covers ${Math.round(targetHit * 100)}% of “${target}”`,
      fix: `Work “${target}” into the summary or a role title`,
    });
  }
  if (jdKeywords.length) {
    checks.push({
      key: "keywords",
      label: "Covers the job description keywords",
      severity: "critical",
      ok: (coverage ?? 0) >= 60,
      evidence: `${matched.length} of ${jdKeywords.length} keywords (${coverage}%)`,
      fix: "Add the keywords that are genuinely true of your experience",
    });
  }

  const weightTotal = checks.reduce((n, c) => n + WEIGHT[c.severity], 0);
  const weightEarned = checks.reduce((n, c) => n + (c.ok ? WEIGHT[c.severity] : 0), 0);
  const score = Math.round((weightEarned / weightTotal) * 100);
  const blockers = checks.filter((c) => !c.ok && c.severity === "critical").length;
  const band: "strong" | "decent" | "weak" = score >= 85 ? "strong" : score >= 65 ? "decent" : "weak";
  const summary = blockers
    ? `${blockers} thing${blockers > 1 ? "s" : ""} a parser or a recruiter will hit before anything else.`
    : band === "strong"
      ? "Nothing structural is in the way: this is ready to send."
      : "No blockers, the rest is polish.";

  const signals = await profileSignals(userId);
  const jdScore = posting
    ? scorePosting(signals, { title: posting.title, description: posting.description, companyName: posting.company_name, seniority: posting.seniority, remote: !!posting.remote, location: posting.location, salaryMin: posting.salary_min, salaryMax: posting.salary_max, postedAt: posting.posted_at })
    : null;

  return {
    cv_id: cvId,
    posting_id: postingId ?? null,
    ats: { score, checks, pages, band, blockers, summary, weight_total: weightTotal, weight_earned: weightEarned },
    keywords: { matched, missing, coverage_pct: coverage, jd_total: jdKeywords.length },
    jd_match: jdScore ? { score: jdScore.score, explain: jdScore.explain } : null,
    suggestions: [
      ...missing.slice(0, 6).map((k) => `Keyword from the JD not in your CV: “${k}” (only add if true)`),
      ...checks.filter((c) => !c.ok).sort((a, b) => WEIGHT[b.severity] - WEIGHT[a.severity]).map((c) => c.fix),
    ],
  };
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

/** Merge variables (§24.2): {{a.b}} plus {{var | default: "x"}} fallbacks.
 *  Drafts saved before the composer masked its tokens may hold the polished form
 *  `{{profile. First_name}}` (space after the dot, capitalised) — normalise those
 *  first, otherwise the merge skips them and the literal token reaches the email. */
export function mergeTemplate(body: string, vars: Record<string, any>): string {
  const normalised = body.replace(/\{\{\s*([A-Za-z][\w]*)\.\s*([A-Za-z_][\w]*)\s*\}\}/g, (_m, a: string, b: string) => `{{${a.toLowerCase()}.${b.toLowerCase()}}}`);
  return normalised.replace(/\{\{\s*([\w.]+)(?:\s*\|\s*default:\s*"?([^"}]*)"?)?\s*\}\}/g, (_m, path: string, dflt?: string) => {
    const v = path.split(".").reduce((acc: any, k) => (acc == null ? acc : acc[k]), vars);
    if (v == null || v === "") return dflt ?? "";
    return String(v);
  });
}

export { tx };
