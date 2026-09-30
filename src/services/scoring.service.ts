import { expand, related, tokenize } from "../search/synonyms";

export interface ScoreFactor {
  factor: string;
  weight: number;
  points: number;
  why: string;
}

export interface ProfileSignals {
  skills: string[];
  topSkills?: string[];
  headline?: string;
  targetTitles?: string[];
  seniority?: string; // junior | mid | senior | staff
  locations?: string[];
  remoteOk?: boolean;
  salaryExpectation?: number;
  companyTiers?: Record<string, "dream" | "reach" | "safety">;
  /** 👍/👎 bounded adjustments (§34.4 last term) */
  feedback?: Record<string, number>;
}

export interface PostingSignals {
  title: string;
  description?: string;
  companyName?: string;
  seniority?: string | null;
  remote?: boolean;
  location?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  postedAt?: string | null;
  firstSeenAt?: string;
}

export const WEIGHTS = {
  skills: 0.35,
  title: 0.2,
  seniority: 0.1,
  location: 0.1,
  salary: 0.1,
  freshness: 0.1,
  company_tier: 0.05,
  seen_penalty: 0.15,
  feedback: 0.05,
};

const SENIORITY_ORDER = ["intern", "junior", "mid", "senior", "staff", "principal"];

function seniorityRank(s?: string | null): number {
  if (!s) return -1;
  const i = SENIORITY_ORDER.findIndex((x) => x === s.toLowerCase());
  return i;
}

/** Weighted skills overlap over expanded skill sets (§34.4 fielded term). */
export function skillsOverlap(profile: ProfileSignals, posting: PostingSignals): { value: number; matched: string[]; missing: string[] } {
  const text = `${posting.title} ${posting.description ?? ""}`.toLowerCase();
  const titleTokens = new Set(tokenize(posting.title));
  const skills = profile.skills ?? [];
  if (!skills.length) return { value: 0.5, matched: [], missing: [] }; // no profile skills: neutral, never zero
  const top = new Set((profile.topSkills ?? []).map((s) => s.toLowerCase()));
  let num = 0;
  let den = 0;
  const matched: string[] = [];
  const missing: string[] = [];
  for (const skill of skills) {
    const family = expand(skill);
    // w = 1.0 base · 1.5 top5 · 1.2 in title
    let w = 1.0;
    if (top.has(skill.toLowerCase())) w = 1.5;
    const inTitle = family.some((f) => [...titleTokens].some((t) => t === f || t.includes(f)));
    if (inTitle) w = Math.max(w, 1.2);
    den += w;
    const hit = family.some((f) => text.includes(f));
    if (hit) {
      num += w;
      matched.push(skill);
    } else {
      missing.push(skill);
    }
  }
  return { value: den ? num / den : 0, matched, missing };
}

export function titleMatch(profile: ProfileSignals, posting: PostingSignals): number {
  const targets = [...(profile.targetTitles ?? []), profile.headline ?? ""].filter(Boolean);
  if (!targets.length) return 0.6;
  let best = 0;
  for (const t of targets) {
    const a = new Set(tokenize(t));
    const b = new Set(tokenize(posting.title));
    if (!a.size || !b.size) continue;
    const inter = [...a].filter((x) => b.has(x)).length;
    const ratio = inter / Math.min(a.size, b.size);
    best = Math.max(best, ratio);
  }
  return Math.min(1, best);
}

export function seniorityFit(profile: ProfileSignals, posting: PostingSignals): { value: number; why: string } {
  const mine = seniorityRank(profile.seniority);
  const theirs = seniorityRank(posting.seniority);
  if (mine < 0 || theirs < 0) return { value: 0.6, why: "seniority unknown on one side" };
  const d = Math.abs(mine - theirs);
  if (d === 0) return { value: 1, why: `${profile.seniority} ↔ ${posting.seniority} exact fit` };
  if (d === 1) return { value: 0.7, why: `adjacent level (${profile.seniority} vs ${posting.seniority})` };
  return { value: 0.3, why: `level gap: ${profile.seniority} vs ${posting.seniority}` };
}

export function locationFit(profile: ProfileSignals, posting: PostingSignals): { value: number; why: string } {
  if (posting.remote) {
    if (profile.remoteOk !== false) return { value: 1, why: "remote role matches preference" };
    return { value: 0.6, why: "remote but you prefer onsite" };
  }
  const loc = (posting.location ?? "").toLowerCase();
  const prefs = (profile.locations ?? []).map((l) => l.toLowerCase());
  if (!prefs.length) return { value: 0.7, why: "no location preference set" };
  if (prefs.some((p) => loc.includes(p))) return { value: 1, why: `location match (${posting.location})` };
  return { value: 0.2, why: `${posting.location} conflicts with your locations` };
}

export function salaryFit(profile: ProfileSignals, posting: PostingSignals): { value: number; why: string } {
  const want = profile.salaryExpectation;
  const max = posting.salaryMax ?? posting.salaryMin;
  if (!max) return { value: 0.5, why: "salary not listed, not penalised" };
  if (!want) return { value: 0.7, why: "no salary expectation set" };
  if (max >= want) return { value: 1, why: `top of band ≥ your expectation` };
  if (max >= want * 0.8) return { value: 0.6, why: `within 20% of your expectation` };
  return { value: 0.2, why: `below your expectation (${max} vs ${want})` };
}

