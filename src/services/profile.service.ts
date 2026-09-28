import { all, get, run, parseJson } from "../core/db";
import { notFound } from "../core/errors";
import { newId, nowIso } from "../util/id";

export interface SkillInput {
  name: string;
  level?: string | null;
  years?: number | null;
  is_top5?: boolean;
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

function ensureProfile(userId: string) {
  let p = get("SELECT * FROM profiles WHERE user_id = ?", userId);
  if (!p) {
    const id = newId();
    run(`INSERT INTO profiles (id, user_id, identity, prefs, aliases, version, updated_at) VALUES (?, ?, '{}', '{}', '{}', 1, ?)`, id, userId, nowIso());
    p = get("SELECT * FROM profiles WHERE user_id = ?", userId)!;
  }
  return p;
}

export function getProfile(userId: string) {
  const p = ensureProfile(userId);
  return {
    id: p.id,
    identity: parseJson(p.identity, {}),
    prefs: parseJson(p.prefs, {}),
    aliases: parseJson(p.aliases, {}),
    version: p.version,
    updated_at: p.updated_at,
    skills: all("SELECT * FROM profile_skills WHERE profile_id = ? ORDER BY sort_order, name", p.id),
    experiences: all<any>("SELECT * FROM profile_experiences WHERE profile_id = ? ORDER BY sort_order", p.id).map((e) => ({
      ...e,
      bullets: parseJson(e.bullets, []),
    })),
    education: all("SELECT * FROM profile_education WHERE profile_id = ? ORDER BY sort_order", p.id),
  };
}

export function updateProfile(
  userId: string,
  input: { identity?: any; prefs?: any; aliases?: any; skills?: SkillInput[]; experiences?: ExperienceInput[]; education?: EducationInput[] }
) {
  const p = ensureProfile(userId);
  if (input.identity || input.prefs || input.aliases) {
    run(
      `UPDATE profiles SET identity = ?, prefs = ?, aliases = ?, version = version + 1, updated_at = ? WHERE id = ?`,
      JSON.stringify(input.identity ?? parseJson(p.identity, {})),
      JSON.stringify(input.prefs ?? parseJson(p.prefs, {})),
      JSON.stringify(input.aliases ?? parseJson(p.aliases, {})),
      nowIso(),
      p.id
    );
  }
  if (input.skills) {
    run("DELETE FROM profile_skills WHERE profile_id = ?", p.id);
    input.skills.forEach((s, i) =>
      run(
        `INSERT INTO profile_skills (id, profile_id, name, level, years, is_top5, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        p.id,
        s.name,
        s.level ?? null,
        s.years ?? null,
        s.is_top5 ? 1 : 0,
        i
      )
    );
  }
  if (input.experiences) {
    run("DELETE FROM profile_experiences WHERE profile_id = ?", p.id);
    input.experiences.forEach((e, i) =>
      run(
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
      )
    );
  }
  if (input.education) {
    run("DELETE FROM profile_education WHERE profile_id = ?", p.id);
    input.education.forEach((e, i) =>
      run(
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
      )
    );
  }
  return getProfile(userId);
}

/** Completeness ring (§19.3): weighted checklist + suggestions. */
export function completeness(userId: string) {
  const p = getProfile(userId);
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
    { key: "skills", label: "Skills", weight: 14, done: p.skills.length >= 5, hint: "Add at least 5 — ranking uses them" },
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

export function skillNames(userId: string): string[] {
  const p = get("SELECT id FROM profiles WHERE user_id = ?", userId);
  if (!p) return [];
  return all<{ name: string }>("SELECT name FROM profile_skills WHERE profile_id = ? ORDER BY is_top5 DESC", p.id).map((r) => r.name);
}
