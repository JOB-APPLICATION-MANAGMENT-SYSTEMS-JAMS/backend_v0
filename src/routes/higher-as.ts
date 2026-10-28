/**
 * Higher As API.
 *
 * Every route is authenticated: vocational discovery is still a network of people,
 * and contact details, review eligibility and moderation are all viewer-specific.
 * Privileged actions (credential verification, review moderation) are gated in the
 * service, not here, so a missing guard in one route cannot widen access.
 */
import { Router } from "express";
import { z } from "zod";
import { ok } from "../core/envelope";
import { requireAuth, type AuthedRequest } from "../core/security";
import * as ha from "../services/higher-as.service";

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export const higherAsRouter = Router();
higherAsRouter.use(requireAuth);

/* ─────────────────────────────── feed ────────────────────────────────── */

higherAsRouter.get("/feed", async (req: AuthedRequest, res, next) => {
  try {
    const q = req.query as any;
    ok(
      res,
      "Vocational feed retrieved",
      await ha.listFeed(req.userId!, {
        q: str(q.q),
        trade: str(q.trade),
        city: str(q.city),
        verified: str(q.verified),
        available: str(q.available),
        min_rating: str(q.min_rating),
        sort: str(q.sort),
        saved: str(q.saved),
        limit: Number(q.limit) || undefined,
      })
    );
  } catch (e) {
    next(e);
  }
});

higherAsRouter.get("/trades", (_req, res) => ok(res, "Trades", { items: ha.TRADES }));

/* ──────────────────────────── my workspace ───────────────────────────── */

higherAsRouter.get("/me", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Your professional workspace", await ha.myPro(req.userId!));
  } catch (e) {
    next(e);
  }
});

const profileSchema = z.object({
  display_name: z.string().min(2).max(120),
  trade: z.string().min(2).max(40),
  headline: z.string().max(160).optional(),
  summary: z.string().max(2000).optional(),
  city: z.string().max(120).optional(),
  service_area: z.string().max(160).optional(),
  years_experience: z.number().int().min(0).max(70).optional(),
  phone: z.string().max(40).optional(),
  whatsapp: z.string().max(40).optional(),
  website: z.string().max(300).optional(),
  available: z.boolean().optional(),
  day_rate_min: z.number().int().nonnegative().optional(),
  day_rate_max: z.number().int().nonnegative().optional(),
  currency: z.string().max(8).optional(),
});

higherAsRouter.put("/me", async (req: AuthedRequest, res, next) => {
  try {
    const body = profileSchema.parse(req.body ?? {});
    ok(res, "Professional profile saved", await ha.upsertMyPro(req.userId!, body));
  } catch (e) {
    next(e);
  }
});

/* ───────────────────────────── profiles ──────────────────────────────── */

higherAsRouter.get("/pros/:id", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Professional retrieved", await ha.getPro(req.userId!, String(req.params.id)));
  } catch (e) {
    next(e);
  }
});

higherAsRouter.get("/pros/:id/contact", async (req: AuthedRequest, res, next) => {
  try {
    const data = await ha.proContact(req.userId!, String(req.params.id));
    res.setHeader("Cache-Control", "private, no-store");
    ok(res, "Contact details", data);
  } catch (e) {
    next(e);
  }
});

higherAsRouter.post("/pros/:id/save", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Saved", await ha.toggleSaved(req.userId!, String(req.params.id)));
  } catch (e) {
    next(e);
  }
});

/* ─────────────────────────────── posts ───────────────────────────────── */

const postSchema = z.object({
  title: z.string().min(3).max(180),
  body: z.string().max(4000).optional(),
  kind: z.enum(["work", "service"]).optional(),
  image_url: z.string().max(600).optional(),
  tags: z.array(z.string().max(40)).max(8).optional(),
});

higherAsRouter.post("/posts", async (req: AuthedRequest, res, next) => {
  try {
    const body = postSchema.parse(req.body ?? {});
    ok(res, "Post published", await ha.createPost(req.userId!, body), 201);
  } catch (e) {
    next(e);
  }
});

