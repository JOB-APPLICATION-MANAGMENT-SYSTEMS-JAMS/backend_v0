import { Router } from "express";
import { ok } from "../core/envelope";
import { authRouter } from "./auth";
import { profileRouter, cvRouter, templateRouter, captureRouter, autofillRouter, companyRouter } from "./core";
import { jobRouter, searchRouter } from "./jobs";
import { applicationRouter } from "./applications";
import { outreachRouter, mailboxRouter, inboxRouter, trackingRouter } from "./outreach";
import { analyticsRouter, streakRouter, exportRouter } from "./analytics";
import { sourceHealth } from "../ingestion/ingest";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../core/security";
import { setGoal } from "../services/streak.service";

export const apiRouter = Router();

apiRouter.get("/healthz", (_req, res) => ok(res, "ok", { status: "up", mode: process.env.MODE ?? "local", time: new Date().toISOString() }));

apiRouter.use("/auth", authRouter);
apiRouter.use("/profile", profileRouter);
apiRouter.use("/cvs", cvRouter);
apiRouter.use("/templates", templateRouter);
apiRouter.use("/jobs", jobRouter);
apiRouter.use("/searches", searchRouter);
apiRouter.use("/applications", applicationRouter);
apiRouter.use("/companies", companyRouter);
apiRouter.use("/capture", captureRouter);
apiRouter.use("/autofill", autofillRouter);
apiRouter.use("/outreach", outreachRouter);
apiRouter.use("/mailboxes", mailboxRouter);
apiRouter.use("/inbox", inboxRouter);
apiRouter.use("/analytics", analyticsRouter);
apiRouter.use("/streaks", streakRouter);
// PUT /goals (§33.2) — separate mount so the path matches the spec exactly
apiRouter.put("/goals", requireAuth, (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ goal: z.number().min(1).max(500), timezone: z.string().optional() }).parse(req.body);
    ok(res, "Goal updated", setGoal(req.userId!, body.goal, body.timezone));
  } catch (e) {
    next(e);
  }
});
apiRouter.use("/export", exportRouter);
apiRouter.use("/tracking", trackingRouter);

apiRouter.get("/sources", (_req, res) => ok(res, "Source health", { items: sourceHealth() }));
