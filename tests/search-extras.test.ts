/**
 * Pitch-first search (§25.4): Overpass query shape, email derivation rules, and
 * the social-platform search recipes the Discover page ships to the UI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { overpassQuery, deriveEmail, domainOf, normalizeElement, CITIES, CITY_KEYS } from "../src/services/pitch.service";
import { platformSearches, suggestedQueries, SOCIAL_PLATFORMS, baseQuery } from "../src/search/social";

test("overpassQuery covers the city bbox for every sector tag", () => {
  const q = overpassQuery("lagos", "supermarket");
  assert.ok(q.includes("[out:json]"), "must ask Overpass for JSON");
  const [s, w, n, e] = CITIES.lagos.bbox;
  assert.ok(q.includes(`(${s},${w},${n},${e})`), "bbox must be south,west,north,east");
  assert.ok(q.includes(`["shop"="supermarket"]`));
  assert.ok(q.includes("out tags center"), "center coords needed for map pins");

  const airport = overpassQuery("abuja", "airport");
  assert.ok(airport.includes(`["aeroway"="aerodrome"]`));
  assert.equal(CITY_KEYS.length, 3);
});

test("deriveEmail prefers published mailto, otherwise guesses info@domain", () => {
  assert.deepEqual(deriveEmail("mailto:jobs@acme.ng"), { email: "jobs@acme.ng", derived: false });
  assert.deepEqual(deriveEmail("https://www.acme.com.ng/careers"), { email: "info@acme.com.ng", derived: true });
  assert.deepEqual(deriveEmail("acme.ng"), { email: "info@acme.ng", derived: true });
  assert.deepEqual(deriveEmail(null), { email: null, derived: false });
  assert.deepEqual(deriveEmail("not a url ???"), { email: null, derived: false });
  assert.equal(domainOf("https://www.Example.com/path"), "example.com");
});

test("normalizeElement keeps only named, contactable companies and flags derived emails", () => {
  // published email wins and is NOT flagged derived
  const published = normalizeElement(
    { type: "node", id: 1, tags: { name: "Surulere Mart", "contact:email": "sales@surulere.ng", "contact:website": "https://surulere.ng", shop: "supermarket" } },
    "lagos",
    "supermarket"
  );
  assert.equal(published.email, "sales@surulere.ng");
  assert.equal(published.email_derived, 0);

  // website only → derived info@ address
  const derived = normalizeElement({ type: "way", id: 2, tags: { name: "Skyline Mfg", website: "https://skylineng.com" } }, "ogun", "manufacturing");
  assert.equal(derived.email, "info@skylineng.com");
  assert.equal(derived.email_derived, 1);

  // nameless entities are dropped; named-but-unknown stays as a lead with no email yet
  assert.equal(normalizeElement({ type: "node", id: 3, tags: { shop: "supermarket" } }, "lagos", "supermarket"), null);
  const lead = normalizeElement({ type: "node", id: 4, tags: { name: "Mystery Co" } }, "lagos", "company");
  assert.equal(lead.name, "Mystery Co");
  assert.equal(lead.email, null);
});

test("social recipes cover every platform with a runnable URL", () => {
  const recipes = platformSearches();
  assert.equal(recipes.length, SOCIAL_PLATFORMS.length);
  for (const r of recipes) {
    assert.ok(r.url.startsWith("https://"), `${r.platform} needs an absolute URL`);
    assert.ok(r.query.length > 0, `${r.platform} needs a query`);
    assert.ok(r.note.length > 0, `${r.platform} needs a hint`);
  }
  const x = recipes.find((r) => r.platform === "x")!;
  assert.ok(x.url.includes("x.com/search"));
  assert.ok(x.query.includes("since:30d"), "X uses the live tab, recent-only");
  const li = recipes.find((r) => r.platform === "linkedin")!;
  assert.ok(li.url.includes("linkedin.com/jobs/search"));
  assert.ok(li.url.includes("Nigeria"));

  // user query flows into the recipes and the query bar suggestions
  const custom = platformSearches("react engineer");
  assert.ok(custom[0].query.includes("react engineer"));
  assert.ok(custom[0].query.includes("Nigeria"));
  assert.ok(suggestedQueries().some((s) => s.includes("Lagos")));
  assert.ok(suggestedQueries("devops")[0].startsWith("devops"));
  assert.ok(baseQuery().includes("software engineer"), "scope stays software engineering");
});
