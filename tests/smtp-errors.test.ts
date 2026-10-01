/**
 * SMTP failures (§9.4): Google's app-password rejection must reach the user as a
 * human sentence with a next step, never as the raw gsmtp transcript in a 500.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { smtpSendError } from "../src/services/outreach.service";

test("Google's 534 app-password rejection becomes actionable guidance", () => {
  const e = new Error(
    "Invalid login: 534-5.7.9 Application-specific password required. For more information, go to\n534 5.7.9  https://support.google.com/mail/?p=InvalidSecondFactor abc123 - gsmtp"
  );
  (e as any).responseCode = 534;
  const mapped = smtpSendError(e);

  assert.equal(mapped.code, "SMTP_AUTH_FAILED");
  assert.equal(mapped.status, 400, "auth failure is the saved credential, not a server fault");
  assert.match(mapped.detail ?? "", /app password/i, "names the fix");
  assert.match(mapped.detail ?? "", /Inbox & Sync/, "says where to apply it");
  assert.doesNotMatch(`${mapped.message}${mapped.detail}`, /gsmtp|InvalidSecondFactor/, "no raw SMTP transcript");
});

test("other SMTP failures are still human-readable, not INTERNAL 500s", () => {
  const mapped = smtpSendError(new Error("Connection reset by peer"));
  assert.equal(mapped.code, "SMTP_SEND_FAILED");
  assert.equal(mapped.status, 502);
  assert.ok(mapped.detail && mapped.detail.includes("Connection reset"));
});
