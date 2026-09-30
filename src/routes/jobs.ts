import { Router } from "express";
import { z } from "zod";
import { ok } from "../core/envelope";
import { requireAuth, type AuthedRequest } from "../core/security";
import * as jobs from "../services/job.service";
import { platformSearches, suggestedQueries } from "../search/social";
import { ingestAll, sourceHealth } from "../ingestion/ingest";
import { rateLimit } from "../core/middleware";

export const jobRouter = Router();
jobRouter.use(requireAuth);
const searchLimiter = rateLimit("search", 30, 60_000);

const toArray = (v: any): string[] | undefined => (v == null ? undefined : Array.isArray(v) ? v.map(String) : String(v).split(",").map((s) => s.trim()).filter(Boolean));

jobRouter.get("/search", searchLimiter, async (req: AuthedRequest, res, next) => {
  try {
    const q = req.query as any;
    const result = await jobs.searchJobs(req.userId!, {
      q: q.q,
      location: q.location,
      remote: q.remote,
      salary_min: q.salary_min ? Number(q.salary_min) : undefined,
      seniority: q.seniority,
      source: toArray(q.source),
      category: q.category,
      posted_within: q.posted_within ? Number(q.posted_within) : undefined,
      sort: q.sort,
      page: q.page ? Number(q.page) : 1,
      page_size: q.page_size ? Number(q.page_size) : 20,
      exclude: toArray(q.exclude),
    });
    ok(res, `${result.pagination.total_count} results in ${result.took_ms}ms`, result);
  } catch (e) {
    next(e);
  }
});

jobRouter.get("/sources", async (_req, res, next) => {
  try {
    ok(res, "Source health", { items: await sourceHealth() });
  } catch (e) {
    next(e);
  }
});

jobRouter.post("/refresh", searchLimiter, async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ sources: z.array(z.string()).optional() }).default({}).parse(req.body ?? {});
    // fire-and-forget ingest; progress observable via /jobs/sources (§29.1 "workers do the slow things")
    const run = ingestAll(req.userId!, { sources: body.sources });
    run.then((r) => console.log(`[ingest] ok=${r.sources_ok.join(",") || "-"} failed=${r.sources_failed.map((f) => f.source).join(",") || "-"} inserted=${r.inserted}`)).catch((e) => console.error("[ingest]", e));
    ok(res, "Ingestion enqueued", { job_id: `ingest-${Date.now()}`, status: "queued" }, 202);
  } catch (e) {
    next(e);
  }
});

jobRouter.get("/ingest/status", async (req: AuthedRequest, res, next) => {
  try {
    // await-free status: last known source rows
    ok(res, "Ingestion status", { sources: await sourceHealth() });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /jobs/social?q=… — prepared social-platform searches (software engineering × Nigeria).
 * Feeds have no API, so we ship the exact query + URL per platform instead of scraping.
 */
jobRouter.get("/social", searchLimiter, (req: AuthedRequest, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    ok(res, "Social search recipes", {
      base_query: (platformSearches(q)[0]?.query ?? ""),
      platforms: platformSearches(q),
      suggestions: suggestedQueries(q),
      scope: "software engineering roles in Nigeria (Lagos, Abuja, Ogun + nationwide)",
      email_hint: "Capture any result URL: the preview extracts published emails from the page, which is what you pitch or apply with.",
    });
  } catch (e) {
    next(e);
  }
});

jobRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Posting retrieved", await jobs.getJob(req.userId!, String(req.params.id)));
  } catch (e) {
    next(e);
  }
});

jobRouter.post("/:id/feedback", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ vote: z.enum(["up", "down", "ignore"]) }).parse(req.body);
    ok(res, "Feedback recorded", await jobs.voteJob(req.userId!, String(req.params.id), body.vote));
  } catch (e) {
    next(e);
  }
});

export const searchRouter = Router();
searchRouter.use(requireAuth);
searchRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Saved searches", { items: await jobs.listSavedSearches(req.userId!) });
  } catch (e) {
    next(e);
  }
});
searchRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ name: z.string().min(1), params: z.record(z.any()).default({}) }).parse(req.body);
    ok(res, "Search saved", await jobs.saveSearch(req.userId!, body.name, body.params), 201);
  } catch (e) {
    next(e);
  }
});
searchRouter.delete("/:id", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Search deleted", await jobs.deleteSavedSearch(req.userId!, String(req.params.id)));
  } catch (e) {
    next(e);
  }
});
