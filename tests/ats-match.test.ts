/**
 * The ATS / keyword report has to be true, specific and actionable, because the
 * studio prints a number next to it that people act on.
 *
 * These run through the real HTTP surface: register, save a profile, create a CV,
 * capture a posting with a real description, ask for the report. Each assertion
 * is about a claim the report makes to the user, so a check that goes back to
 * being cosmetic (a hardcoded list, an unconditional pass) fails here.
 */
import "./setup";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

type Check = { key: string; label: string; ok: boolean; severity: string; evidence: string; fix: string };
type Report = {
  ats: { score: number; checks: Check[]; pages: number; band: string; blockers: number; summary: string; weight_total: number; weight_earned: number };
  keywords: { matched: string[]; missing: string[]; coverage_pct: number | null; jd_total: number };
  jd_match: { score: number } | null;
  suggestions: string[];
};

let server: Server;
let base: string;
let token: string;

async function api<T = any>(path: string, opts: { method?: string; body?: any } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as { data: T } | null };
}

before(async () => {
  const { createApp } = await import("../src/app");
  const app = createApp();
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 8000}`;

  const email = `ats-${Date.now()}@test.local`;
  await fetch(`${base}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const dev = await (await fetch(`${base}/api/v1/auth/dev-token?email=${encodeURIComponent(email)}`)).json();
  await fetch(`${base}/api/v1/auth/verify-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: dev.data.verification_token }),
  });
  const login = await (
    await fetch(`${base}/api/v1/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    })
  ).json();
  token = login.data.access_token;
});

after(() => server?.close());

const check = (r: Report, key: string) => {
  const c = r.ats.checks.find((x) => x.key === key);
  assert.ok(c, `no ${key} check in the report`);
  return c;
};

test("every failing check describes what it looked at and what it found", async () => {
  // A profile with no phone and no links: this is the shape that used to score 80%
  // against a hardcoded checklist regardless of what the CV actually said.
  await api("/profile", {
    method: "PUT",
    body: {
      identity: { name: "Sparse Person", headline: "Engineer" },
      skills: [{ name: "TypeScript" }],
      experiences: [{ company: "Acme", title: "Dev", start_date: "2024/01", bullets: ["Shipped features"] }],
      education: [{ school: "Place", degree: "BSc", start_date: "2019/09" }],
    },
  });
  const created = await api<{ id: string }>("/cvs", {
    method: "POST",
    body: {
      name: "Sparse CV",
      blocks: [
        { type: "summary", source: "local", text: "Engineer." },
        { type: "experience", source: "profile" },
        { type: "education", source: "profile" },
        { type: "skills", source: "profile" },
      ],
    },
  });
  const id = created.json!.data.id;
  const { status, json } = await api<Report>(`/cvs/${id}/match`);
  assert.equal(status, 200);
  const r = json!.data;

  // The account email is used to fill the header even when the profile never set
  // one, so the printed contact row really does carry it — the check must read the
  // document and say so rather than guess from the profile form.
  const email = check(r, "email");
  assert.equal(email.ok, true);
  assert.equal(email.severity, "critical");
  assert.match(email.evidence, /prints in the header/, `evidence should name the source, got: ${email.evidence}`);
  assert.ok(email.evidence.includes("@"), "the evidence should quote the address that will print");

  const phone = check(r, "phone");
  assert.equal(phone.ok, false);
  assert.equal(check(r, "link").ok, false);
  assert.match(phone.evidence, /no phone number/i, `evidence should say what was found, got: ${phone.evidence}`);
  assert.ok(phone.fix.length > 0 && !/^Add email\/phone/.test(phone.fix), "the fix must be specific to this check");
  assert.equal(check(r, "quantified").ok, false, "prose with no figures is not quantitative");

  // The checks that this CV does satisfy must pass — the report is not all-red.
  assert.equal(check(r, "experience").ok, true);
  assert.equal(check(r, "education").ok, true);
  assert.equal(check(r, "skills").ok, true);
  assert.equal(check(r, "dates").ok, true);

  assert.ok(r.ats.score > 0 && r.ats.score < 100, `partial CV scored ${r.ats.score}`);
  assert.equal(r.ats.blockers, 0, "nothing critical is wrong here");
  assert.match(r.ats.summary, /polish/i);
  assert.equal(r.ats.weight_earned, r.ats.checks.reduce((n, c) => n + (c.ok ? { critical: 3, important: 2, polish: 1 }[c.severity as never] : 0), 0));
  assert.equal(r.ats.weight_total, r.ats.checks.reduce((n, c) => n + ({ critical: 3, important: 2, polish: 1 }[c.severity as never] ?? 0), 0));
  assert.equal(r.ats.score, Math.round((r.ats.weight_earned / r.ats.weight_total) * 100));
});

