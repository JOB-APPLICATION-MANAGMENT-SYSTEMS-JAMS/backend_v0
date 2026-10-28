/**
 * Higher As runs on two promises that are easy to break by accident:
 *
 *   1. Nothing a professional does verifies their own credential. It stays
 *      `pending` until a platform reviewer decides, and expiry is derived.
 *   2. A review is "verified service" only against an engagement the customer
 *      created and the professional confirmed as completed. Self-reviews, second
 *      reviews and rating edits are all refused, and moderation can hide a review
 *      but never silently change a star rating.
 */
import "./setup";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Server } from "node:http";

let server: Server;
let base: string;
let tokenPro: string;
let tokenCustomer: string;
let tokenOther: string;
let tokenReviewer: string;
let proEmail: string;

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
  proEmail = `ha-pro-${stamp}@test.local`;
  tokenPro = await account(proEmail);
  tokenCustomer = await account(`ha-customer-${stamp}@test.local`);
  tokenOther = await account(`ha-other-${stamp}@test.local`);
  tokenReviewer = await account(`ha-reviewer-${stamp}@test.local`);

  // A reviewer is an explicit platform role, not something an account gets by asking.
  const { run } = await import("../src/core/db");
  await run("UPDATE users SET role = 'admin' WHERE email = ?", `ha-reviewer-${stamp}@test.local`);
});

after(() => server?.close());

let proId = "";

test("a professional publishes a profile with work, and the feed finds it", async () => {
  const pro = as(tokenPro);
  const created = await pro("/higher-as/me", {
    method: "PUT",
    body: {
      display_name: "Emeka Auto Works",
      trade: "mechanic",
      headline: "Engine diagnostics and cooling systems",
      summary: "Twelve years on Japanese saloons. Mobile diagnostics across Ikeja.",
      city: "Lagos",
      service_area: "Ikeja, Yaba, Surulere",
      years_experience: 12,
      phone: "+2348000000000",
      whatsapp: "+2348000000000",
      day_rate_min: 25000,
      day_rate_max: 60000,
    },
  });
  assert.equal(created.status, 200);
  proId = created.json.data.id;
  assert.equal(created.json.data.trade_label, "Mechanic");

  const post = await pro("/higher-as/posts", {
    method: "POST",
    body: { title: "Cooling system rebuild", body: "Replaced the water pump, thermostat and radiator hoses on a 2014 Corolla.", kind: "work", tags: ["cooling", "diagnostics"] },
  });
  assert.equal(post.status, 201);

  const feed = await as(tokenCustomer)("/higher-as/feed");
  assert.equal(feed.status, 200);
  const item = feed.json.data.items.find((x: any) => x.id === proId);
  assert.ok(item, "the profile appears in the feed");
  assert.equal(item.latest_post.title, "Cooling system rebuild");
  assert.ok(item.latest_post.auto_summary.includes("Mechanic"), "the auto summary is built from the professional's own words");
  assert.equal(item.rating.count, 0);

  // contact details are not in the list payload
  assert.equal(item.phone, undefined);

  const filtered = await as(tokenCustomer)("/higher-as/feed?trade=plumber");
  assert.equal(filtered.json.data.items.find((x: any) => x.id === proId), undefined, "a trade filter excludes other trades");

  const available = await as(tokenCustomer)("/higher-as/feed?available=true");
  assert.ok(available.json.data.items.some((x: any) => x.id === proId));
});

