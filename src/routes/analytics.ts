import { Router } from "express";
import { z } from "zod";
import { ok } from "../core/envelope";
import { requireAuth, type AuthedRequest } from "../core/security";
import * as analytics from "../services/analytics.service";
import * as streaks from "../services/streak.service";
import { rateLimit } from "../core/middleware";
import { all, get } from "../core/db";

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);
const limiter = rateLimit("analytics", 120, 60_000);
const periodSchema = z.object({ period: z.enum(["day", "week", "month", "year"]).default("week") });

analyticsRouter.get("/summary", limiter, (req: AuthedRequest, res, next) => {
  try {
    const { period } = periodSchema.parse(req.query);
    ok(res, "Summary retrieved", analytics.summary(req.userId!, period));
  } catch (e) {
    next(e);
  }
});

analyticsRouter.get("/funnel", limiter, (req: AuthedRequest, res, next) => {
  try {
    const { period } = periodSchema.parse(req.query);
    const range = period === "day" ? 1 : period === "week" ? 7 : period === "month" ? 30 : 365;
    const from = new Date(Date.now() - range * 86_400_000).toISOString();
    ok(res, "Funnel retrieved", { period, items: analytics.funnelCounts(req.userId!, from) });
  } catch (e) {
    next(e);
  }
});

analyticsRouter.get("/timeseries", limiter, (req: AuthedRequest, res, next) => {
  try {
    const q = z
      .object({
        metric: z.enum(["applied", "replied", "ghosted", "rejected", "interview", "offer"]).default("applied"),
        bucket: z.enum(["day", "week", "month", "year"]).default("day"),
        from: z.string().optional(),
      })
      .parse(req.query);
    ok(res, "Timeseries retrieved", { metric: q.metric, bucket: q.bucket, items: analytics.timeseries(req.userId!, q.metric, q.bucket, q.from) });
  } catch (e) {
    next(e);
  }
});

analyticsRouter.get("/heatmap", limiter, (req: AuthedRequest, res, next) => {
  try {
    const year = req.query.year ? Number(req.query.year) : undefined;
    ok(res, "Heatmap retrieved", analytics.heatmap(req.userId!, year));
  } catch (e) {
    next(e);
  }
});

analyticsRouter.get("/breakdown", limiter, (req: AuthedRequest, res, next) => {
  try {
    const by = z.enum(["source", "company", "cv", "template", "category"]).default("source").parse(req.query.by ?? "source");
    ok(res, "Breakdown retrieved", { by, items: analytics.breakdown(req.userId!, by) });
  } catch (e) {
    next(e);
  }
});

analyticsRouter.get("/time-to-reply", limiter, (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Time-to-reply distribution", analytics.timeToReplyHistogram(req.userId!));
  } catch (e) {
    next(e);
  }
});

/* -------------------------------- streaks -------------------------------- */
export const streakRouter = Router();
streakRouter.use(requireAuth);

streakRouter.get("/today", (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Today", streaks.today(req.userId!));
  } catch (e) {
    next(e);
  }
});

streakRouter.get("/badges", (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Badges", { items: streaks.badges(req.userId!) });
  } catch (e) {
    next(e);
  }
});

streakRouter.get("/history", (req: AuthedRequest, res, next) => {
  try {
    const days = req.query.days ? Number(req.query.days) : 120;
    ok(res, "Streak history", { items: streaks.streakHistory(req.userId!, days) });
  } catch (e) {
    next(e);
  }
});

streakRouter.put("/goals", (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ goal: z.number().min(1).max(500), timezone: z.string().optional() }).parse(req.body);
    ok(res, "Goal updated", streaks.setGoal(req.userId!, body.goal, body.timezone));
  } catch (e) {
    next(e);
  }
});

streakRouter.post("/victory", (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ offer_source: z.enum(["manual", "email"]).default("manual"), application_id: z.string().optional() }).parse(req.body ?? {});
    ok(res, "Congratulations 🎉", streaks.victory(req.userId!, body as any));
  } catch (e) {
    next(e);
  }
});

/** Manual effort log (quick-add without an application) — keeps the goal ring honest. */
streakRouter.post("/log", (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ weight: z.number().min(0.05).max(5).default(1) }).parse(req.body ?? {});
    ok(res, "Effort logged", streaks.recordEffort(req.userId!, body.weight));
  } catch (e) {
    next(e);
  }
});

/* --------------------------------- export -------------------------------- */
export const exportRouter = Router();
exportRouter.use(requireAuth);

exportRouter.get("/", (req: AuthedRequest, res, next) => {
  try {
    const format = (req.query.format ?? "json") as string;
    const payload = {
      exported_at: new Date().toISOString(),
      profile: get("SELECT * FROM profiles WHERE user_id = ?", req.userId!),
      applications: all("SELECT * FROM applications WHERE user_id = ?", req.userId!),
      application_events: all("SELECT * FROM application_events WHERE app_id IN (SELECT id FROM applications WHERE user_id = ?)", req.userId!),
      cvs: all("SELECT * FROM cvs WHERE user_id = ?", req.userId!),
      templates: all("SELECT * FROM templates WHERE user_id = ?", req.userId!),
      companies: all("SELECT * FROM companies WHERE user_id = ?", req.userId!),
      contacts: all("SELECT * FROM contacts WHERE user_id = ?", req.userId!),
      outreach: all("SELECT * FROM outreach_messages WHERE user_id = ?", req.userId!),
      streaks: all("SELECT * FROM streak_events WHERE user_id = ?", req.userId!),
      badges: all("SELECT * FROM badges WHERE user_id = ?", req.userId!),
    };
    if (format === "csv") {
      const rows = (payload.applications as any[]).map((a) =>
        [a.id, a.company_name, a.role_title, a.kind, a.status, a.source, a.applied_at ?? "", a.replied_at ?? "", a.ghosted_at ?? ""]
          .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
          .join(",")
      );
      const csv = ["id,company,role,kind,status,source,applied_at,replied_at,ghosted_at", ...rows].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", 'attachment; filename="jams-applications.csv"');
      return res.send(csv);
    }
    res.setHeader("Content-Disposition", 'attachment; filename="jams-export.json"');
    ok(res, "Export ready (lock-in is immoral)", payload);
  } catch (e) {
    next(e);
  }
});