test("a complete CV clears every check and reports a page count", async () => {
  const current = await api<{ version: number }>("/profile");
  await api("/profile", {
    method: "PUT",
    body: {
      version: current.json!.data.version,
      identity: {
        name: "Complete Person",
        headline: "Senior Backend Engineer",
        email: "complete@test.local",
        phone: "+234 800 000 0000",
        location: "Lagos",
        links: { github: "https://github.com/x", linkedin: "https://linkedin.com/in/x" },
      },
      skills: [{ name: "TypeScript" }, { name: "Postgres" }, { name: "Node.js" }],
      experiences: [
        {
          company: "Acme",
          title: "Senior Backend Engineer",
          start_date: "2023/01",
          bullets: ["Cut p95 latency 40% across 12 services", "Led 4 engineers and shipped 30 releases"],
        },
      ],
      education: [{ school: "Place", degree: "BSc Software Engineering", start_date: "2015/09" }],
    },
  });
  const created = await api<{ id: string }>("/cvs", {
    method: "POST",
    body: {
      name: "Complete CV",
      career_category: "backend",
      blocks: [
        { type: "summary", source: "local", text: "Senior Backend Engineer with 12 years." },
        { type: "experience", source: "profile" },
        { type: "education", source: "profile" },
        { type: "skills", source: "profile" },
      ],
    },
  });
  const r = (await api<Report>(`/cvs/${created.json!.data.id}/match`)).json!.data;

  assert.deepEqual(r.ats.checks.filter((c) => !c.ok).map((c) => `${c.key}: ${c.evidence}`), [], "every check should pass");
  assert.equal(r.ats.score, 100);
  assert.equal(r.ats.band, "strong");
  assert.equal(r.ats.blockers, 0);
  assert.match(r.ats.summary, /ready to send/i);
  assert.equal(r.ats.pages, 1);
  assert.equal(r.suggestions.length, 0, "nothing to suggest for a clean CV");
});

