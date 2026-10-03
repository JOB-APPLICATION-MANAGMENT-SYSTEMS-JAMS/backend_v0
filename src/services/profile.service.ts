import { all, get, run, parseJson } from "../core/db";
import { notFound } from "../core/errors";
import { newId, nowIso } from "../util/id";

export interface SkillInput {
  name: string;
  level?: string | null;
  years?: number | null;
  // SQLite hands back 0/1, the form posts booleans; accept both
  is_top5?: boolean | number;
}
export interface ExperienceInput {
  company: string;
  title: string;
  start_date?: string | null;
  end_date?: string | null;
  location?: string | null;
  bullets?: string[];
}
export interface EducationInput {
  school: string;
  degree?: string | null;
  field?: string | null;
  start_date?: string | null;
  end_date?: string | null;
}

async function ensureProfile(userId: string) {
  let p = await get("SELECT * FROM profiles WHERE user_id = ?", userId);
  if (!p) {
    const id = newId();
    await run(`INSERT INTO profiles (id, user_id, identity, prefs, aliases, version, updated_at) VALUES (?, ?, '{}', '{}', '{}', 1, ?)`, id, userId, nowIso());
    p = (await get("SELECT * FROM profiles WHERE user_id = ?", userId))!;
  }
  return p;
}

/**
 * The name lives under four different keys depending on which flow wrote it:
 * signup seeds first_name/last_name/full_name, onboarding writes full_name, the
 * profile form writes name, autofill writes full_name again. Readers each picked
 * one or two of them, so an account could hold its name under one key while the
 * pitch signer, profile page and completeness check looked at another — and
 * signed emails with a blank line after "Best,". Reconcile on read so any one
 * key satisfies every reader.
 */
export function reconcileIdentity(identity: any): any {
  const id: any = { ...identity };
  // `||` not `??`: signup writes first_name/last_name/full_name as "" and an
  // empty string must fall through to whatever name key actually holds data
  const full = String(id.full_name || id.name || "").trim() || [id.first_name, id.last_name].filter(Boolean).join(" ").trim();
  if (!full) return id;
  if (!id.name) id.name = full;
  if (!id.full_name) id.full_name = full;
  if (!id.first_name) id.first_name = full.split(" ")[0];
  if (!id.last_name) id.last_name = full.split(" ").slice(1).join(" ").trim();
  return id;
}

export async function getProfile(userId: string) {
  const p = await ensureProfile(userId);
  // The users row always knows the account email/name; identity blocks written
  // before the profile form was ever saved are `{}`, which left the profile page
  // blank and `{{profile.first_name}}` rendering literally. Seed on read so the
  // page (and completeness) reflect what is actually in the database.
  const u = await get<any>("SELECT email FROM users WHERE id = ?", userId);
  const identity: any = reconcileIdentity(parseJson(p.identity, {}));
  if (u?.email && !identity.email) identity.email = u.email;
  return {
    id: p.id,
    identity,
    prefs: parseJson(p.prefs, {}),
    aliases: parseJson(p.aliases, {}),
    version: p.version,
    updated_at: p.updated_at,
    skills: await all("SELECT * FROM profile_skills WHERE profile_id = ? ORDER BY sort_order, name", p.id),
    experiences: (await all<any>("SELECT * FROM profile_experiences WHERE profile_id = ? ORDER BY sort_order", p.id)).map((e) => ({
      ...e,
      bullets: parseJson(e.bullets, []),
    })),
    education: await all("SELECT * FROM profile_education WHERE profile_id = ? ORDER BY sort_order", p.id),
  };
}

