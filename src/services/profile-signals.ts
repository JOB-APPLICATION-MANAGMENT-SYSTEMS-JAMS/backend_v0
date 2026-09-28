import { all, get, parseJson } from "../core/db";
import type { ProfileSignals } from "./scoring.service";

/** Project the stored profile into the scoring engine's input shape (§34.4). */
export function profileSignals(userId: string): ProfileSignals {
  const p = get("SELECT * FROM profiles WHERE user_id = ?", userId);
  const user = get("SELECT * FROM users WHERE id = ?", userId);
  const identity: any = p ? parseJson(p.identity, {}) : {};
  const prefs: any = p ? parseJson(p.prefs, {}) : {};
  const skills = p
    ? all<{ name: string; is_top5: number }>("SELECT name, is_top5 FROM profile_skills WHERE profile_id = ? ORDER BY is_top5 DESC", p.id)
    : [];
  const tiers: Record<string, "dream" | "reach" | "safety"> = {};
  for (const c of all<any>("SELECT lower(name) AS n, tier FROM companies WHERE user_id = ?", userId)) tiers[c.n] = c.tier;
  return {
    skills: skills.map((s) => s.name),
    topSkills: skills.filter((s) => s.is_top5).map((s) => s.name),
    headline: identity.headline ?? identity.title ?? "",
    targetTitles: prefs.target_titles ?? (identity.headline ? [identity.headline] : []),
    seniority: prefs.seniority,
    locations: prefs.locations ?? (identity.location ? [identity.location] : []),
    remoteOk: prefs.remote !== false,
    salaryExpectation: identity.salary_expectation ?? prefs.salary_expectation,
    companyTiers: tiers,
    // bounded per-user feedback nudges derived from vote history
    feedback: {},
    timezone: user?.timezone ?? "Africa/Lagos",
  } as ProfileSignals & { timezone: string };
}
