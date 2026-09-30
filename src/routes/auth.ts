import { Router } from "express";
import { z } from "zod";
import { ok } from "../core/envelope";
import { requireAuth, signAccessToken, signRefreshToken, verifyToken, type AuthedRequest } from "../core/security";
import * as auth from "../services/auth.service";
import { AppError, unauthenticated } from "../core/errors";
import { rateLimit } from "../core/middleware";
import { get } from "../core/db";

export const authRouter = Router();
const limiter = rateLimit("auth", 20, 15 * 60_000);

const registerSchema = z.object({
  email: z.string().email("value is not a valid email"),
  password: z.string().min(8, "password must be at least 8 characters"),
  first_name: z.string().trim().min(1, "first name is required").max(80).optional(),
  last_name: z.string().trim().min(1, "last name is required").max(80).optional(),
  timezone: z.string().optional(),
});

authRouter.post("/register", limiter, async (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body);
    const result = await auth.register(body.email, body.password, body.timezone, body.first_name, body.last_name);
    ok(res, "Account created, check your email for the verification link", { ...result, requires_verification: true }, 201);
  } catch (e) {
    next(e);
  }
});

authRouter.post("/login", limiter, async (req, res, next) => {
  try {
    const body = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
    const user = await get("SELECT * FROM users WHERE email = ?", body.email.toLowerCase());
    if (user && !user.verified) {
      // rich 403 that drives UI state (§4.3 pattern, with a machine code)
      await auth.login(body.email, body.password); // validates password first
      throw new AppError("REQUIRES_VERIFICATION", 403, "Verify your email to continue", null, {
        fields: { requires_verification: true, email: body.email },
      });
    }
    const result = await auth.login(body.email, body.password);
    ok(res, "Signed in", result);
  } catch (e) {
    next(e);
  }
});

authRouter.post("/refresh", limiter, (req, res, next) => {
  try {
    const body = z.object({ refresh_token: z.string() }).parse(req.body);
    const payload = verifyToken(body.refresh_token);
    if (payload.typ !== "refresh") throw unauthenticated("Refresh token required");
    ok(res, "Token refreshed", { access_token: signAccessToken(payload.sub, payload.sid), refresh_token: signRefreshToken(payload.sub, payload.sid), token_type: "bearer" });
  } catch (e) {
    next(e);
  }
});

authRouter.post("/verify-email", async (req, res, next) => {
  try {
    const token = z.object({ token: z.string() }).parse(req.body).token;
    ok(res, "Email verified, you can sign in now", await auth.verifyEmail(token));
  } catch (e) {
    next(e);
  }
});

authRouter.post("/resend-verification", limiter, async (req, res, next) => {
  try {
    const body = z.object({ email: z.string().email() }).parse(req.body);
    ok(res, "If that account exists, a new link was sent", await auth.resendVerification(body.email));
  } catch (e) {
    next(e);
  }
});

/** Local-mode convenience: read the latest verification token (dev console equivalent of MailPit). */
authRouter.get("/dev-token", async (req, res, next) => {
  try {
    const email = z.object({ email: z.string().email() }).parse(req.query).email;
    const user = await get("SELECT email, verification_token, verified FROM users WHERE email = ?", email.toLowerCase());
    ok(res, "dev", { email, verified: !!user?.verified, verification_token: user?.verification_token ?? null });
  } catch (e) {
    next(e);
  }
});

authRouter.get("/me", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Current user", await auth.me(req.userId!));
  } catch (e) {
    next(e);
  }
});
