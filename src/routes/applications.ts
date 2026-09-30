import { Router } from "express";
import { z } from "zod";
import { ok, fail } from "../core/envelope";
import { requireAuth, type AuthedRequest } from "../core/security";
import * as apps from "../services/application.service";
import * as outreach from "../services/outreach.service";

export const applicationRouter = Router();
applicationRouter.use(requireAuth);

const toArray = (v: any): string[] | undefined => (v == null ? undefined : Array.isArray(v) ? v.map(String) : String(v).split(",").map((s) => s.trim()).filter(Boolean));

applicationRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const q = req.query as any;
    const result = await apps.listApplications(req.userId!, {
      status: toArray(q.status),
      kind: q.kind,
      company_id: q.company_id,
      from: q.from,
      to: q.to,
      sort: q.sort,
      page: q.page ? Number(q.page) : 1,
      page_size: q.page_size ? Number(q.page_size) : 50,
      q: q.q,
    });
    ok(res, "Applications retrieved", result);
  } catch (e) {
    next(e);
  }
});

const createSchema = z.object({
  company_name: z.string().min(1),
  company_id: z.string().nullish(),
  posting_id: z.string().nullish(),
  contact_id: z.string().nullish(),
  kind: z.enum(["application", "pitch"]).optional(),
  status: z.enum(apps.STATUSES as unknown as [string, ...string[]]).optional(),
  role_title: z.string().min(1),
  cv_id: z.string().nullish(),
  template_id: z.string().nullish(),
  source: z.string().nullish(),
  url: z.string().nullish(),
  notes: z.string().nullish(),
  tags: z.array(z.string()).optional(),
  capture: z.any().optional(),
  applied_at: z.string().nullish(),
  next_action_at: z.string().nullish(),
});

applicationRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const body = createSchema.parse(req.body);
    ok(res, "Application created", await apps.createApplication(req.userId!, body as any), 201);
  } catch (e) {
    next(e);
  }
});

applicationRouter.get("/follow-ups", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Follow-up chips", { items: await apps.followUpChips(req.userId!) });
  } catch (e) {
    next(e);
  }
});

applicationRouter.post("/bulk-status", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ ids: z.array(z.string()).min(1), status: z.enum(apps.STATUSES as unknown as [string, ...string[]]) }).parse(req.body);
    ok(res, "Bulk status applied", await apps.bulkStatus(req.userId!, body.ids, body.status as any));
  } catch (e) {
    next(e);
  }
});

applicationRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Application retrieved", await apps.getApplication(req.userId!, String(req.params.id)));
  } catch (e) {
    next(e);
  }
});

applicationRouter.put("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const patch = createSchema.partial().extend({ status: z.enum(apps.STATUSES as unknown as [string, ...string[]]).optional(), status_at: z.string().optional() }).parse(req.body);
    ok(res, "Application updated", await apps.updateApplication(req.userId!, String(req.params.id), patch as any));
  } catch (e) {
    next(e);
  }
});

applicationRouter.delete("/:id", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Application deleted", await apps.deleteApplication(req.userId!, String(req.params.id)));
  } catch (e) {
    next(e);
  }
});

/**
 * POST /applications/:id/auto-apply — direct send when SMTP is configured, Gmail
 * hand-off compose otherwise, and the plain open-link fallback when no email is
 * known. Everything is still recorded as an application (or pitch) either way.
 */
applicationRouter.post("/:id/auto-apply", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Auto-apply processed", await outreach.autoApply(req.userId!, String(req.params.id)));
  } catch (e) {
    next(e);
  }
});

applicationRouter.post("/:id/status", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ status: z.enum(apps.STATUSES as unknown as [string, ...string[]]), at: z.string().optional() }).parse(req.body);
    ok(res, `Status → ${body.status}`, await apps.changeStatus(req.userId!, String(req.params.id), body.status as any, body.at));
  } catch (e) {
    next(e);
  }
});

applicationRouter.get("/:id/events", async (req: AuthedRequest, res, next) => {
  try {
    const app = await apps.getApplication(req.userId!, String(req.params.id));
    ok(res, "Timeline", { items: app.events });
  } catch (e) {
    next(e);
  }
});

applicationRouter.post("/:id/notes", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ note: z.string().min(1) }).parse(req.body);
    ok(res, "Note added", await apps.addNote(req.userId!, String(req.params.id), body.note));
  } catch (e) {
    next(e);
  }
});

/** Status vocabulary + transition map, the frontend renders columns from this. */
applicationRouter.get("/meta/statuses", (_req, res) => {
  ok(res, "Status vocabulary", { statuses: apps.STATUSES, transitions: apps.TRANSITIONS });
});