test("a submitted credential stays pending until a reviewer decides", async () => {
  const pro = as(tokenPro);
  const submitted = await pro("/higher-as/credentials", {
    method: "POST",
    body: { kind: "licence", title: "NATA vehicle inspection licence", issuer: "NATA", document_name: "licence.pdf", document_b64: "JVBERi0xLjQK" },
  });
  assert.equal(submitted.status, 201);
  const credId = submitted.json.data.id;
  assert.equal(submitted.json.data.status, "pending", "uploading a document is not verification");

  const own = await pro(`/higher-as/pros/${proId}`);
  assert.equal(own.json.data.credentials[0].status, "pending");
  assert.equal(own.json.data.credentials[0].document_name, "licence.pdf", "the owner sees their own document name");

  const seen = await as(tokenCustomer)(`/higher-as/pros/${proId}`);
  assert.equal(seen.json.data.credentials[0].status, "pending");
  assert.equal(seen.json.data.credentials[0].document_name, undefined, "the document is private");
  assert.equal(seen.json.data.credentials[0].document_b64, undefined);

  const selfReview = await pro(`/higher-as/credentials/${credId}/review`, { method: "POST", body: { decision: "verified" } });
  assert.equal(selfReview.status, 403, "the professional cannot verify their own credential");
  const customerReview = await as(tokenCustomer)(`/higher-as/credentials/${credId}/review`, { method: "POST", body: { decision: "verified" } });
  assert.equal(customerReview.status, 403);

  const queue = await as(tokenReviewer)("/higher-as/credentials/queue");
  assert.equal(queue.status, 200);
  assert.ok(queue.json.data.items.some((c: any) => c.id === credId));
  const doc = await as(tokenReviewer)(`/higher-as/credentials/${credId}/document`);
  assert.equal(doc.status, 200, "the reviewer can open the evidence");
  assert.equal(doc.json.data.b64, "JVBERi0xLjQK");
  const blocked = await as(tokenCustomer)(`/higher-as/credentials/${credId}/document`);
  assert.equal(blocked.status, 403);

  const verified = await as(tokenReviewer)(`/higher-as/credentials/${credId}/review`, {
    method: "POST",
    body: { decision: "verified", note: "Checked against the NATA register" },
  });
  assert.equal(verified.status, 200);
  const now = await as(tokenCustomer)(`/higher-as/pros/${proId}`);
  assert.equal(now.json.data.credentials[0].status, "verified");
  assert.equal(now.json.data.rating.count, 0, "a credential does not invent a review");
});

test("an expiring credential reports itself as expired without a background job", async () => {
  const pro = as(tokenPro);
  const submitted = await pro("/higher-as/credentials", {
    method: "POST",
    body: { kind: "certificate", title: "First aid at work", issuer: "Red Cross", expires_on: "2020-01-31" },
  });
  const credId = submitted.json.data.id;
  await as(tokenReviewer)(`/higher-as/credentials/${credId}/review`, { method: "POST", body: { decision: "verified" } });
  const seen = await as(tokenCustomer)(`/higher-as/pros/${proId}`);
  const row = seen.json.data.credentials.find((c: any) => c.id === credId);
  assert.equal(row.status, "expired", "verified once, but the date has passed");
});

