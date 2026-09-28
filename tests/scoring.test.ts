import { test } from "node:test";
import assert from "node:assert/strict";
import { scorePosting, skillsOverlap, freshness, salaryFit, extractKeywords, WEIGHTS } from "../src/services/scoring.service";

const profile = {
  skills: ["TypeScript", "React", "PostgreSQL", "Kubernetes"],
  topSkills: ["TypeScript", "React"],
  headline: "Senior Frontend Engineer",
  targetTitles: ["Senior Frontend Engineer"],
  seniority: "senior",
  locations: ["Remote"],
  remoteOk: true,
  salaryExpectation: 100000,
  companyTiers: { stripe: "dream" },
};

const posting = {
  title: "Senior Frontend Engineer (React / TypeScript)",
  description: "We need React and TypeScript. Kubernetes is a plus. PostgreSQL experience helps.",
  companyName: "Stripe",
  seniority: "senior",
  remote: true,
  location: "Remote (EU)",
  salaryMin: 110000,
  salaryMax: 140000,
  postedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
};

test("score is bounded 0..100 and explain accounts for the formula", () => {
  const { score, explain } = scorePosting(profile as any, posting);
  assert.ok(score >= 0 && score <= 100, `score out of bounds: ${score}`);
  const total = explain.reduce((a, e) => a + e.points, 0);
  assert.ok(Math.abs(total - score) < 3, `explain ${total} should ≈ score ${score}`);
  assert.ok(explain.find((e) => e.factor === "skills")!.points > 20, "skills weight 0.35 should contribute heavily");
  const weights = explain.filter((e) => !["seen_penalty", "feedback"].includes(e.factor)).map((e) => e.factor);
  assert.ok(weights.includes("freshness") && weights.includes("salary"));
});

test("skills overlap expands synonyms (k8s ≈ kubernetes, js ≈ typescript-ish families)", () => {
  const r = skillsOverlap({ skills: ["Kubernetes"] } as any, { title: "Platform Engineer", description: "k8s and GKE" });
  assert.ok(r.value > 0, "k8s should match kubernetes via synonym group");
  assert.ok(r.matched.includes("Kubernetes"));
});

test("freshness decays with age (exp(-age/7))", () => {
  assert.equal(freshness(null).value, 0.5);
  const today = freshness(new Date().toISOString()).value;
  const old = freshness(new Date(Date.now() - 30 * 86_400_000).toISOString()).value;
  assert.ok(today > 0.9 && old < 0.05, `today=${today} old=${old}`);
});

test("unknown salary is 0.5, not zero (honest ranking)", () => {
  const { value } = salaryFit({ salaryExpectation: 100000 } as any, { title: "x" } as any);
  assert.equal(value, 0.5);
});

test("applied/ignored penalty drags score down but never below 0", () => {
  const good = scorePosting(profile as any, posting);
  const penalised = scorePosting(profile as any, posting, { appliedOrIgnored: true });
  assert.ok(penalised.score < good.score);
  assert.ok(penalised.score >= 0);
  const emptyProfile = scorePosting({ skills: [] } as any, { title: "nothing here", description: "" } as any, { appliedOrIgnored: true });
  const emptyNoPenalty = scorePosting({ skills: [] } as any, { title: "nothing here", description: "" } as any);
  assert.ok(emptyProfile.score >= 0, `never below 0, got ${emptyProfile.score}`);
  assert.ok(emptyProfile.score < emptyNoPenalty.score, "penalty always reduces the score");
});

test("weights sum to 1.0 for the positive terms", () => {
  const sum = WEIGHTS.skills + WEIGHTS.title + WEIGHTS.seniority + WEIGHTS.location + WEIGHTS.salary + WEIGHTS.freshness + WEIGHTS.company_tier;
  assert.ok(Math.abs(sum - 1) < 1e-9, `sum=${sum}`);
});

test("extractKeywords finds technical terms", () => {
  const kws = extractKeywords("We use React, TypeScript, PostgreSQL and AWS. The role is great.");
  assert.ok(kws.includes("react") || kws.includes("typescript"));
  assert.ok(kws.length <= 18);
});
