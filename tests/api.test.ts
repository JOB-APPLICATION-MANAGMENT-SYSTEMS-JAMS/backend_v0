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
  const reasons = new Map<string, string>(res.json.data.skip_reasons.map((s: any) => [s.field, s.reason] as [string, string]));
  assert.match(reasons.get("Disability Status") ?? "", /voluntary/);
});

test("autofill match fills name parts and education selects from profile data", async () => {
  const put = await api("/profile", {
    method: "PUT",
    token,
    body: {
      identity: { middle_name: "Omokhagbo", graduation_year: 2028, heard_about: "LinkedIn" },
      education: [{ school: "State University", degree: "B.S.", field: "Computer Science" }],
    },
  });
  assert.equal(put.status, 200);

  const res = await api("/autofill/match", {
    method: "POST",
    token,
    body: {
      host: "jobs.riot.example",
      fields: [
        { name: "first_name", label: "First Name", type: "text" },
        { name: "last_name", label: "Last Name", type: "text" },
        { name: "preferred_first", label: "Preferred First Name", type: "text" },
        { name: "middle", label: "Middle Name", type: "text" },
        { name: "school", label: "School", type: "select-one" },
        { name: "degree", label: "Degree", type: "select-one" },
        { name: "discipline", label: "Discipline", type: "select-one" },
        { name: "grad_year", label: "Please select the year you anticipate graduating from your academic program.", type: "select-one" },
        { name: "hear", label: "How did you hear about this job?", type: "select-one" },
      ],
    },
  });
  assert.equal(res.status, 200);
  const map = new Map<string, any>(res.json.data.mappings.map((m: any) => [m.key, m]));
  assert.equal(map.get("identity.first_name")?.value, "Test");
  assert.equal(map.get("identity.last_name")?.value, "User");
  assert.equal(map.get("identity.middle_name")?.value, "Omokhagbo");
  assert.equal(map.get("identity.school")?.value, "State University");
  assert.equal(map.get("identity.degree")?.value, "B.S.");
  assert.equal(map.get("identity.field_of_study")?.value, "Computer Science");
  assert.equal(map.get("identity.graduation_year")?.value, "2028");
  assert.equal(map.get("identity.heard_about")?.value, "LinkedIn");
  // preferred-name resolves to first_name, not full_name
  assert.ok(!map.has("identity.full_name") || map.get("identity.full_name")?.field_index !== 2);
  assert.equal(res.json.data.skip_reasons.length, res.json.data.skipped.length, "every skip carries a human reason");
});

test("custom answers and profile-authored aliases steer matching", async () => {
  const put = await api("/profile", {
    method: "PUT",
    token,
    body: {
      identity: { autofill_answers: [{ match: "come in to the san francisco office", answer: "Yes, I live locally" }] },
      aliases: { "identity.email": ["reach me at"] },
    },
  });
  assert.equal(put.status, 200);

  const res = await api("/autofill/match", {
    method: "POST",
    token,
    body: {
      host: "jobs.custom.example",
      fields: [
        { name: "office_q", label: "Are you able to come in to the San Francisco office 3 days per week?", type: "radio" },
        { name: "reach", label: "Reach me at (email)", type: "text" },
      ],
    },
  });
  assert.equal(res.status, 200);
  const map = new Map<string, any>(res.json.data.mappings.map((m: any) => [m.key, m]));
  // the candidate's own answer beats dictionary matching for the same question
  assert.equal(map.get("custom.answer_0")?.value, "Yes, I live locally");
  assert.equal(map.get("custom.answer_0")?.method, "custom");
  assert.ok(map.get("custom.answer_0")!.confidence >= 0.85);
  // a profile-authored alias now participates in label matching
  assert.equal(map.get("identity.email")?.value, "t@t.t");
  assert.ok(res.json.data.skip_reasons.length === res.json.data.skipped.length);
});