test("reviews: self-reviews refused, verified only against a confirmed job, edits not duplicates", async () => {
  const pro = as(tokenPro);
  const customer = as(tokenCustomer);

  const selfReview = await pro(`/higher-as/pros/${proId}/reviews`, { method: "POST", body: { rating: 5, body: "Best mechanic in Lagos, honestly." } });
  assert.equal(selfReview.status, 403, "no reviewing your own profile");

  const unverified = await customer(`/higher-as/pros/${proId}/reviews`, {
    method: "POST",
    body: { rating: 4, body: "They turned up late but the repair held up." },
  });
  assert.equal(unverified.status, 201);
  assert.equal(unverified.json.data.verified, false, "no engagement, so it is unverified feedback");

  // editing your own review updates it instead of stacking a second one
  const edited = await customer(`/higher-as/pros/${proId}/reviews`, {
    method: "POST",
    body: { rating: 3, body: "They turned up late but the repair held up fine." },
  });
  assert.equal(edited.status, 201);
  assert.equal(edited.json.data.id, unverified.json.data.id);
  let seen = await as(tokenOther)(`/higher-as/pros/${proId}`);
  assert.equal(seen.json.data.rating.count, 1);
  assert.equal(seen.json.data.rating.avg, 3);
  assert.equal(seen.json.data.rating.verified, 0);

  // an unconfirmed engagement is not evidence
  const engagement = await customer(`/higher-as/pros/${proId}/engagements`, {
    method: "POST",
    body: { title: "Cooling system rebuild, June", detail: "Water pump and thermostat." },
  });
  assert.equal(engagement.status, 201);
  const engId = engagement.json.data.id;
  const premature = await as(tokenOther)(`/higher-as/pros/${proId}/engagements`, { method: "POST", body: { title: "Cooling system rebuild, June" } });
  assert.equal(premature.status, 201, "another customer can record their own job with the same title");
  const otherEngId = premature.json.data.id;
  const notConfirmed = await customer(`/higher-as/pros/${proId}/reviews`, {
    method: "POST",
    body: { rating: 5, body: "Great work on the cooling system.", engagement_id: engId },
  });
  assert.equal(notConfirmed.status, 422, "the professional has not confirmed this job yet");

  const foreignConfirm = await customer(`/higher-as/engagements/${engId}/confirm`, { method: "POST" });
  assert.equal(foreignConfirm.status, 404, "only the professional confirms their own job");
  const confirmed = await pro(`/higher-as/engagements/${engId}/confirm`, { method: "POST" });
  assert.equal(confirmed.status, 200);

  const verifiedReview = await customer(`/higher-as/pros/${proId}/reviews`, {
    method: "POST",
    body: { rating: 5, body: "Rebuilt the cooling system properly and explained the fault.", engagement_id: engId },
  });
  assert.equal(verifiedReview.status, 201);
  seen = await as(tokenOther)(`/higher-as/pros/${proId}`);
  assert.equal(seen.json.data.rating.count, 1, "still one review per customer");
  assert.equal(seen.json.data.rating.verified, 1);
  assert.equal(seen.json.data.rating.avg, 5, "the verified review replaced the earlier feedback");
  assert.equal(seen.json.data.reviews[0].verified, true);

  // the other account can also review, against its own engagement
  const secondCustomer = await as(tokenOther)(`/higher-as/pros/${proId}/reviews`, { method: "POST", body: { rating: 2, body: "Cheap and quick but the work needed a second visit." } });
  assert.equal(secondCustomer.status, 201);
  seen = await as(tokenCustomer)(`/higher-as/pros/${proId}`);
  assert.equal(seen.json.data.rating.count, 2);
  assert.equal(seen.json.data.rating.verified, 1, "only the confirmed engagement counts as verified");
  assert.deepEqual(
    seen.json.data.rating.distribution.map((d: any) => d.count),
    [1, 0, 0, 1, 0]
  );

  // eligibility is computed for the viewer, and `other` has not used their engagement
  const eligible = await as(tokenOther)(`/higher-as/pros/${proId}`);
  assert.equal(eligible.json.data.can_review, false, "they already reviewed");
  const fresh = await as(tokenReviewer)(`/higher-as/pros/${proId}`);
  assert.equal(fresh.json.data.can_review, false, "no engagement, so no verified review to write");
});