export function freshness(postedAt?: string | null, now = Date.now()): { value: number; why: string } {
  if (!postedAt) return { value: 0.5, why: "posting date unknown" };
  const age = Math.max(0, (now - new Date(postedAt).getTime()) / 86_400_000);
  const v = Math.exp(-age / 7);
  return { value: v, why: age < 1 ? "posted today" : `posted ${Math.round(age)}d ago` };
}

export function companyTierFit(profile: ProfileSignals, posting: PostingSignals): { value: number; why: string } {
  const tier = profile.companyTiers?.[(posting.companyName ?? "").toLowerCase()];
  if (tier === "dream") return { value: 1, why: "dream company" };
  if (tier === "reach") return { value: 0.8, why: "reach company" };
  if (tier === "safety") return { value: 0.6, why: "safety company" };
  return { value: 0.7, why: "untiered company" };
}

/**
 * score(profile, posting) per §34.4, every term bounded, every point explainable,
 * output clamped to [0,100].
 */
export function scorePosting(
  profile: ProfileSignals,
  posting: PostingSignals,
  opts: { seenDaysAgo?: number | null; appliedOrIgnored?: boolean; feedbackVote?: "up" | "down" | null } = {}
): { score: number; explain: ScoreFactor[] } {
  const explain: ScoreFactor[] = [];
  const skills = skillsOverlap(profile, posting);
  const title = titleMatch(profile, posting);
  const sen = seniorityFit(profile, posting);
  const loc = locationFit(profile, posting);
  const sal = salaryFit(profile, posting);
  const fresh = freshness(posting.postedAt);
  const tier = companyTierFit(profile, posting);

  let total = 0;
  const push = (factor: string, weight: number, unit: number, why: string, extraWhy?: string) => {
    const adj = profile.feedback?.[factor] ?? 0; // bounded feedback nudge (±0.15)
    const effW = Math.max(0, weight + adj);
    const points = 100 * effW * unit;
    total += points;
    explain.push({ factor, weight: Number(effW.toFixed(3)), points: Number(points.toFixed(1)), why: extraWhy ? `${why} · ${extraWhy}` : why });
  };

  push("skills", WEIGHTS.skills, skills.value, skills.matched.length ? `${skills.matched.slice(0, 5).join(", ")} overlap` : "no skill overlap yet");
  push("title", WEIGHTS.title, title, `title ≈ ${profile.targetTitles?.[0] ?? profile.headline ?? "your targets"}`);
  push("seniority", WEIGHTS.seniority, sen.value, sen.why);
  push("location", WEIGHTS.location, loc.value, loc.why);
  push("salary", WEIGHTS.salary, sal.value, sal.why);
  push("freshness", WEIGHTS.freshness, fresh.value, fresh.why);
  push("company_tier", WEIGHTS.company_tier, tier.value, tier.why);

  // penalties / bonuses
  if (opts.appliedOrIgnored) {
    const p = 100 * WEIGHTS.seen_penalty * 1;
    total -= p;
    explain.push({ factor: "seen_penalty", weight: WEIGHTS.seen_penalty, points: -Number(p.toFixed(1)), why: "you already applied / ignored this" });
  } else if (opts.seenDaysAgo != null && opts.seenDaysAgo > 0) {
    const decay = Math.exp(-opts.seenDaysAgo / 30);
    const p = 100 * WEIGHTS.seen_penalty * decay;
    total -= p;
    explain.push({ factor: "seen_penalty", weight: WEIGHTS.seen_penalty, points: -Number(p.toFixed(1)), why: `seen ${Math.round(opts.seenDaysAgo)}d ago, penalty decaying` });
  }
  if (opts.feedbackVote) {
    const delta = opts.feedbackVote === "up" ? 100 * WEIGHTS.feedback * 0.5 : -100 * WEIGHTS.feedback * 0.5;
    total += delta;
    explain.push({ factor: "feedback", weight: WEIGHTS.feedback, points: Number(delta.toFixed(1)), why: opts.feedbackVote === "up" ? "you liked similar results" : "you disliked similar results" });
  }

  const score = Math.max(0, Math.min(100, Number(total.toFixed(1))));
  explain.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return { score, explain };
}

/** Keyword extraction from a JD (§34.1 enrich step): frequent meaningful tokens. */
export function extractKeywords(text: string, limit = 18): string[] {
  const tokens = tokenize(text ?? "");
  const freq = new Map<string, number>();
  for (const t of tokens) {
    if (t.length < 3) continue;
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  const techy = tokens.filter((t) => /[+#]/.test(t) || (t.length > 2 && /\d/.test(t)));
  const ranked = [...freq.entries()]
    .filter(([t]) => !/^\d+$/.test(t))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
  return [...new Set([...techy, ...ranked])].slice(0, limit);
}

export { related };
