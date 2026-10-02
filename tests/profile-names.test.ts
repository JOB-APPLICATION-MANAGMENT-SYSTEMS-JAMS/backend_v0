/**
 * The name must survive every flow (§19.3): signup writes first_name/last_name/full_name,
 * the onboarding step posts {full_name, headline}, the profile form writes name. A partial
 * PUT used to replace the whole identity block, so pitches signed with a blank line after
 * "Best," and the Full name field read empty while the topbar still showed the name.
 */
import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { register } from "../src/services/auth.service";
import { getProfile, updateProfile, reconcileIdentity } from "../src/services/profile.service";
import { mergeForUser } from "../src/services/outreach.service";

test("reconcileIdentity fills every name key from whichever one exists", () => {
  const fromFullName = reconcileIdentity({ full_name: "Ada Lovelace", headline: "x" });
  assert.equal(fromFullName.first_name, "Ada");
  assert.equal(fromFullName.last_name, "Lovelace");
  assert.equal(fromFullName.name, "Ada Lovelace");

  const fromParts = reconcileIdentity({ first_name: "Grace", last_name: "Hopper" });
  assert.equal(fromParts.name, "Grace Hopper");
  assert.equal(fromParts.full_name, "Grace Hopper");

  const single = reconcileIdentity({ name: "Cher" });
  assert.equal(single.first_name, "Cher");
  assert.equal(single.last_name, "");

  assert.deepEqual(reconcileIdentity({}), {});
});

test("an onboarding-style partial identity update no longer wipes signup names", async () => {
  const email = `names-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const { user } = await register(email, "Passw0rd!123", "UTC", "Ada", "Lovelace");

  // exactly what POST /profile { identity: { full_name, headline } } does after onboarding
  await updateProfile(user.id, { identity: { full_name: "Ada Lovelace", headline: "Software engineer" } });

  const p = await getProfile(user.id);
  assert.equal(p.identity.first_name, "Ada", "signup first_name survives a partial update");
  assert.equal(p.identity.name, "Ada Lovelace", "profile page Full name field is not blank");
  assert.equal(p.identity.headline, "Software engineer");

  const { body } = await mergeForUser(user.id, "Hi", "Best,\n{{profile.first_name}} {{profile.last_name}}");
  assert.equal(body, "Best,\nAda Lovelace", "the pitch signature shows the name");
});