test("a JD keyword that is absent is reported absent; a synonym of one is credited", async () => {
  // A posting captured the way a user captures one, so jd_keywords is computed
  // by the app itself rather than by the test.
  const captured = await api<{ posting_id: string }>("/capture", {
    method: "POST",
    body: {
      source: "paste",
      url: "https://example.com/jobs/backend-engineer",
      action: "log_only",
      page: {
        title: "Backend Engineer",
        company_guess: "Example Ltd",
        text_excerpt:
          "We need strong TypeScript and Postgres skills. You will work with Docker and Kubernetes. " +
          "Experience with GraphQL and Terraform is a plus. We build React interfaces too.",
      },
    },
  });
  const postingId = captured.json!.data.posting_id;

  const current = await api<{ version: number }>("/profile");
  await api("/profile", {
    method: "PUT",
    body: {
      version: current.json!.data.version,
      identity: { name: "K", headline: "Backend Engineer", email: "k@test.local", phone: "+234 800 0001", links: { github: "https://github.com/x" } },
      // `postgres` covers the posting's "Postgres"; nothing here covers Kubernetes or Terraform.
      skills: [{ name: "TypeScript" }, { name: "postgres" }, { name: "Docker" }],
      experiences: [
        { company: "Acme", title: "Backend Engineer", start_date: "2022/01", bullets: ["Cut latency 40%", "Shipped 20 services"] },
      ],
      education: [{ school: "Place", degree: "BSc", start_date: "2015/09" }],
    },
  });
  const created = await api<{ id: string }>("/cvs", {
    method: "POST",
    body: {
      name: "Keyword CV",
      career_category: "backend",
      blocks: [
        { type: "summary", source: "local", text: "Backend Engineer." },
        { type: "experience", source: "profile" },
        { type: "education", source: "profile" },
        { type: "skills", source: "profile" },
      ],
    },
  });
  const r = (await api<Report>(`/cvs/${created.json!.data.id}/match?posting_id=${postingId}`)).json!.data;

  assert.ok(r.keywords.jd_total >= 5, `expected the app to extract keywords, got ${r.keywords.jd_total}`);
  assert.ok(r.keywords.matched.length > 0, "the CV does contain some of the JD keywords");
  assert.ok(r.keywords.missing.length > 0, "the CV plainly lacks Kubernetes/Terraform");
  assert.equal(r.keywords.matched.length + r.keywords.missing.length, r.keywords.jd_total, "the partition must be complete");
  assert.equal(r.keywords.coverage_pct, Math.round((r.keywords.matched.length / r.keywords.jd_total) * 100));

  // Coverage drives a critical check and a suggestion naming the missing words.
  const kw = check(r, "keywords");
  assert.match(kw.evidence, /of \d+ keywords/);
  assert.equal(kw.ok, (r.keywords.coverage_pct ?? 0) >= 60);
  for (const m of r.keywords.missing.slice(0, 6)) {
    assert.ok(r.suggestions.some((s) => s.includes(m)), `no suggestion mentions the missing keyword ${m}`);
  }
  assert.ok(!r.suggestions.some((s) => s.includes("Add email/phone to your profile")), "the old hardcoded advice is gone");
  assert.ok(r.jd_match !== null && typeof r.jd_match.score === "number", "a posting gives a JD score");
});

test("the length check counts printed pages, so a CV over two pages fails", async () => {
  const long = Array.from({ length: 14 }, (_, i) => ({
    company: `Company ${i} Limited`,
    title: `Engineer ${i}`,
    start_date: `20${String(10 + (i % 9)).padStart(2, "0")}/01`,
    end_date: `20${String(10 + (i % 9)).padStart(2, "0")}/09`,
    bullets: [
      "Build and improve digital systems, infrastructure and technical workflows that support organizational operations worldwide.",
      "Develop new systems and technical solutions across web applications, APIs, cloud workflows and internal tools at scale.",
    ],
  }));
  const current = await api<{ version: number }>("/profile");
  await api("/profile", {
    method: "PUT",
    body: {
      version: current.json!.data.version,
      identity: { name: "Long Person", headline: "Engineer", email: "long@test.local", phone: "+234 800 0002", links: { github: "https://github.com/x" } },
      skills: [{ name: "TypeScript" }, { name: "Postgres" }],
      experiences: long,
      education: [{ school: "Place", degree: "BSc", start_date: "2010/09" }],
    },
  });
  const para =
    "Highly motivated Software Engineer with a strong foundation in full-stack web development, proficient in front-end technologies and back-end languages. Proven ability to build and deploy web applications, debug code, and optimize performance.";
  const created = await api<{ id: string }>("/cvs", {
    method: "POST",
    body: {
      name: "Long CV",
      blocks: [
        { type: "summary", source: "local", text: [para, para, para, para, para].join("\n\n") },
        { type: "experience", source: "profile" },
        { type: "education", source: "profile" },
        { type: "skills", source: "profile" },
      ],
    },
  });
  const r = (await api<Report>(`/cvs/${created.json!.data.id}/match`)).json!.data;

  const length = check(r, "length");
  assert.ok(r.ats.pages > 2, `expected more than two pages, got ${r.ats.pages}`);
  assert.equal(length.ok, false, "fourteen roles cannot fit on two pages");
  assert.equal(length.severity, "important");
  assert.equal(length.evidence, `renders as ${r.ats.pages} page${r.ats.pages === 1 ? "" : "s"}`);
  assert.ok(r.suggestions.includes("Trim older roles or drop the least relevant lines"));
});

