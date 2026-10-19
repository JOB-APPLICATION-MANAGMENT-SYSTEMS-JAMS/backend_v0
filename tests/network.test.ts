/**
 * The network surfaces are the part of the product other people touch, so these
 * tests run through HTTP: a card is posted, another account finds it; a job is
 * gated on a profession and appears after it is set; an event search is a filter,
 * not just a ranking; a published CV can be reviewed and an unpublished one cannot.
 */
import "./setup";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

let server: Server;
let base: string;
let tokenA: string;
let tokenB: string;

async function raw(path: string, opts: { method?: string; body?: any; token?: string } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json", ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}
const as = (token: string) => (path: string, opts: { method?: string; body?: any } = {}) => raw(path, { ...opts, token });

async function account(email: string) {
  await raw("/auth/register", { method: "POST", body: { email, password: "password123" } });
  const dev = await raw(`/auth/dev-token?email=${encodeURIComponent(email)}`);
  await raw("/auth/verify-email", { method: "POST", body: { token: dev.json?.data?.verification_token } });
  const login = await raw("/auth/login", { method: "POST", body: { email, password: "password123" } });
  return login.json?.data?.access_token as string;
}

before(async () => {
  const { createApp } = await import("../src/app");
  const app = createApp();
  await new Promise<void>((r) => {
    server = app.listen(0, () => r());
  });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 8000}`;
  const stamp = Date.now();
  tokenA = await account(`network-a-${stamp}@test.local`);
  tokenB = await account(`network-b-${stamp}@test.local`);
});

after(() => server?.close());

test("a posted card reaches the directory with its answers and links", async () => {
  const a = as(tokenA);
  await a("/profile", {
    method: "PUT",
    body: {
      identity: { name: "Ada Card", headline: "Frontend engineer", location: "Lagos, Nigeria", links: { linkedin: "https://linkedin.com/in/ada" } },
      skills: [{ name: "React" }],
    },
  });
  const saved = await a("/people/me", {
    method: "PUT",
    body: {
      name: "Ada Card",
      headline: "Frontend engineer",
      profession: "frontend engineer",
      location: "Lagos",
      offers: ["Design system audits"],
      open_to: ["full-time"],
      links: { linkedin: "https://linkedin.com/in/ada", github: "https://github.com/ada" },
      answers: [{ q: "What do you actually do all day?", a: "I ship component libraries." }],
    },
  });
  assert.equal(saved.status, 200);
  const me = saved.json.data.me;
  // “frontend engineer” is the same shelf as software engineering
  assert.equal(me.profession, "software engineering");
  assert.deepEqual(me.links, { linkedin: "https://linkedin.com/in/ada", github: "https://github.com/ada" });
  assert.equal(me.answers[0].a, "I ship component libraries.");

  const b = as(tokenB);
  const list = await b("/people");
  assert.equal(list.status, 200);
  const found = list.json.data.items.find((p: any) => p.name === "Ada Card");
  assert.ok(found, "the card is visible to another account");
  assert.ok(found.match.reasons.length > 0, "the card explains why it ranked where it did");
  assert.equal(found.is_me, false);

  const mine = await b("/people");
  assert.equal(mine.json.data.viewer.has_profile, false, "B has not posted a card");

  const detail = await b(`/people/${found.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.data.answers[0].q, "What do you actually do all day?");
});

test("Hirers asks for a profession, then ranks the platform jobs by it", async () => {
  const b = as(tokenB);
  const before = await b("/hirers/jobs");
  assert.equal(before.json.data.viewer.needs_profession, true);
  assert.ok(before.json.data.items.length >= 5, "demo listings make the page reviewable");
  assert.ok(before.json.data.items.every((j: any) => j.demo), "all of those are marked demo");

  const set = await b("/hirers/profession", { method: "POST", body: { profession: "product design" } });
  assert.equal(set.status, 200);
  assert.equal(set.json.data.profession, "product design");

  const after = await b("/hirers/jobs");
  assert.equal(after.json.data.viewer.needs_profession, false);
  assert.equal(after.json.data.items[0].profession, "product design", "the declared field ranks first");
  assert.ok(after.json.data.items[0].match.reasons.some((r: string) => r.includes("product design")));

  const posted = await b("/hirers/jobs", {
    method: "POST",
    body: {
      company: "Hiring Co",
      title: "Brand Designer",
      profession: "graphic design",
      seniority: "mid",
      location: "Lagos, Nigeria",
      description: "Own the brand system.",
      tags: ["figma"],
    },
  });
  assert.equal(posted.status, 201);
  const listed = await b("/hirers/jobs?q=Brand%20Designer");
  const job = listed.json.data.items.find((j: any) => j.title === "Brand Designer");
  assert.ok(job);
  assert.equal(job.mine, true);
  assert.equal(job.demo, false, "a member's posting is not demo data");
});

