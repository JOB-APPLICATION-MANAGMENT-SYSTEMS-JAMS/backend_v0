/**
 * The redline is the promise that a poor ATS score comes with a fix, so these
 * tests are about the *rewrites*, not about the markup existing:
 *
 * - a weak opener becomes a verb, not a shorter weak opener
 * - first person, filler and misspellings disappear
 * - a line with no figure gets a green note, not a fabricated number
 * - a JD keyword becomes an insertion the user can accept or ignore
 * - the markup is keyed by the printed line, so the renderer cannot drift
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { polish, buildRedline } from "../src/lib/cv-redline";
import type { CvDoc } from "../src/lib/cv-document";

const doc = (body: string[], prose: string[] = []): CvDoc => ({
  name: "Test Person",
  contact: [],
  sections: [
    { head: "Summary", icon: "user", lines: prose.map((text) => ({ k: "prose" as const, text })) },
    {
      head: "Experience",
      icon: "briefcase",
      lines: [
        {
          k: "entry",
          when: "2023 — now",
          loc: "",
          title: "Engineer",
          org: "Acme",
          body,
        },
      ],
    },
  ],
});

test("a weak opener is replaced with the verb the role implies", () => {
  const { text, reasons } = polish("Responsible for managing a team of 5 engineers");
  assert.equal(text, "Managed a team of 5 engineers");
  assert.equal(reasons[0].rule, "weak-verb");
  assert.match(reasons[0].why, /Responsible for/i);
});

test("“worked on” becomes a shipping verb, not a synonym for it", () => {
  assert.equal(polish("Worked on the checkout rewrite").text, "Delivered the checkout rewrite");
  assert.equal(polish("Helped with incident reviews").text, "Supported incident reviews");
});

test("first person is dropped, and the sentence still starts with a capital", () => {
  const { text, reasons } = polish("I built a payments API with 12 endpoints");
  assert.equal(text, "Built a payments API with 12 endpoints");
  assert.equal(reasons[0].rule, "first-person");
});

test("passive voice at the start of a bullet becomes active", () => {
  const { text, reasons } = polish("was migrated to Kubernetes across 8 services");
  assert.equal(text, "Migrated to Kubernetes across 8 services");
  assert.equal(reasons[0].rule, "passive");
});

test("filler and wordy phrases are removed, not merely flagged", () => {
  const { text, reasons } = polish("Utilize various tools in order to build things on a daily basis");
  assert.equal(text, "Use tools to build things daily");
  assert.equal(reasons[0].rule, "filler");
});

test("common misspellings are corrected and named in the reason", () => {
  const { text, reasons } = polish("Recieve the seperate report and definately ship it");
  assert.equal(text, "Receive the separate report and definitely ship it");
  assert.equal(reasons[0].rule, "grammar");
  assert.match(reasons[0].why, /Spelling/i);
});

test("a/an agreement and a repeated word are fixed", () => {
  assert.equal(polish("Built a engineer dashboard for the the team").text, "Built an engineer dashboard for the team");
});

test("the redline strikes the printed line and offers the rewrite under the same key", () => {
  const line = "Responsible for maintaining the billing platform for 50,000 customers";
  const report = buildRedline({ doc: doc([line]) });
  assert.equal(report.counts.replace, 1);
  assert.equal(report.edits[0].before, line);
  assert.equal(report.edits[0].after, "Maintained the billing platform for 50,000 customers");
  assert.equal(report.markup[line].after, report.edits[0].after);
  assert.equal(report.counts.important, 1);
});

test("a line with no figure gets a green addition instead of an invented number", () => {
  const line = "Led the migration of the billing platform to Postgres";
  const report = buildRedline({ doc: doc([line]) });
  const add = report.edits.find((e) => e.rule === "no-figure");
  assert.ok(add, "a figureless achievement line should be flagged");
  assert.equal(add.kind, "add");
  assert.equal(add.before, line);
  assert.match(add.after, /add a figure/i);
  assert.doesNotMatch(add.after, /\d+%/, "the tool must not make a number up");
  assert.equal(report.markup[line].note, add.after, "the note lands on the printed line");
});

test("a line that already carries a metric is left alone", () => {
  const report = buildRedline({ doc: doc(["Cut p95 latency 40% across 12 services"]) });
  assert.equal(report.edits.length, 0);
  assert.match(report.summary, /nothing mechanical/i);
});

test("a JD keyword the CV never prints becomes an insertion the user can judge", () => {
  const summary = "Backend engineer with 8 years shipping payment systems";
  const report = buildRedline({ doc: doc([], [summary]), missingKeywords: ["Kubernetes", "Terraform"] });
  const keywordEdits = report.edits.filter((e) => e.rule === "keyword");
  assert.equal(keywordEdits.length, 2);
  assert.ok(keywordEdits.every((e) => e.kind === "add" && /genuinely true/i.test(e.after)));
  assert.ok(report.markup[summary].note?.includes("Kubernetes"));
});

test("a long quantified line is flagged for splitting", () => {
  const line =
    "Rebuilt the reconciliation pipeline end to end, replacing a nightly batch with an event-driven service that processes 2 million transactions a day and cut the finance team's close from nine days to two while keeping a full audit trail for the regulator";
  const report = buildRedline({ doc: doc([line]) });
  const split = report.edits.find((e) => e.rule === "too-long");
  assert.ok(split, "a 250+ character bullet should be flagged");
  assert.match(split.after, /split/i);
});

test("the hygiene score falls with the number of edits, and counts add up", () => {
  const clean = buildRedline({ doc: doc(["Cut p95 latency 40% across 12 services"]) });
  const messy = buildRedline({
    doc: doc(["Responsible for maintaining things", "I helped with the the platform", "Led the migration of the billing platform to Postgres"]),
  });
  assert.equal(clean.hygiene, 100);
  assert.ok(messy.hygiene < 100);
  assert.equal(messy.counts.replace + messy.counts.add, messy.edits.length);
  assert.equal(messy.counts.important + messy.counts.polish, messy.edits.length);
  assert.ok(messy.by_rule.length > 0 && messy.by_rule[0].count > 0);
});