test("a CV that prints nothing scores as empty, not as a checklist", async () => {
  // The shape the Studio creates for a new CV: every block sourced from the
  // profile. With nothing on the profile, none of them prints a line — and a
  // report that only asks whether the *block* exists called that 89% and green.
  const current = await api<{ version: number }>("/profile");
  await api("/profile", {
    method: "PUT",
    body: {
      version: current.json!.data.version,
      // identity merges on write, so clear the fields a previous test set; the
      // account email still reaches the header, which is the only thing that
      // legitimately prints on a CV like this
      identity: { name: "Empty Person", headline: "", phone: "", location: "", links: {} },
      skills: [],
      experiences: [],
      education: [],
    },
  });
  const created = await api<{ id: string }>("/cvs", {
    method: "POST",
    body: {
      name: "Empty CV",
      career_category: "software_engineering",
      blocks: [
        { type: "summary", source: "profile" },
        { type: "experience", source: "profile" },
        { type: "skills", source: "profile" },
        { type: "education", source: "profile" },
      ],
    },
  });
  const r = (await api<Report>(`/cvs/${created.json!.data.id}/match`)).json!.data;

  const content = check(r, "content");
  assert.equal(content.ok, false, "nothing prints, so there is no content to pass");
  assert.equal(content.severity, "critical");
  assert.match(content.evidence, /nothing prints/i, `evidence should say the page is empty, got: ${content.evidence}`);

  // Every section check reads the printed page, so each of these is a real fail.
  for (const key of ["experience", "education", "skills", "summary", "dates", "length", "quantified"]) {
    const c = check(r, key);
    assert.equal(c.ok, false, `${key} must not pass on an empty page (${c.evidence})`);
  }
  assert.match(check(r, "experience").evidence, /prints no roles/i);
  assert.match(check(r, "skills").evidence, /prints no names/i);

  assert.ok(r.ats.score < 25, `an empty CV scored ${r.ats.score}`);
  assert.equal(r.ats.band, "weak");
  assert.ok(r.ats.blockers >= 1, "an empty page is a critical blocker");
  assert.match(r.ats.summary, /nothing prints/i);
  assert.ok(
    r.suggestions.some((s) => /summary, a role/i.test(s)),
    `the empty page should be the first thing suggested, got: ${JSON.stringify(r.suggestions)}`,
  );
});

test("an important failure costs more of the score than a polish one", async () => {
  // Same CV, then flip only the phone (important) and only the links (polish).
  // The email is not used here because the account address fills the header
  // whatever the profile says, so there is no way to produce a missing-email
  // document through the API.
  const current = await api<{ version: number }>("/profile");
  const base_ = {
    name: "Weighted Person",
    headline: "Engineer",
    email: "w@test.local",
    phone: "+234 800 0003",
    links: { github: "https://github.com/x", linkedin: "https://linkedin.com/in/x" },
  };
  const put = async (identity: any) => {
    const v = await api<{ version: number }>("/profile");
    await api("/profile", { method: "PUT", body: { version: v.json!.data.version, identity, skills: [{ name: "TypeScript" }], experiences: [{ company: "A", title: "Dev", start_date: "2020/01", bullets: ["Cut cost 20%"] }], education: [{ school: "B", degree: "BSc", start_date: "2014/09" }] } });
  };
  const created = await api<{ id: string }>("/cvs", {
    method: "POST",
    body: {
      name: "Weighted CV",
      blocks: [
        { type: "summary", source: "local", text: "Engineer." },
        { type: "experience", source: "profile" },
        { type: "education", source: "profile" },
        { type: "skills", source: "profile" },
      ],
    },
  });
  const id = created.json!.data.id;

  const report = async () => (await api<Report>(`/cvs/${id}/match`)).json!.data;
  await put(base_);
  const full = await report();
  assert.deepEqual(full.ats.checks.filter((c) => !c.ok).map((c) => `${c.key}: ${c.evidence}`), [], "the baseline must be clean for the comparison to mean anything");

  await put({ ...base_, phone: "" });
  const noPhone = (await report()).ats.score;
  await put({ ...base_, links: {} });
  const noLinks = (await report()).ats.score;

  assert.equal(full.ats.score, 100);
  assert.ok(noPhone < noLinks, `dropping the phone (${noPhone}) must hurt more than dropping links (${noLinks})`);
  assert.ok(noLinks < full.ats.score);
  void current;
});
