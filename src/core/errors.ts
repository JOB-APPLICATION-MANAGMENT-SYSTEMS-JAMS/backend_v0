import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { fail } from "./envelope";

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "TOKEN_EXPIRED"
  | "INVALID_CREDENTIALS"
  | "REQUIRES_VERIFICATION"
  | "SUSPENDED"
  | "MAILBOX_NOT_CONNECTED"
  | "SMTP_NOT_CONFIGURED"
  | "SMTP_AUTH_FAILED"
  | "SMTP_SEND_FAILED"
  | "QUOTA_EXCEEDED"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "INVALID_TRANSITION"
  | "VALIDATION_ERROR"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "SOURCE_DOWN"
  | "PARSE_FAILED"
  | "CONFIRM_REQUIRED"
  | "INTERNAL";

/** Application error carrying a machine-readable code (§12.2 improvement over the reference). */
export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    public status: number,
    message: string,
    public detail: string | null = null,
    public extra: { retry_after?: number | null; fields?: any } = {}
  ) {
    super(message);
  }
}

export const unauthenticated = (msg = "Not authenticated") => new AppError("UNAUTHENTICATED", 401, msg);
export const invalidCredentials = () => new AppError("INVALID_CREDENTIALS", 401, "Invalid email or password");
export const notFound = (what = "Resource") => new AppError("NOT_FOUND", 404, `${what} not found`);
export const conflict = (msg: string, code: ErrorCode = "ALREADY_EXISTS") => new AppError(code, 409, msg);
export const forbidden = (code: ErrorCode, msg: string) => new AppError(code, 403, msg);
export const validation = (msg: string, fields?: any) => new AppError("VALIDATION_ERROR", 422, msg, null, { fields });
export const rateLimited = (retryAfter: number, msg = "Too many requests") =>
  new AppError("RATE_LIMITED", 429, msg, `Retry in ${retryAfter}s`, { retry_after: retryAfter });

/** Express error boundary: known errors → envelope; Zod → FastAPI-shaped 422; unknown → 500. */
export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return;
  if (err instanceof AppError) {
    return fail(res, err.status, err.message, { code: err.code, detail: err.detail, retry_after: err.extra.retry_after, fields: err.extra.fields });
  }
  if (err instanceof ZodError) {
    // Exact FastAPI validation shape (§12.2 shape A / §33.1)
    const detail = err.issues.map((i) => ({
      loc: ["body", ...(i.path.length ? i.path.map(String) : ["_"])],
      msg: i.message,
      type: i.code,
    }));
    return res.status(422).json({ detail });
  }
  console.error("[jams] unhandled error:", err);
  return fail(res, 500, "Internal server error", { code: "INTERNAL", detail: String(err?.message ?? err) });
}
