import { get, run } from "../core/db";
import { hashPassword, signAccessToken, signRefreshToken, verifyPassword } from "../core/security";
import { conflict, invalidCredentials, notFound, AppError } from "../core/errors";
import { newId, nowIso } from "../util/id";
import { randomBytes } from "node:crypto";
import nodemailer from "nodemailer";
import { config, smtpReady } from "../core/config";

export interface PublicUser {
  id: string;
  email: string;
  verified: boolean;
  goal_default: number;
  timezone: string;
  created_at: string;
}

const publicUser = (u: any): PublicUser => ({
  id: u.id,
  email: u.email,
  verified: !!u.verified,
  goal_default: u.goal_default,
  timezone: u.timezone,
  created_at: u.created_at,
});

export function issueTokens(userId: string) {
  const sid = newId();
  return { access_token: signAccessToken(userId, sid), refresh_token: signRefreshToken(userId, sid), token_type: "bearer" };
}

/**
 * Deliver a verification token (§4.3).
 *  - non-online (local/test): print the link and hand the token straight back, so the UI
 *    can verify instantly with no SMTP — the MailPit equivalent.
 *  - online: email the link through the deployment SMTP_* account and NEVER return the
 *    token; echoing it would let anyone register with an address they do not own and
 *    verify it themselves, defeating email verification entirely.
 */
async function deliverVerification(email: string, token: string): Promise<{ sent: boolean; verification_token?: string }> {
  if (config.mode !== "online") {
    console.log(`[auth] verification link for ${email}: /auth/verify-email?token=${token}`);
    return { sent: false, verification_token: token };
  }
  const origin = config.webOrigin !== "*" ? config.webOrigin.replace(/\/+$/, "") : "";
  const path = `/auth/verify?token=${token}`;
  const link = origin ? `${origin}${path}` : null;
  if (!smtpReady() || !link) {
    const why = !smtpReady() ? "SMTP_* env not configured" : "WEB_ORIGIN is still the wildcard default";
    console.warn(`[auth] verification email for ${email} NOT sent (${why}); link: ${link ?? path}`);
    return { sent: false };
  }
  try {
    const transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
    await transport.sendMail({
      from: config.smtp.from || config.smtp.user,
      to: email,
      subject: "Confirm your email for JAMS",
      text:
        `Confirm ${email} to finish setting up your JAMS account:\n\n${link}\n\n` +
        `The link stops working as soon as a newer one is requested. If you did not create this account, ignore this email.`,
    });
    return { sent: true };
  } catch (e) {
    console.error("[auth] verification email failed:", e instanceof Error ? e.message : e);
    return { sent: false };
  }
}

export async function register(email: string, password: string, timezone?: string, firstName?: string, lastName?: string) {
  const existing = await get("SELECT id FROM users WHERE email = ?", email.toLowerCase());
  if (existing) throw conflict("An account with this email already exists");
  const id = newId();
  const token = randomBytes(24).toString("hex");
  const now = nowIso();
  // names go straight into the profile identity block (§19.3 keys) so the topbar,
  // autofill and CV blocks all see them from the first session
  const identity = JSON.stringify({
    first_name: firstName ?? "",
    last_name: lastName ?? "",
    full_name: [firstName, lastName].filter(Boolean).join(" "),
  });
  await run(
    `INSERT INTO users (id, email, password_hash, provider, verified, verification_token, timezone, created_at, updated_at)
     VALUES (?, ?, ?, 'email', 0, ?, ?, ?, ?)`,
    id,
    email.toLowerCase(),
    await hashPassword(password),
    token,
    timezone ?? config.timezone,
    now,
    now
  );
  // online mode emails the link; local/test surface the token (see deliverVerification)
  await run(`INSERT INTO profiles (id, user_id, identity, prefs, aliases, version, updated_at) VALUES (?, ?, ?, '{}', '{}', 1, ?)`, newId(), id, identity, now);
  const delivery = await deliverVerification(email, token);
  const user = (await get("SELECT * FROM users WHERE id = ?", id))!;
  return {
    user: publicUser(user),
    email_sent: delivery.sent,
    ...(delivery.verification_token ? { verification_token: delivery.verification_token } : {}),
    ...issueTokens(id),
  };
}

export async function login(email: string, password: string) {
  const user = await get("SELECT * FROM users WHERE email = ?", email.toLowerCase());
  if (!user || !user.password_hash || !(await verifyPassword(password, user.password_hash))) throw invalidCredentials();
  if (!user.verified) {
    // rich 403 that drives UI state (§4.3), machine code + fields for the login form branch
    throw new AppError("REQUIRES_VERIFICATION", 403, "Verify your email to sign in", null, {
      fields: { requires_verification: true, email: user.email },
    });
  }
  if (user.suspended) {
    throw new AppError("SUSPENDED", 403, "Account suspended", null, { fields: { is_suspended: true, email: user.email } });
  }
  return { user: publicUser(user), ...issueTokens(user.id) };
}

export async function verifyEmail(token: string) {
  const user = await get("SELECT * FROM users WHERE verification_token = ?", token);
  if (!user) throw notFound("Verification token");
  await run("UPDATE users SET verified = 1, verification_token = NULL, updated_at = ? WHERE id = ?", nowIso(), user.id);
  return publicUser((await get("SELECT * FROM users WHERE id = ?", user.id))!);
}

export async function resendVerification(email: string) {
  const user = await get("SELECT * FROM users WHERE email = ?", email.toLowerCase());
  if (!user) return { sent: true }; // do not leak existence
  const token = randomBytes(24).toString("hex");
  await run("UPDATE users SET verification_token = ?, updated_at = ? WHERE id = ?", token, nowIso(), user.id);
  const delivery = await deliverVerification(email, token);
  return { sent: true, ...(delivery.verification_token ? { verification_token: delivery.verification_token } : {}) };
}

export async function me(userId: string) {
  const user = await get("SELECT * FROM users WHERE id = ?", userId);
  if (!user) throw notFound("User");
  const profile = await get("SELECT * FROM profiles WHERE user_id = ?", userId);
  const counts = await get(
    `SELECT (SELECT count(*) FROM applications WHERE user_id = ?) AS applications,
            (SELECT count(*) FROM cvs WHERE user_id = ?) AS cvs,
            (SELECT count(*) FROM job_postings WHERE user_id = ?) AS postings`,
    userId,
    userId,
    userId
  );
  return { user: publicUser(user), profile_exists: !!profile, settings: { goal: user.goal_default, timezone: user.timezone, mode: process.env.MODE ?? "local" }, counts };
}

