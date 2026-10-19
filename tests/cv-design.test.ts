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
  const text = await res.text();
  return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

before(async () => {
  const { createApp } = await import("../src/app");
  const app = createApp();
  await new Promise<void>((r) => { server = app.listen(0, () => r()); });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 8000}`;
  const email = `design-${Date.now()}@test.local`;
  await api("/auth/register", { method: "POST", body: { email, password: "password123" } });
  const dev = await api(`/auth/dev-token?email=${encodeURIComponent(email)}`);
  await api("/auth/verify-email", { method: "POST", body: { token: dev.json.data.verification_token } });
  const login = await api("/auth/login", { method: "POST", body: { email, password: "password123" } });
  token = login.json.data.access_token;
});

after(() => server?.close());

test("design round-trips: saved on the CV, governs the sheet, overridable for preview", async () => {
  const made = await api("/cvs", { method: "POST", token, body: { name: "Design test" } });
  assert.equal(made.status, 201);
  const id = made.json.data.id;

  // a fresh CV renders the reference sheet
  const fresh = await api(`/cvs/${id}/html`, { token });
  assert.equal(fresh.status, 200);
  assert.ok(fresh.text.includes("width: 210mm; min-height: 297mm"), "A4 by default");
  assert.ok(fresh.text.includes("font: 400 14px/18px var(--serif)"), "reference type scale");
  assert.ok(fresh.text.includes("grid-template-columns: 147.73px 1fr"), "reference entry columns");

  const design = { page: "letter", base: 12, caps: "upper", dates: "month", accent: "#b35f00", icons: "circle-fill", headIcons: "filled", align: "left", datePos: "right", skillCols: 2, rule: false };
  const put = await api(`/cvs/${id}`, { method: "PUT", token, body: { design, blocks: [{ type: "summary", text: "Engineer." }, { type: "skills", groups: ["TypeScript"] }] } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json.data.design, design);

  const saved = await api(`/cvs/${id}/html`, { token });
  assert.ok(saved.text.includes("size: letter"), "Letter page box");
  assert.ok(saved.text.includes("#b35f00"), "hex accent reaches the sheet");
  assert.ok(saved.text.includes(">SKILLS</h2>") || saved.text.includes(">PROFILE</h2>") || saved.text.includes(">EDUCATION</h2>"), "uppercase headings");
  assert.ok(saved.text.includes("border-bottom: 0"), "rule off");

  // the editor's live preview overrides the stored design, without saving
  const draft = encodeURIComponent(JSON.stringify({ page: "a4" }));
  const override = await api(`/cvs/${id}/html?frame=1&design=${draft}`, { token });
  assert.ok(override.text.includes("width: 210mm; min-height: 297mm"), "draft design wins");
  assert.ok(!override.text.includes("#b35f00"), "stored accent not merged in");

  // garbage in the query is ignored, never a 500
  const junk = await api(`/cvs/${id}/html?design=%7Bnope`, { token });
  assert.equal(junk.status, 200);
  assert.ok(junk.text.includes("size: letter"), "falls back to the stored design");

  // and an invalid value in the body is rejected at the edge
  const bad = await api(`/cvs/${id}`, { method: "PUT", token, body: { design: { base: "huge" } } });
  assert.equal(bad.status, 422);

  // the ATS panel still reports pages, now measured against the designed sheet
  const m0 = await api(`/cvs/${id}/match`, { token });
  assert.equal(m0.status, 200);
  assert.ok(typeof m0.json.data.ats.pages === "number");

  // duplicate carries the design
  const dup = await api(`/cvs/${id}/duplicate`, { method: "POST", token });
  assert.deepEqual(dup.json.data.design, design);

  // and the list shape includes it
  const list = await api("/cvs", { token });
  assert.equal(list.json.data.items.find((c: any) => c.id === id).design.page, "letter");
});