export async function updateProfile(
  userId: string,
  input: { identity?: any; prefs?: any; aliases?: any; skills?: SkillInput[]; experiences?: ExperienceInput[]; education?: EducationInput[] }
) {
  const p = await ensureProfile(userId);
  if (input.identity || input.prefs || input.aliases) {
    // merge, never replace: the onboarding step posts {full_name, headline} and
    // a wholesale replace silently wiped the first_name/last_name signup wrote,
    // which is how pitches ended up signed with an empty name
    await run(
      `UPDATE profiles SET identity = ?, prefs = ?, aliases = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      // reconcile on write too, so empty signup placeholders converge on real names
      JSON.stringify(reconcileIdentity({ ...parseJson(p.identity, {}), ...(input.identity ?? {}) })),
      JSON.stringify({ ...parseJson(p.prefs, {}), ...(input.prefs ?? {}) }),
      JSON.stringify({ ...parseJson(p.aliases, {}), ...(input.aliases ?? {}) }),
      nowIso(),
      p.id
    );
  }
  if (input.skills) {
    await run("DELETE FROM profile_skills WHERE profile_id = ?", p.id);
    for (const [i, s] of input.skills.entries()) {
      await run(
        `INSERT INTO profile_skills (id, profile_id, name, level, years, is_top5, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        p.id,
        s.name,
        s.level ?? null,
        s.years ?? null,
        s.is_top5 ? 1 : 0,
        i
      );
    }
  }
  if (input.experiences) {
    await run("DELETE FROM profile_experiences WHERE profile_id = ?", p.id);
    for (const [i, e] of input.experiences.entries()) {
      await run(
        `INSERT INTO profile_experiences (id, profile_id, company, title, start_date, end_date, location, bullets, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        p.id,
        e.company,
        e.title,
        e.start_date ?? null,
        e.end_date ?? null,
        e.location ?? null,
        JSON.stringify(e.bullets ?? []),
        i
      );
    }
  }
  if (input.education) {
    await run("DELETE FROM profile_education WHERE profile_id = ?", p.id);
    for (const [i, e] of input.education.entries()) {
      await run(
        `INSERT INTO profile_education (id, profile_id, school, degree, field, start_date, end_date, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        p.id,
        e.school,
        e.degree ?? null,
        e.field ?? null,
        e.start_date ?? null,
        e.end_date ?? null,
        i
      );
    }
  }
  return getProfile(userId);
}

/** Completeness ring (§19.3): weighted checklist + suggestions. */
export async function completeness(userId: string) {
  const p = await getProfile(userId);
  const id: any = p.identity ?? {};
  const pr: any = p.prefs ?? {};
  const checks: { key: string; label: string; weight: number; done: boolean; hint?: string }[] = [
    { key: "name", label: "Full name", weight: 10, done: !!id.name },
    { key: "headline", label: "Headline", weight: 8, done: !!id.headline, hint: "One line that sells your direction" },
    { key: "email", label: "Email", weight: 8, done: !!id.email },
    { key: "phone", label: "Phone", weight: 6, done: !!id.phone },
    { key: "location", label: "Location", weight: 6, done: !!id.location },
    { key: "links", label: "Links (GitHub/LinkedIn/portfolio)", weight: 8, done: Object.keys(id.links ?? {}).length > 0 },
    { key: "pitch", label: "Pitch paragraph", weight: 10, done: !!(id.pitch ?? id.pitch_variants?.length), hint: "Used by template archetypes" },
    { key: "skills", label: "Skills", weight: 14, done: p.skills.length >= 5, hint: "Add at least 5, ranking uses them" },
    { key: "experience", label: "Experience", weight: 18, done: p.experiences.length >= 1 },
    { key: "education", label: "Education", weight: 6, done: p.education.length >= 1 },
    { key: "work_auth", label: "Work authorization", weight: 4, done: !!id.work_authorization },
    { key: "salary", label: "Salary expectations", weight: 4, done: !!(id.salary_expectation ?? pr.salary_expectation), hint: "Improves salary_fit in ranking" },
    { key: "seniority", label: "Seniority preference", weight: 4, done: !!pr.seniority },
    { key: "goal", label: "Daily goal set", weight: 4, done: true },
  ];
  const total = checks.reduce((a, c) => a + c.weight, 0);
  const score = Math.min(100, Math.round((checks.reduce((a, c) => a + (c.done ? c.weight : 0), 0) * 100) / total));
  return { score, checks, suggestions: checks.filter((c) => !c.done && c.hint).map((c) => ({ label: c.label, hint: c.hint })) };
}

export async function skillNames(userId: string): Promise<string[]> {
  const p = await get("SELECT id FROM profiles WHERE user_id = ?", userId);
  if (!p) return [];
  return (await all<{ name: string }>("SELECT name FROM profile_skills WHERE profile_id = ? ORDER BY is_top5 DESC", p.id)).map((r) => r.name);
}