test("a professional can answer and dispute a review, but never edit its rating", async () => {
  const pro = as(tokenPro);
  const customer = as(tokenCustomer);
  const seen = await customer(`/higher-as/pros/${proId}`);
  const harsh = seen.json.data.reviews.find((r: any) => r.rating === 2);

  const foreign = await customer(`/higher-as/reviews/${harsh.id}/response`, { method: "POST", body: { response: "Not my job." } });
  assert.equal(foreign.status, 403, "only the reviewed professional responds");

  const answered = await pro(`/higher-as/reviews/${harsh.id}/response`, {
    method: "POST",
    body: { response: "The second visit was on us and the fault was a faulty part from the supplier." },
  });
  assert.equal(answered.status, 200);
  let after = await pro(`/higher-as/pros/${proId}`);
  let row = after.json.data.reviews.find((r: any) => r.id === harsh.id);
  assert.equal(row.rating, 2, "responding does not change the rating");
  assert.ok(row.response.includes("second visit was on us"));

  const disputed = await pro(`/higher-as/reviews/${harsh.id}/dispute`, { method: "POST", body: { reason: "This customer is not in our job records." } });
  assert.equal(disputed.status, 200);
  const duplicate = await pro(`/higher-as/reviews/${harsh.id}/dispute`, { method: "POST", body: { reason: "Sending it again to be sure." } });
  assert.equal(duplicate.status, 409, "one open dispute per review");

  const queue = await as(tokenReviewer)("/higher-as/moderation");
  assert.equal(queue.status, 200);
  assert.ok(queue.json.data.items.some((r: any) => r.id === harsh.id));

  const customerModerates = await customer(`/higher-as/reviews/${harsh.id}/moderate`, { method: "POST", body: { outcome: "upheld" } });
  assert.equal(customerModerates.status, 403);

  // upheld hides the review from aggregates; the rating value it carried is untouched
  const upheld = await as(tokenReviewer)(`/higher-as/reviews/${harsh.id}/moderate`, { method: "POST", body: { outcome: "upheld", note: "No matching job record." } });
  assert.equal(upheld.status, 200);
  after = await pro(`/higher-as/pros/${proId}`);
  assert.equal(after.json.data.reviews.find((r: any) => r.id === harsh.id).rating, 2, "the star value is still what the customer wrote");
  assert.equal(after.json.data.rating.count, 1, "the hidden review leaves the public aggregate");
  assert.equal(after.json.data.rating.avg, 5);
  const hiddenFromOthers = await as(tokenOther)(`/higher-as/pros/${proId}`);
  assert.equal(hiddenFromOthers.json.data.reviews.find((r: any) => r.id === harsh.id), undefined);
});

test("contact details need a session and a saved professional persists", async () => {
  const anon = await raw(`/higher-as/pros/${proId}/contact`);
  assert.equal(anon.status, 401);

  const customer = as(tokenCustomer);
  const contact = await customer(`/higher-as/pros/${proId}/contact`);
  assert.equal(contact.status, 200);
  assert.equal(contact.json.data.phone, "+2348000000000");
  assert.ok(contact.json.data.note.includes("not verified"));

  const saved = await customer(`/higher-as/pros/${proId}/save`, { method: "POST" });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.data.saved, true);
  const list = await customer("/higher-as/feed?saved=true");
  assert.ok(list.json.data.items.some((x: any) => x.id === proId));
  const cleared = await customer(`/higher-as/pros/${proId}/save`, { method: "POST" });
  assert.equal(cleared.json.data.saved, false);
  const empty = await customer("/higher-as/feed?saved=true");
  assert.equal(empty.json.data.items.length, 0);
});

test("profile and post input is validated on the server", async () => {
  const pro = as(tokenPro);
  const badTrade = await pro("/higher-as/me", { method: "PUT", body: { display_name: "Test", trade: "astronaut" } });
  assert.equal(badTrade.status, 422);

  const rates = await pro("/higher-as/me", {
    method: "PUT",
    body: { display_name: "Emeka Auto Works", trade: "mechanic", day_rate_min: 90000, day_rate_max: 10000 },
  });
  assert.equal(rates.status, 422, "a minimum above the maximum is refused");

  const shortBody = await as(tokenCustomer)(`/higher-as/pros/${proId}/reviews`, { method: "POST", body: { rating: 5, body: "good" } });
  assert.equal(shortBody.status, 422);
  const badRating = await as(tokenCustomer)(`/higher-as/pros/${proId}/reviews`, { method: "POST", body: { rating: 9, body: "Out of range rating text here." } });
  assert.equal(badRating.status, 422);

  const postWithoutPro = await as(tokenReviewer)("/higher-as/posts", { method: "POST", body: { title: "Nothing to attach this to" } });
  assert.equal(postWithoutPro.status, 422, "a post needs a professional profile first");

  const unknownPro = await as(tokenCustomer)("/higher-as/pros/00000000-0000-0000-0000-000000000000");
  assert.equal(unknownPro.status, 404);
});
