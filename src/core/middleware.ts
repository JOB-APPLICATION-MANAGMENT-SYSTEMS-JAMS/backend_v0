import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { rateLimited } from "./errors";

/** Attach a request id (§41.1 improvement) and log method/path/status/ms. */
export function requestContext(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  const rid = (req.headers["x-request-id"] as string) || randomUUID();
  res.setHeader("X-Request-Id", rid);
  res.on("finish", () => {
    if (configQuiet(req.path)) return;
    console.log(`[api] ${req.method} ${req.path} → ${res.statusCode} ${Date.now() - start}ms (${rid.slice(0, 8)})`);
  });
  next();
}

const configQuiet = (p: string) => p === "/healthz" || p.startsWith("/tracking/");

/**
 * In-memory sliding-window rate limiter — replaces Redis (§33.4 route classes).
 * Search 30/min · capture 60/hour · auth 20/15min · general 300/min.
 */
type Window = { hits: number[] };
const buckets = new Map<string, Window>();

export function rateLimit(scope: string, max: number, windowMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = `${scope}:${req.ip ?? "local"}`;
    const now = Date.now();
    const b = buckets.get(key) ?? { hits: [] };
    b.hits = b.hits.filter((t) => now - t < windowMs);
    const retryAfter = Math.ceil((windowMs - (now - (b.hits[0] ?? now))) / 1000);
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - b.hits.length)));
    if (b.hits.length >= max) {
      res.setHeader("Retry-After", String(retryAfter));
      buckets.set(key, b);
      return next(rateLimited(retryAfter, "Too many requests"));
    }
    b.hits.push(now);
    buckets.set(key, b);
    next();
  };
}

/** Periodic sweep so idle buckets don't leak. */
export function startRateLimitSweeper() {
  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) {
      b.hits = b.hits.filter((t) => now - t < 10 * 60_000);
      if (!b.hits.length) buckets.delete(k);
    }
  }, 5 * 60_000).unref();
}
