/**
 * Pitch composer (§19.1): category-aware wording, seeded variants, grammar passes,
 * and the audit score the preview shows. Pure functions, no network, no db.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { composePitch, scorePitch, polish, resolveProfile, hashSeed, mulberry32 } from "../src/services/pitch-rewrite";

test("same seed reproduces the same email, a new seed rewords it", async () => {
  const input = { kind: "pitch" as const, category: "airline", company: "Arik Air", city: "Lagos", seed: "list:airline:x" };
  const a = await composePitch(input);
  const b = await composePitch(input);
  assert.equal(a.subject, b.subject, "deterministic for the same seed");
  assert.equal(a.body, b.body);

  const c = await composePitch({ ...input, seed: `${Date.now()}` });
  const differs = a.subject !== c.subject || a.body !== c.body;
  assert.ok(differs, "Refresh (new seed) must produce different wording");
});

test("category decides the hooks: a bank is not an NGO", async () => {
  const bank = await composePitch({ kind: "pitch", category: "bank", company: "First Bank", seed: 7 });
  const ngo = await composePitch({ kind: "pitch", category: "humanitarian", company: "Relief Aid", seed: 7 });
  const bankWords = `${bank.subject}\n${bank.body}`.toLowerCase();
  const ngoWords = `${ngo.subject}\n${ngo.body}`.toLowerCase();

  assert.match(bankWords, /reconcil|audit|banking|core banking/, "bank profile hooks surface");
  assert.match(ngoWords, /programme|donor|beneficiary|field/, "humanitarian hooks surface");
  assert.notEqual(bank.body, ngo.body);
  assert.equal(resolveProfile("bank").key, "bank");
  assert.equal(resolveProfile("waste management").key, "waste");
  assert.equal(resolveProfile("software engineer").key, "tech");
});

test("applications address the role, pitches address the company", async () => {
  const app = await composePitch({ kind: "application", category: "software_engineering", company: "Paystack", role: "Backend Engineer", seed: 3 });
  assert.match(app.body, /Backend Engineer/, "role named in an application");
  assert.ok(app.subject.toLowerCase().includes("backend engineer") || app.subject.includes("Paystack"));

  const pitch = await composePitch({ kind: "pitch", category: "agriculture", company: "Flour Mill", seed: 3 });
  assert.ok(pitch.body.includes("Flour Mill"), "company named in a pitch");
});

test("polish fixes articles, spacing, capitals and repeated openers", () => {
  const messy = "hi there.\n\nthis is a a message about a hour of work. we  built a API for them.\n\nbest regards,";
  const out = polish(messy);
  assert.ok(!/ {2}/.test(out), "no double spaces");
  assert.ok(!/\ba hour\b/i.test(out), "a → an");
  assert.ok(!/\ba API\b/i.test(out), "a → an before a vowel sound");
  assert.ok(!/\b(a|the|it|we|they) \1\b/i.test(out), "no doubled words");
  assert.match(out, /This is/, "sentence capitalisation");
});

test("polish never breaks {{merge.token}} placeholders", () => {
  const body = "best regards,\n\n{{profile.first_name}} {{profile.last_name}} for {{company.name}}";
  const out = polish(body);
  assert.ok(out.includes("{{profile.first_name}}"), "first_name token intact");
  assert.ok(out.includes("{{profile.last_name}}"), "last_name token intact");
  assert.ok(out.includes("{{company.name}}"), "company token intact");
  assert.ok(!/\{\{\s/.test(out), "no space inserted after the token's dot");

  // real punctuation still gets the space after it (and the next sentence capitalised)
  const spaced = polish("we built it.now works");
  assert.match(spaced, /it\. Now/);
});

test("score rewards personalisation, brevity and a next step", async () => {
  const good = await composePitch({ kind: "pitch", category: "retail", company: "Shoprite", city: "Lagos", seed: 11 });
  assert.ok(good.score >= 70, `composed pitch should score well, got ${good.score}`);
  assert.ok(good.checks.length >= 8, "per-check detail is returned");
  assert.ok(good.checks.every((c) => typeof c.weight === "number" && c.detail), "each check explains itself");

  const thin = scorePitch("Hello.\n\nI can help.\n\nRegards,", { company: "Shoprite", category: "retail", kind: "pitch" });
  assert.ok(thin.score < good.score, "a thin message must score below a composed one");

  // filler words are penalised
  const padded = scorePitch(
    `Hi Shoprite team,\n\nI am very really quite sure we could maybe help you with your work if you would like to reply to me.\n\nBest regards,\nMe`,
    { company: "Shoprite", category: "retail", kind: "pitch" }
  );
  const fillerCheck = padded.checks.find((c) => c.label === "No filler")!;
  assert.equal(fillerCheck.pass, false, "filler words are flagged");
});

test("PRNG is deterministic and bounded", () => {
  const a = mulberry32(hashSeed("x", 1));
  const b = mulberry32(hashSeed("x", 1));
  assert.equal(a(), b());
  assert.equal(hashSeed("a"), hashSeed("a"));
  assert.notEqual(hashSeed("a"), hashSeed("b"));
  for (let i = 0; i < 20; i++) {
    const v = mulberry32(hashSeed("y", i))();
    assert.ok(v >= 0 && v < 1, "PRNG output is a fraction");
  }
});
