import { Router } from "express";
import { z } from "zod";
import { ok } from "../core/envelope";
import { requireAuth, type AuthedRequest } from "../core/security";
import * as out from "../services/outreach.service";
import { get, run, nowIsoSafe } from "./_helpers";
import { newId, nowIso } from "../util/id";
import type { Classification } from "../services/classify.service";

export const outreachRouter = Router();
outreachRouter.use(requireAuth);

outreachRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const q = req.query as any;
    ok(res, "Outreach retrieved", { items: await out.listOutreach(req.userId!, { state: q.state, app_id: q.app_id }) });
  } catch (e) {
    next(e);
  }
});

const createSchema = z.object({
  app_id: z.string().nullish(),
  contact_id: z.string().nullish(),
  template_id: z.string().nullish(),
  subject: z.string().min(1),
  body: z.string().min(1),
  step_no: z.number().optional(),
});

outreachRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Draft created", await out.createOutreach(req.userId!, createSchema.parse(req.body) as any), 201);
  } catch (e) {
    next(e);
  }
});

outreachRouter.get("/cadence", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Cadence health", await out.cadenceHealth(req.userId!));
  } catch (e) {
    next(e);
  }
});

outreachRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Outreach retrieved", await out.getOutreach(req.userId!, String(req.params.id)));
  } catch (e) {
    next(e);
  }
});

outreachRouter.put("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const patch = z.object({ subject: z.string().optional(), body: z.string().optional(), scheduled_at: z.string().optional(), state: z.string().optional() }).parse(req.body);
    ok(res, "Outreach updated", await out.updateOutreach(req.userId!, String(req.params.id), patch));
  } catch (e) {
    next(e);
  }
});

outreachRouter.post("/:id/send", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ via: z.enum(["gmail_open", "smtp"]).default("gmail_open"), confirm: z.boolean().default(false) }).parse(req.body ?? {});
    ok(res, "Send prepared — confirm in your mail client", await out.sendOutreach(req.userId!, String(req.params.id), body));
  } catch (e) {
    next(e);
  }
});

outreachRouter.put("/:id/sequence", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ steps: z.array(z.object({ delay_days: z.number(), subject: z.string(), body: z.string(), enabled: z.boolean().optional() })) }).parse(req.body);
    const msg = await out.getOutreach(req.userId!, String(req.params.id));
    if (!msg.app_id) return ok(res, "Sequence requires an application", { steps: [] });
    ok(res, "Sequence updated", await out.setSequence(req.userId!, msg.app_id, body.steps));
  } catch (e) {
    next(e);
  }
});

/* ------------------------------ mailboxes ------------------------------ */
export const mailboxRouter = Router();
mailboxRouter.use(requireAuth);

mailboxRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const rows = (await get(`SELECT id, kind, address, open_tracking, last_synced_at FROM mailboxes WHERE user_id = ?`, req.userId!)) as any;
    ok(res, "Mailboxes", { items: rows ? [rows] : [], connected: !!rows });
  } catch (e) {
    next(e);
  }
});mailboxRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ kind: z.enum(["imap", "gmail"]).default("imap"), address: z.string().email(), config: z.record(z.any()).default({}), open_tracking: z.boolean().default(false) }).parse(req.body);

    const id = newId();
    await run(
      `INSERT INTO mailboxes (id, user_id, kind, address, config, open_tracking, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      req.userId!,
      body.kind,
      body.address,
      JSON.stringify(body.config),
      body.open_tracking ? 1 : 0,
      nowIso()
    );
    ok(res, "Mailbox connected (local mode: no live sync worker yet)", { id, ...body, last_synced_at: null }, 201);
  } catch (e) {
    next(e);
  }
});

mailboxRouter.post("/:id/sync", (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Sync not running in local mode — use /inbox/messages to ingest", { new: 0, updated: 0, mode: process.env.MODE ?? "local" });
  } catch (e) {
    next(e);
  }
});

/* -------------------------------- inbox -------------------------------- */
export const inboxRouter = Router();
inboxRouter.use(requireAuth);

/**
 * Ingest an inbound message — the free stand-in for IMAP polling: fixtures, MailPit-captured
 * mail, or a future worker all funnel through the same classification pipeline (§36.2).
 */
inboxRouter.post("/messages", async (req: AuthedRequest, res, next) => {
  try {
    const body = z
      .object({
        message_id: z.string().optional(),
        in_reply_to: z.string().optional(),
        subject: z.string().optional(),
        from: z.string(),
        to: z.string().optional(),
        body: z.string().optional(),
        headers: z.record(z.string()).optional(),
        thread_subject: z.string().optional(),
      })
      .parse(req.body);
    ok(res, "Message ingested", await out.ingestInbound(req.userId!, body as any), 201);
  } catch (e) {
    next(e);
  }
});

inboxRouter.get("/threads", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Threads", { items: await out.listThreads(req.userId!) });
  } catch (e) {
    next(e);
  }
});

inboxRouter.get("/threads/:id", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Thread", await out.getThread(req.userId!, String(req.params.id)));
  } catch (e) {
    next(e);
  }
});

inboxRouter.post("/threads/:id/classify", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ message_id: z.string(), classification: z.enum(["interested", "interview_invite", "rejected", "auto_reply", "ooo", "bounce", "neutral"]) }).parse(req.body);
    ok(res, "Classification corrected", await out.classifyMessage(req.userId!, body.message_id, body.classification as Classification));
  } catch (e) {
    next(e);
  }
});

/* ------------------------------- tracking ------------------------------ */
export const trackingRouter = Router();

/** 1×1 open pixel — unguessable token, no PII in URL (§36.4), opt-in per mailbox. */
trackingRouter.get("/pixel/:token.gif", async (req, res) => {
  const t = String(req.params.token);
  try {
    await run("UPDATE outreach_messages SET opens = opens + 1 WHERE tracking_token = ?", t);
  } catch {}
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store");
  res.send(gif);
});

trackingRouter.get("/click/:token", async (req, res) => {
  const t = String(req.params.token);
  try {
    await run("UPDATE outreach_messages SET clicks = clicks + 1 WHERE tracking_token = ?", t);
    const msg = (await get("SELECT app_id FROM outreach_messages WHERE tracking_token = ?", t)) as any;
    const dest = msg?.app_id ? ((await get("SELECT url FROM applications WHERE id = ?", msg.app_id)) as any)?.url : null;
    res.redirect(302, dest ?? "/");
  } catch {
    res.redirect(302, "/");
  }
});
