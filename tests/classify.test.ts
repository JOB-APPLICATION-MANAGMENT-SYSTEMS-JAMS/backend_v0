import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, correctionEffect } from "../src/services/classify.service";
import { canTransition, TRANSITIONS, STATUSES } from "../src/services/application.service";
import { mergeTemplate, extractVars } from "../src/services/cv.service";
import { similarity } from "../src/services/autofill.service";

test("auto-reply headers win", () => {
  const r = classify({ headers: { "Auto-Submitted": "auto-replied" }, subject: "Re: your application" });
  assert.equal(r.classification, "auto_reply");
});

test("rejection lexicon matches", () => {
  assert.equal(classify({ subject: "Update", body: "Unfortunately we are not moving forward with other candidates." }).classification, "rejected");
});

test("interview invite beats generic interest ordering-wise", () => {
  assert.equal(classify({ body: "We'd like to schedule a call next week. Are you free?" }).classification, "interview_invite");
});

test("neutral fallback with reason", () => {
  const r = classify({ body: "Thanks, got it." });
  assert.equal(r.classification, "neutral");
  assert.ok(r.reason.length > 0);
});

test("classification drives sequence pause + status bump", () => {
  assert.deepEqual(correctionEffect("interview_invite"), { statusBump: "interview", pauseSequence: true });
  assert.deepEqual(correctionEffect("rejected"), { statusBump: "rejected", pauseSequence: true });
  assert.equal(correctionEffect("neutral").pauseSequence, false);
});

test("transition map: terminals are terminal, ghosts can be resurrected", () => {
  assert.equal(canTransition("offer", "applied"), false);
  assert.equal(canTransition("rejected", "interview"), false);
  assert.equal(canTransition("applied", "interview"), true);
  assert.equal(canTransition("ghosted", "applied"), true);
  assert.equal(canTransition("saved", "offer"), false);
  for (const s of STATUSES) assert.ok(Array.isArray(TRANSITIONS[s]), `${s} needs a transition list`);
});

test("template merge supports defaults", () => {
  const out = mergeTemplate("Hi {{contact.first_name | default: \"hiring team\"}}, role={{posting.role}}", { posting: { role: "Backend" } });
  assert.equal(out, "Hi hiring team, role=Backend");
  assert.deepEqual(extractVars("{{a}} {{b.x}} {{a}}"), ["a", "b.x"]);
});

test("label similarity behaves", () => {
  assert.equal(similarity("Email address", "Email address"), 1);
  assert.ok(similarity("Email address", "email address") === 1, "case-insensitive");
  assert.ok(similarity("What is your email?", "email") >= 0.35, `got ${similarity("What is your email?", "email")}`);
  assert.ok(similarity("What position are you applying for?", "job title") < 0.6, "unrelated labels stay low");
  assert.equal(similarity("", "email"), 0);
});
