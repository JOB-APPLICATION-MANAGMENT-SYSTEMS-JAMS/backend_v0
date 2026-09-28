import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config";
import { get } from "./db";
import { AppError, unauthenticated } from "./errors";

export const hashPassword = (pw: string) => bcrypt.hash(pw, 12);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

export interface AccessToken {
  sub: string;
  sid: string;
  typ: "access" | "refresh";
}

export function signAccessToken(userId: string, sid: string) {
  return jwt.sign({ sub: userId, sid, typ: "access" }, config.jwtSecret, { expiresIn: config.jwtAccessTtlSec });
}
export function signRefreshToken(userId: string, sid: string) {
  return jwt.sign({ sub: userId, sid, typ: "refresh" }, config.jwtSecret, { expiresIn: config.jwtRefreshTtlSec });
}
export function verifyToken(token: string): AccessToken {
  try {
    return jwt.verify(token, config.jwtSecret) as AccessToken;
  } catch (e: any) {
    if (e?.name === "TokenExpiredError") throw new AppError("TOKEN_EXPIRED", 401, "Token expired");
    throw unauthenticated();
  }
}

export interface AuthedRequest extends Request {
  userId?: string;
  user?: any;
}

/** Bearer auth — the frontend proxy injects the header server-side (§41.1), so JS never sees tokens. */
export async function requireAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) throw unauthenticated();
    const payload = verifyToken(token);
    if (payload.typ !== "access") throw unauthenticated("Access token required");
    const user = await get("SELECT * FROM users WHERE id = ?", payload.sub);
    if (!user) throw unauthenticated();
    if (user.suspended) throw new AppError("SUSPENDED", 403, "Account suspended", null, { fields: { is_suspended: true, email: user.email } });
    req.userId = payload.sub;
    req.user = user;
    next();
  } catch (e) {
    next(e);
  }
}

/** Optional auth — used by endpoints that behave differently when signed in. */
export async function optionalAuth(req: AuthedRequest, _res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    try {
      const payload = verifyToken(token);
      req.userId = payload.sub;
      req.user = await get("SELECT * FROM users WHERE id = ?", payload.sub);
    } catch {
      /* ignore — optional */
    }
  }
  next();
}
