import { Router } from "express";
import { ok } from "../core/envelope";
import { authRouter } from "./auth";
import { profileRouter, cvRouter, templateRouter, captureRouter, autofillRouter, companyRouter } from "./core";
import { jobRouter, searchRouter } from "./jobs";
import { pitchRouter } from "./pitch";
import { applicationRouter } from "./applications";
import { outreachRouter, mailboxRouter, inboxRouter, trackingRouter } from "./outreach";
import { analyticsRouter, streakRouter, exportRouter } from "./analytics";
import { sourceHealth } from "../ingestion/ingest";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../core/security";
import { setGoal } from "../services/streak.service";
import { driver } from "../core/db";
import { config } from "../core/config";

export const apiRouter = Router();

// `driver` is the remote switch for DATABASE_URL: after setting it on the host,
// healthz must report "postgres", otherwise traffic is still on ephemeral SQLite.
apiRouter.get("/healthz", (_req, res) => ok(res, "ok", { status: "up", mode: process.env.MODE ?? "local", driver, time: new Date().toISOString() }));

/**
 * API index at GET /api/v1, in production the public / redirects here
 * (vercel.json): Vercel's edge fails root-path invocations with
 * FUNCTION_INVOCATION_FAILED, while every other path serves fine.
 */
export const apiIndex = () => ({
  name: "JAMS API",
  version: "0.1.0",
  mode: config.mode,
  base: "/api/v1",
  endpoints: ["/auth", "/profile", "/cvs", "/templates", "/jobs", "/searches", "/applications", "/companies", "/pitch-targets", "/capture", "/autofill", "/outreach", "/mailboxes", "/inbox", "/analytics", "/streaks", "/goals", "/export", "/tracking", "/sources"],
});
apiRouter.get("/", (_req, res) => res.json(apiIndex()));

apiRouter.use("/auth", authRouter);
apiRouter.use("/profile", profileRouter);
apiRouter.use("/cvs", cvRouter);
apiRouter.use("/templates", templateRouter);
apiRouter.use("/jobs", jobRouter);
apiRouter.use("/searches", searchRouter);
apiRouter.use("/applications", applicationRouter);
apiRouter.use("/companies", companyRouter);
apiRouter.use("/pitch-targets", pitchRouter);
apiRouter.use("/capture", captureRouter);
apiRouter.use("/autofill", autofillRouter);
apiRouter.use("/outreach", outreachRouter);
apiRouter.use("/mailboxes", mailboxRouter);
apiRouter.use("/inbox", inboxRouter);
apiRouter.use("/analytics", analyticsRouter);
apiRouter.use("/streaks", streakRouter);
// PUT /goals (§33.2), separate mount so the path matches the spec exactly
apiRouter.put("/goals", requireAuth, async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ goal: z.number().min(1).max(500), timezone: z.string().optional() }).parse(req.body);
    ok(res, "Goal updated", await setGoal(req.userId!, body.goal, body.timezone));
  } catch (e) {
    next(e);
  }
});
apiRouter.use("/export", exportRouter);
apiRouter.use("/tracking", trackingRouter);

apiRouter.get("/sources", async (_req, res, next) => {
  try {
    ok(res, "Source health", { items: await sourceHealth() });
  } catch (e) {
    next(e);
  }
});