test("resume upload turns a CV into reviewable profile answers", async () => {
  const resume = [
    "Jane Q. Doe",
    "Software Engineer",
    "jane.doe@example.com | (415) 555-0132 | San Francisco, CA",
    "linkedin.com/in/janedoe · github.com/janedoe",
    "",
    "Education",
    "State University, B.S. in Computer Science, Class of 2027",
  ].join("\n");

  const res = await api("/autofill/parse-resume", {
    method: "POST",
    token,
    body: { filename: "resume.txt", content_base64: Buffer.from(resume, "utf8").toString("base64") },
  });
  assert.equal(res.status, 200);
  const id = res.json.data.identity;
  assert.equal(id.email, "jane.doe@example.com");
  assert.match(id.phone, /415/);
  assert.equal(id.location, "San Francisco, CA");
  assert.equal(id.first_name, "Jane");
  assert.equal(id.last_name, "Doe");
  assert.equal(id.links?.linkedin, "https://linkedin.com/in/janedoe");
  assert.equal(id.links?.github, "https://github.com/janedoe");
  assert.equal(id.headline, "Software Engineer");
  assert.equal(id.school, "State University");
  assert.match(id.degree ?? "", /B\.S/);
  assert.equal(id.field_of_study, "Computer Science");
  assert.equal(id.graduation_year, "2027");

  const docx = await api("/autofill/parse-resume", {
    method: "POST",
    token,
    body: { filename: "resume.docx", content_base64: Buffer.from("PKzip-bytes", "utf8").toString("base64") },
  });
  assert.equal(docx.status, 415);
  assert.equal(docx.json.error.code, "UNSUPPORTED_FILE");
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

test("career-portal fields fill from saved answers; self-ID only from an explicit answer", async () => {
  // no gender saved yet → refused with a visible, human reason (never guessed)
  const before = await api("/autofill/match", {
    method: "POST",
    token,
    body: { host: "careers.example", fields: [{ name: "gender", label: "Gender: *", type: "radio" }] },
  });
  assert.equal(before.status, 200);
  assert.equal(before.json.data.mappings.length, 0);
  const beforeReasons = new Map<string, string>(before.json.data.skip_reasons.map((s: any) => [s.field, s.reason]));
  assert.match(beforeReasons.get("Gender: *") ?? "", /voluntary/);

  const put = await api("/profile", {
    method: "PUT",
    token,
    body: {
      identity: {
        date_of_birth: "10/16/2006",
        marital_status: "Single",
        gender: "Male",
        nationality: "Nigerian",
        religion: "Christianity",
        hobbies: "Making the society a better place",
        street: "Akai Itiam Mutual alliance estate plot 7",
        city: "Uyo",
        state: "Akwa Ibom",
        country: "Nigeria",
        zip: "22323",
        grade: "Second Class Upper",
        cgpa: "4.0",
        experience_years: "2",
        experience_months: "24",
        current_employer: "People growth africa",
        current_job_role: "Technical associate",
        current_responsibilities: "Full stack developer",
        previous_employer: "None",
        current_salary: "1000000-1500000",
        salary_expectation: "500000-1000000",
        referee1_name: "Hannah macaluey",
        referee1_email: "macauleyhannaheduok@gmail.com",
        referee1_phone: "09167114560",
        referee2_name: "Humble Rowland Chiedozie",
        referee2_email: "dev.mecurixtech@gmail.com",
        referee2_phone: "08177284542",
        links: { facebook: "https://facebook.com/israel", twitter: "https://x.com/israel" },
      },
    },
  });
  assert.equal(put.status, 200);

  const res = await api("/autofill/match", {
    method: "POST",
    token,
    body: {
      host: "careers.example",
      fields: [
        { label: "Date of Birth: *", type: "text" },
        { label: "Marital Status: *", type: "select" },
        { label: "Nationality: *", type: "select" },
        { label: "Religion:", type: "select" },
        { label: "Hobbies:", type: "textarea" },
        { label: "Source: *", type: "select" },
        { label: "Address: *", type: "text" },
        { label: "City: *", type: "text" },
        { label: "State/Province", type: "text" },
        { label: "Country: *", type: "select" },
        { label: "Zip/Postal Code", type: "text" },
        { label: "Grade: *", type: "select" },
        { label: "CGPA:", type: "text" },
        { label: "Experience in Years: *", type: "text" },
        { label: "Experience in Months: *", type: "text" },
        { label: "Current Employer: *", type: "text" },
        { label: "Currrent Job Role: *", type: "text" },
        { label: "Job Responsibilities (Current): *", type: "textarea" },
        { label: "Previous Employer:", type: "text" },
        { label: "Current Salary (per annum): *", type: "text" },
        { label: "Expected Salary (per annum): *", type: "text" },
        { label: "Referee Name 1: *", type: "text" },
        { label: "Referee Name 2: *", type: "text" },
        { label: "Referee Email 1: *", type: "text" },
        { label: "Referee Mobile Number 2: *", type: "text" },
        { label: "Facebook", type: "text" },
        { label: "X (formerly Twitter)", type: "text" },
        { label: "Gender: *", type: "radio" },
        { label: "Disability Status", type: "radio" },
      ],
    },
  });
  assert.equal(res.status, 200);
  const got = new Map<string, any>(res.json.data.mappings.map((m: any) => [m.key, m]));
  const expect: Record<string, string> = {
    "identity.date_of_birth": "10/16/2006",
    "identity.marital_status": "Single",
    "identity.nationality": "Nigerian",
    "identity.religion": "Christianity",
    "identity.hobbies": "Making the society a better place",
    "identity.heard_about": "LinkedIn",
    "identity.street": "Akai Itiam Mutual alliance estate plot 7",
    "identity.city": "Uyo",
    "identity.state": "Akwa Ibom",
    "identity.country": "Nigeria",
    "identity.zip": "22323",
    "identity.grade": "Second Class Upper",
    "identity.cgpa": "4.0",
    "identity.experience_years": "2",
    "identity.experience_months": "24",
    "identity.current_employer": "People growth africa",
    "identity.current_job_role": "Technical associate", // portal typo 'Currrent' included
    "identity.current_responsibilities": "Full stack developer",
    "identity.previous_employer": "None",
    "identity.current_salary": "1000000-1500000",
    "identity.salary_expectation": "500000-1000000",
    "identity.referee1_name": "Hannah macaluey",
    "identity.referee2_name": "Humble Rowland Chiedozie",
    "identity.referee1_email": "macauleyhannaheduok@gmail.com",
    "identity.referee2_phone": "08177284542",
    "identity.facebook": "https://facebook.com/israel",
    "identity.twitter": "https://x.com/israel",
  };
  for (const [key, value] of Object.entries(expect)) {
    assert.equal(got.get(key)?.value, value, `${key} should fill with ${JSON.stringify(value)}`);
    assert.ok(got.get(key)!.confidence >= 0.55, `${key} should reach fill confidence`);
  }
  // gender: explicit saved answer, never inferred
  assert.equal(got.get("identity.gender")?.value, "Male");
  assert.equal(got.get("identity.gender")?.method, "explicit");
  assert.equal(got.get("identity.gender")?.confidence, 0.9);
  // …and unrelated self-ID questions still refuse, even with a gender saved
  assert.ok(res.json.data.skipped.includes("Disability Status"));
  const reasons = new Map<string, string>(res.json.data.skip_reasons.map((s: any) => [s.field, s.reason]));
  assert.match(reasons.get("Disability Status") ?? "", /voluntary/);
  assert.equal(res.json.data.skip_reasons.length, res.json.data.skipped.length);
});