higherAsRouter.delete("/posts/:id", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Post removed", await ha.deletePost(req.userId!, String(req.params.id)));
  } catch (e) {
    next(e);
  }
});

/* ──────────────────────────── credentials ────────────────────────────── */

const credentialSchema = z.object({
  kind: z.enum(["licence", "certificate", "training", "registration"]).optional().default("certificate"),
  title: z.string().min(3).max(180),
  issuer: z.string().max(160).optional(),
  reference: z.string().max(120).optional(),
  issued_on: z.string().max(30).optional(),
  expires_on: z.string().max(30).optional(),
  document_name: z.string().max(200).optional(),
  document_b64: z.string().optional(),
});

higherAsRouter.post("/credentials", async (req: AuthedRequest, res, next) => {
  try {
    const body = credentialSchema.parse(req.body ?? {});
    ok(res, "Credential submitted for review", await ha.submitCredential(req.userId!, body as any), 201);
  } catch (e) {
    next(e);
  }
});

higherAsRouter.get("/credentials/queue", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Credentials awaiting review", await ha.credentialQueue(req.userId!));
  } catch (e) {
    next(e);
  }
});

higherAsRouter.get("/credentials/:id/document", async (req: AuthedRequest, res, next) => {
  try {
    const data = await ha.credentialDocument(req.userId!, String(req.params.id));
    res.setHeader("Cache-Control", "private, no-store");
    ok(res, "Credential document", data);
  } catch (e) {
    next(e);
  }
});

higherAsRouter.post("/credentials/:id/review", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ decision: z.enum(["verified", "rejected"]), note: z.string().max(500).optional() }).parse(req.body ?? {});
    ok(res, "Credential reviewed", await ha.reviewCredential(req.userId!, String(req.params.id), body.decision, body.note));
  } catch (e) {
    next(e);
  }
});

/* ──────────────────────────── engagements ────────────────────────────── */

higherAsRouter.post("/pros/:id/engagements", async (req: AuthedRequest, res, next) => {
  try {
    const body = z
      .object({ title: z.string().min(3).max(180), detail: z.string().max(1200).optional(), completed_at: z.string().max(40).optional() })
      .parse(req.body ?? {});
    ok(res, "Job recorded", await ha.createEngagement(req.userId!, String(req.params.id), body), 201);
  } catch (e) {
    next(e);
  }
});

higherAsRouter.post("/engagements/:id/confirm", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Job confirmed", await ha.confirmEngagement(req.userId!, String(req.params.id)));
  } catch (e) {
    next(e);
  }
});

/* ────────────────────────────── reviews ──────────────────────────────── */

higherAsRouter.post("/pros/:id/reviews", async (req: AuthedRequest, res, next) => {
  try {
    const body = z
      .object({ rating: z.number().int().min(1).max(5), body: z.string().min(10).max(3000), engagement_id: z.string().optional() })
      .parse(req.body ?? {});
    ok(res, "Review saved", await ha.createReview(req.userId!, String(req.params.id), body), 201);
  } catch (e) {
    next(e);
  }
});

higherAsRouter.post("/reviews/:id/response", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ response: z.string().min(2).max(1500) }).parse(req.body ?? {});
    ok(res, "Response published", await ha.respondToReview(req.userId!, String(req.params.id), body.response));
  } catch (e) {
    next(e);
  }
});

higherAsRouter.post("/reviews/:id/dispute", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ reason: z.string().min(10).max(1000) }).parse(req.body ?? {});
    ok(res, "Sent for moderation", await ha.disputeReview(req.userId!, String(req.params.id), body.reason));
  } catch (e) {
    next(e);
  }
});

higherAsRouter.get("/moderation", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Moderation queue", await ha.moderationQueue(req.userId!));
  } catch (e) {
    next(e);
  }
});

higherAsRouter.post("/reviews/:id/moderate", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ outcome: z.enum(["upheld", "dismissed"]), note: z.string().max(400).optional() }).parse(req.body ?? {});
    ok(res, "Review moderated", await ha.moderateReview(req.userId!, String(req.params.id), body.outcome, body.note));
  } catch (e) {
    next(e);
  }
});