test("event search filters by category and the city filter is exact", async () => {
  const a = as(tokenA);
  await a("/profile", { method: "PUT", body: { identity: { name: "Ada Card", location: "Lagos, Nigeria" } } });

  const all = await a("/events");
  assert.ok(all.json.data.items.length >= 8, "seeded events exist");
  assert.equal(all.json.data.items[0].city, "Lagos", "the member's city ranks first");

  const fair = await a("/events?q=job%20fair");
  assert.ok(fair.json.data.items.length > 0);
  assert.ok(fair.json.data.items.every((e: any) => e.kind === "hiring"), "a fair is a hiring event, not every event tagged career");

  const training = await a("/events?q=bootcamp");
  assert.ok(training.json.data.items.some((e: any) => e.kind === "training"));
  assert.ok(training.json.data.items.every((e: any) => e.kind === "training"), "the category expands, the words do not leak");

  const abuja = await a("/events?city=Abuja");
  assert.ok(abuja.json.data.items.length > 0);
  assert.ok(abuja.json.data.items.every((e: any) => e.city === "Abuja"));

  const week = await a("/events?when=week");
  assert.ok(week.json.data.items.every((e: any) => new Date(e.starts_at).getTime() - Date.now() <= 8 * 86_400_000));
});

test("a published CV can be reviewed; unpublishing closes it again", async () => {
  const a = as(tokenA);
  const created = await a("/cvs", {
    method: "POST",
    body: {
      name: "Public CV",
      blocks: [
        { type: "summary", source: "local", text: "Responsible for building the payments dashboard." },
        { type: "experience", source: "profile" },
        { type: "skills", source: "profile" },
      ],
    },
  });
  const cvId = created.json.data.id;

  const match = await a(`/cvs/${cvId}/match`);
  assert.ok(match.json.data.redline.edits.length > 0, "weak copy produces a redline");
  assert.ok(match.json.data.advice.length > 0, "a score comes with a plan");
  const html = await fetch(`${base}/api/v1/cvs/${cvId}/html?redline=1`, { headers: { Authorization: `Bearer ${tokenA}` } }).then((r) => r.text());
  assert.match(html, /<del>/);
  assert.match(html, /<ins/);

  const b = as(tokenB);
  const privateRead = await b(`/cvs/${cvId}/reviews`);
  assert.equal(privateRead.status, 404, "a private CV is not readable by another account");

  await a(`/cvs/${cvId}/publish`, { method: "PUT", body: { public: true, copyright: "© 2026 Ada Card. All rights reserved." } });
  const publicHtml = await fetch(`${base}/api/v1/cvs/${cvId}/html`, { headers: { Authorization: `Bearer ${tokenA}` } }).then((r) => r.text());
  assert.match(publicHtml, /All rights reserved/);

  const self = await a(`/cvs/${cvId}/reviews`, { method: "POST", body: { rating: 5, body: "My own resume, which I naturally love." } });
  assert.equal(self.status, 422, "nobody reviews their own CV");

  const review = await b(`/cvs/${cvId}/reviews`, { method: "POST", body: { rating: 4, body: "Lead with the dashboard and a number.", relationship: "hirer" } });
  assert.equal(review.status, 201);
  assert.equal(review.json.data.count, 1);
  assert.equal(review.json.data.avg, 4);

  const owner = await a(`/cvs/${cvId}/reviews`);
  assert.equal(owner.json.data.items.length, 1);
  assert.equal(owner.json.data.items[0].relationship, "hirer");

  await a(`/cvs/${cvId}/publish`, { method: "PUT", body: { public: false } });
  const closed = await b(`/cvs/${cvId}/reviews`);
  assert.equal(closed.status, 404, "unpublishing closes the reviews to everyone but the owner");
});
