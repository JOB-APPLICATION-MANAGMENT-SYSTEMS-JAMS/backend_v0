import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { run, get } from "../src/core/db";
import { newId, nowIso } from "../src/util/id";
import { recordEffort, today, setGoal, badges, victory } from "../src/services/streak.service";

function makeUser(goal = 5) {
  const id = newId();
  run(
    `INSERT INTO users (id, email, password_hash, provider, verified, goal_default, timezone, created_at, updated_at)
     VALUES (?, ?, 'x', 'email', 1, ?, 'Africa/Lagos', ?, ?)`,
    id,
    `${id}@test.local`,
    goal,
    nowIso(),
    nowIso()
  );
  run("INSERT INTO profiles (id, user_id, identity, prefs, aliases, version, updated_at) VALUES (?, ?, '{}', '{}', '{}', 1, ?)", newId(), id, nowIso());
  return id;
}

test("goal hit flips streak on the false→true edge only", () => {
  const u = makeUser(3);
  assert.equal(today(u).streak, 0);
  recordEffort(u, 1);
  assert.equal(today(u).count, 1);
  assert.equal(today(u).hit, false);
  recordEffort(u, 1);
  recordEffort(u, 1); // 3/3 → hit
  const after = today(u);
  assert.equal(after.hit, true);
  assert.equal(after.streak, 1);
  recordEffustGuard(u);
  const again = today(u);
  assert.equal(again.count, 4, "extra effort same day keeps counting on the same row");
  assert.equal(again.streak, 1, "streak must not increment twice in one day");
});

function recordEffustGuard(u: string) {
  // extra effort beyond goal (e.g. follow-up weight) must not double-count the streak
  recordEffort(u, 1);
}

test("goal config round-trips and clamps", () => {
  const u = makeUser(5);
  const t = setGoal(u, 25, "Europe/London");
  assert.equal(t.goal, 25);
  assert.equal(t.timezone, "Europe/London");
  assert.equal(setGoal(u, 10_000).goal, 500, "goal clamps to 500");
});

test("any-effort streak tracks >=1 application days", () => {
  const u = makeUser(20);
  recordEffort(u, 1);
  const t = today(u);
  assert.ok(t.any_effort_streak >= 1);
  assert.equal(t.state, "warming");
});

test("badges unlock from projections and persist", () => {
  const u = makeUser(20);
  const before = badges(u).find((b) => b.key === "first_100")!;
  assert.equal(before.unlocked, false);
  for (let i = 0; i < 100; i++) {
    run(
      `INSERT INTO applications (id, user_id, kind, status, role_title, company_name, applied_at, created_at, updated_at)
       VALUES (?, ?, 'application', 'applied', 'Role', 'Co', ?, ?, ?)`,
      newId(),
      u,
      nowIso(),
      nowIso(),
      nowIso()
    );
  }
  const after = badges(u).find((b) => b.key === "first_100")!;
  assert.equal(after.unlocked, true);
  const stored = get("SELECT * FROM badges WHERE user_id = ? AND badge_key = 'first_100'", u);
  assert.ok(stored, "badge persisted once");
});

test("victory writes summary + flips application to offer", () => {
  const u = makeUser(20);
  const appId = newId();
  run(
    `INSERT INTO applications (id, user_id, kind, status, role_title, company_name, created_at, updated_at)
     VALUES (?, ?, 'application', 'interview', 'Role', 'Co', ?, ?)`,
    appId,
    u,
    nowIso(),
    nowIso()
  );
  const v = victory(u, { offer_source: "manual", application_id: appId });
  assert.equal(v.celebrated, true);
  assert.ok(v.summary.applications >= 1);
  assert.equal(get<any>("SELECT status FROM applications WHERE id = ?", appId)!.status, "offer");
});
