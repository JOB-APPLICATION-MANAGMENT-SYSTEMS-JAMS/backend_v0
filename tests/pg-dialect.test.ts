/**
 * Dialect proof: the Postgres schema (SCHEMA_PG) and representative query shapes
 * (upsert with excluded, ON CONFLICT DO NOTHING, GROUP BY ordinal, identity PK,
 * LIKE/lower, substr) must run against a real Postgres engine before we point at Neon.
 * Runs on PGlite (in-memory WASM Postgres) — no server required.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { SCHEMA_PG } from "../src/db/schema";
import { newId, nowIso } from "../src/util/id";

test("SCHEMA_PG applies and representative queries run on real Postgres", async () => {
  const db = new PGlite();
  await db.exec(SCHEMA_PG);

  const id = newId();
  const now = nowIso();

  // identity PK + plain insert (application_events is the only dialect diff)
  await db.exec(
    `INSERT INTO users (id, email, password_hash, provider, verified, goal_default, timezone, created_at, updated_at)
     VALUES ('u1', 'a@b.c', 'x', 'email', 1, 5, 'Africa/Lagos', '${now}', '${now}')`
  );
  await db.exec(
    `INSERT INTO applications (id, user_id, kind, status, role_title, company_name, created_at, updated_at)
     VALUES ('${id}', 'u1', 'application', 'applied', 'Role', 'Co', '${now}', '${now}')`
  );
  await db.exec(`INSERT INTO application_events (app_id, type, at, actor, payload) VALUES ('${id}', 'applied', '${now}', 'user', '{}')`);

  // upsert with excluded.* (job_votes / outreach / ingest shapes)
  await db.exec(
    `INSERT INTO job_postings (id, user_id, company_name, source, external_id, title, url, first_seen_at, created_at, dedupe_key, status)
     VALUES ('p1', 'u1', 'Co', 'manual', 'e1', 'Role', 'https://example.com/j/1', '${now}', '${now}', 'k1', 'open')`
  );
  await db.exec(
    `INSERT INTO job_votes (id, user_id, posting_id, vote, created_at)
     VALUES ('v1', 'u1', 'p1', 'up', '${now}')
     ON CONFLICT(user_id, posting_id) DO UPDATE SET vote = excluded.vote, created_at = excluded.created_at`
  );
  await db.exec(
    `INSERT INTO job_votes (id, user_id, posting_id, vote, created_at)
     VALUES ('v1', 'u1', 'p1', 'down', '${now}')
     ON CONFLICT(user_id, posting_id) DO UPDATE SET vote = excluded.vote, created_at = excluded.created_at`
  );

  // ON CONFLICT DO NOTHING (streak badge shape)
  await db.exec(
    `INSERT INTO badges (id, user_id, badge_key, unlocked_at)
     VALUES ('b1', 'u1', 'first_100', '${now}') ON CONFLICT DO NOTHING`
  );

  // count + GROUP BY ordinal (analytics/facets shape)
  const cnt = await db.query<{ n: number }>(`SELECT count(*) AS n FROM applications WHERE user_id = $1`, ["u1"]);
  assert.equal(Number(cnt.rows[0].n), 1);

  const facets = await db.query(`SELECT status, count(*) AS n FROM applications GROUP BY 1`);
  assert.equal(facets.rows.length, 1);

  // LIKE + lower + substr (search / sentToday shape)
  const like = await db.query(`SELECT id FROM applications WHERE lower(company_name) LIKE $1 AND substr(created_at, 1, 10) = $2`, ["%co%", now.slice(0, 10)]);
  assert.equal(like.rows.length, 1);

  // tx-style rollback keeps Postgres transactional semantics honest
  await db.exec("BEGIN");
  await db.exec(`INSERT INTO applications (id, user_id, kind, status, role_title, company_name, created_at, updated_at)
     VALUES ('rollback-me', 'u1', 'application', 'saved', 'R', 'C', '${now}', '${now}')`);
  await db.exec("ROLLBACK");
  const after = await db.query<{ n: number }>(`SELECT count(*) AS n FROM applications`);
  assert.equal(Number(after.rows[0].n), 1, "rolled-back row must not persist");

  await db.close();
});
