import "./setup";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

let server: Server;
let base: string;
let token: string;

async function api(path: string, opts: { method?: string; body?: any; token?: string } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json", ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json: any = await res.json().catch(() => null);
  return { status: res.status, json, headers: res.headers };
}

before(async () => {
  const { createApp } = await import("../src/app");
  const app = createApp();
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 8000}`;
});

after(() => server?.close());

test("healthz envelope", async () => {
  const { status, json } = await api("/healthz");
  assert.equal(status, 200);
  assert.equal(json.status, "success");
  assert.equal(json.status_code, 200);
  assert.ok("data" in json);
});

test("register → unverified login gets REQUIRES_VERIFICATION → verify → login", async () => {
  const email = `contract-${Date.now()}@test.local`;
  const reg = await api("/auth/register", { method: "POST", body: { email, password: "password123" } });
  assert.equal(reg.status, 201);
  assert.equal(reg.json.data.requires_verification, true);

  const blocked = await api("/auth/login", { method: "POST", body: { email, password: "password123" } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, "REQUIRES_VERIFICATION");
  assert.equal(blocked.json.error.fields.requires_verification, true);

  const dev = await api(`/auth/dev-token?email=${encodeURIComponent(email)}`);
  const verify = await api("/auth/verify-email", { method: "POST", body: { token: dev.json.data.verification_token } });
  assert.equal(verify.status, 200);

  const login = await api("/auth/login", { method: "POST", body: { email, password: "password123" } });
  assert.equal(login.status, 200);
  assert.ok(login.json.data.access_token);
  token = login.json.data.access_token;

  const me = await api("/auth/me", { token });
  assert.equal(me.json.data.user.email, email);
});

test("auth guard: 401 UNAUTHENTICATED without token", async () => {
  const { status, json } = await api("/profile");
  assert.equal(status, 401);
  assert.equal(json.error.code, "UNAUTHENTICATED");
});

test("validation errors use FastAPI-shaped detail array (422)", async () => {
  const { status, json } = await api("/auth/register", { method: "POST", body: { email: "nope", password: "short" } });
  assert.equal(status, 422);
  assert.ok(Array.isArray(json.detail));
  assert.ok(json.detail[0].loc && json.detail[0].msg && json.detail[0].type);
});

test("profile save → completeness improves", async () => {
  const before = await api("/profile/completeness", { token });
  const put = await api("/profile", {
    method: "PUT",
    token,
    body: {
      identity: { name: "Test User", headline: "Engineer", email: "t@t.t", location: "Lagos" },
      skills: [{ name: "TypeScript" }, { name: "React" }, { name: "Node.js" }, { name: "Postgres" }, { name: "AWS" }],
      experiences: [{ company: "Acme", title: "Dev", bullets: ["shipped things"] }],
    },
  });
  assert.equal(put.status, 200);
  assert.equal(put.json.data.version, 2);
  const after = await api("/profile/completeness", { token });
  assert.ok(after.json.data.score > before.json.data.score);
});

test("application lifecycle: create → status change → invalid transition 409 → events", async () => {
  const created = await api("/applications", {
    method: "POST",
    token,
    body: { company_name: "Contract Co", role_title: "Backend Engineer", source: "manual" },
  });
  assert.equal(created.status, 201);
  const id = created.json.data.id;
  assert.equal(created.json.data.status, "saved");

  const applied = await api(`/applications/${id}/status`, { method: "POST", token, body: { status: "applied" } });
  assert.equal(applied.status, 200);
  assert.ok(applied.json.data.applied_at);

  const bad = await api(`/applications/${id}/status`, { method: "POST", token, body: { status: "saved" } });
  assert.equal(bad.status, 409);
  assert.equal(bad.json.error.code, "INVALID_TRANSITION");

  const events = await api(`/applications/${id}/events`, { token });
  const types = events.json.data.items.map((e: any) => e.type);
  assert.ok(types.includes("created") && types.includes("applied") && types.includes("status_changed"));
});

test("goal counts effort when application is marked applied", async () => {
  const t0 = await api("/streaks/today", { token });
  const beforeCount = t0.json.data.count;
  const created = await api("/applications", { method: "POST", token, body: { company_name: "Effort Co", role_title: "FE" } });
  await api(`/applications/${created.json.data.id}/status`, { method: "POST", token, body: { status: "applied" } });
  const t1 = await api("/streaks/today", { token });
  assert.equal(t1.json.data.count, beforeCount + 1);
});

test("capture preview parses supplied HTML without network", async () => {
  const html = `<html><head><title>Staff Engineer — Ramp</title>
    <script type="application/ld+json">{"@type":"JobPosting","title":"Staff Engineer","hiringOrganization":{"name":"Ramp"},"datePosted":"2026-09-20","jobLocationType":"TELECOMMUTE"}</script>
    </head><body>Salary: $180k-$220k. We build payment rails with TypeScript and Postgres.</body></html>`;
  const res = await api("/capture/preview", { method: "POST", token, body: { url: "https://ramp.example/jobs/staff", html_text: html } });
  assert.equal(res.status, 200);
  assert.equal(res.json.data.parsed.company, "Ramp");
  assert.ok(res.json.data.parsed.salary_min);
  assert.ok(res.json.data.parsed.keywords.length > 0);
});

test("capture creates posting + draft application", async () => {
  const html = `<html><head><title>Platform Engineer — Kestrel</title></head><body>Pay: $140,000. Kubernetes, Go.</body></html>`;
  const res = await api("/capture", { method: "POST", token, body: { source: "paste", url: "https://kestrel.example/jobs/p1", html_text: html, action: "create_draft" } });
  assert.equal(res.status, 201);
  assert.ok(res.json.data.posting_id);
  assert.ok(res.json.data.application_id);
  assert.ok(res.json.data.warnings.length >= 0);
});

test("autofill match fills name/email with high confidence and never passwords", async () => {
  const res = await api("/autofill/match", {
    method: "POST",
    token,
    body: {
      host: "boards.example.com",
      fields: [
        { name: "full_name", label: "Full name", autocomplete: "name", type: "text" },
        { name: "email", label: "Email address", autocomplete: "email", type: "email" },
        { name: "password", label: "Password", autocomplete: "current-password", type: "password" },
        { name: "why_us", label: "Why do you want to work here?", type: "textarea" },
      ],
    },
  });
  assert.equal(res.status, 200);
  const map = new Map<string, any>(res.json.data.mappings.map((m: any) => [m.key, m]));
  assert.equal(map.get("identity.full_name")?.value, "Test User");
  assert.ok(map.get("identity.full_name")!.confidence >= 0.85);
  assert.equal(map.get("identity.email")?.value, "t@t.t");
  assert.ok(!res.json.data.mappings.some((m: any) => m.key.includes("password")));
  assert.ok(res.json.data.skipped.length >= 1, "unmatched fields are skipped, not guessed");
});

test("autofill match handles long exam-style radio questions and skips EEOC self-ID", async () => {
  const put = await api("/profile", {
    method: "PUT",
    token,
    body: { identity: { sponsorship: "No", work_authorization: "Yes", relocation: "Yes, I live locally" } },
  });
  assert.equal(put.status, 200);

  const res = await api("/autofill/match", {
    method: "POST",
    token,
    body: {
      host: "jobs.ashby.example",
      fields: [
        { name: "office_q", label: "Are you able to come in to the San Francisco office 3 days per week (Monday, Tuesday, Thursday)?", type: "radio" },
        { name: "auth_q", label: "Are you legally authorized to work in the United States? (Yes/No)", type: "radio" },
        { name: "sponsor_q", label: "Will you now or in the future require sponsorship for employment visa status (e.g., H-1B, TN, etc.)?", type: "radio" },
        { name: "eeoc_q", label: "Disability Status", type: "radio" },
        { name: "password", label: "Password", autocomplete: "current-password", type: "password" },
      ],
    },
  });
  assert.equal(res.status, 200);
  const map = new Map<string, any>(res.json.data.mappings.map((m: any) => [m.key, m]));
  assert.equal(map.get("identity.sponsorship")?.value, "No");
  assert.ok(map.get("identity.sponsorship")!.confidence >= 0.55, "long question matched via label containment");
  assert.equal(map.get("identity.work_authorization")?.value, "Yes");
  assert.equal(map.get("identity.relocation")?.value, "Yes, I live locally");
  assert.ok(res.json.data.skipped.includes("Disability Status"), "EEOC self-ID never auto-answered");
  assert.ok(!res.json.data.mappings.some((m: any) => m.key.includes("password")));
});

test("analytics summary has kpis with value/prev/delta and funnel keys", async () => {
  const res = await api("/analytics/summary?period=week", { token });
  assert.equal(res.status, 200);
  const k = res.json.data.kpis;
  for (const key of ["applications", "replies", "ghosted", "interviews", "offers", "response_rate", "streak"]) {
    assert.ok(key in k, `missing kpi ${key}`);
  }
  assert.ok(typeof k.applications.value === "number");
  assert.ok(Array.isArray(res.json.data.funnel));
  assert.ok(res.json.data.funnel.some((f: any) => f.key === "applied"));
});

test("rate limit headers present on search class", async () => {
  const res = await api("/jobs/search?q=react", { token });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("x-ratelimit-limit"));
  assert.ok(res.headers.get("x-ratelimit-remaining"));
  assert.equal(res.json.data.pagination.page, 1);
  assert.ok(Array.isArray(res.json.data.items));
  assert.ok("sources_ok" in res.json.data && "took_ms" in res.json.data, "partial-success fields (§33.4)");
});

test("send requires confirm flag (human-in-the-loop)", async () => {
  const draft = await api("/outreach", { method: "POST", token, body: { subject: "Hello", body: "Hi there" } });
  assert.equal(draft.status, 201);
  const noConfirm = await api(`/outreach/${draft.json.data.id}/send`, { method: "POST", token, body: { via: "gmail_open" } });
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.json.error.code, "CONFIRM_REQUIRED");
  const okSend = await api(`/outreach/${draft.json.data.id}/send`, { method: "POST", token, body: { via: "gmail_open", confirm: true } });
  assert.equal(okSend.status, 200);
  assert.ok(okSend.json.data.compose_url.includes("mail.google.com"));
  assert.equal(okSend.json.data.state, "sent_unverified");
});

test("export returns JSON payload with applications", async () => {
  const res = await api("/export?format=json", { token });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.json.data.applications));
  assert.ok(res.json.data.exported_at);
});
