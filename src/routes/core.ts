import { Router } from "express";
import { z } from "zod";
import { ok } from "../core/envelope";
import { requireAuth, type AuthedRequest } from "../core/security";
import * as profile from "../services/profile.service";
import * as cv from "../services/cv.service";
import * as captureSvc from "../services/capture.service";
import * as autofill from "../services/autofill.service";
import * as resumeImport from "../services/resume-import.service";
import { rateLimit } from "../core/middleware";
import * as net from "../services/network.service";
import { get as dbGet } from "../core/db";
import { notFound } from "../core/errors";
import { buildCvDoc, renderCvHtml } from "../lib/cv-document";
import { buildRedline } from "../lib/cv-redline";

export const profileRouter = Router();
profileRouter.use(requireAuth);

profileRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Profile retrieved", await profile.getProfile(req.userId!));
  } catch (e) {
    next(e);
  }
});

const profileSchema = z.object({
  identity: z.record(z.any()).optional(),
  prefs: z.record(z.any()).optional(),
  aliases: z.record(z.any()).optional(),
  skills: z.array(z.object({ name: z.string().min(1), level: z.string().nullish(), years: z.number().nullish(), is_top5: z.union([z.boolean(), z.number()]).optional() })).optional(),
  experiences: z
    .array(
      z.object({
        company: z.string().min(1),
        title: z.string().min(1),
        start_date: z.string().nullish(),
        end_date: z.string().nullish(),
        location: z.string().nullish(),
        bullets: z.array(z.string()).optional(),
      })
    )
    .optional(),
  education: z
    .array(z.object({ school: z.string().min(1), degree: z.string().nullish(), field: z.string().nullish(), start_date: z.string().nullish(), end_date: z.string().nullish() }))
    .optional(),
});

profileRouter.put("/", async (req: AuthedRequest, res, next) => {
  try {
    const body = profileSchema.parse(req.body);
    ok(res, "Profile saved", await profile.updateProfile(req.userId!, body));
  } catch (e) {
    next(e);
  }
});

profileRouter.get("/completeness", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Completeness", await profile.completeness(req.userId!));
  } catch (e) {
    next(e);
  }
});

/* ------------------------------- CVs & templates ------------------------------ */
export const cvRouter = Router();
cvRouter.use(requireAuth);

cvRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const q = req.query as any;
    ok(res, "CVs retrieved", { items: await cv.listCVs(req.userId!, { archetype: q.archetype, category: q.category }) });
  } catch (e) {
    next(e);
  }
});

/**
 * The CV's document settings (§24.1). Validated here rather than trusted: the
 * values become CSS lengths, so a string where a number belongs would print as
 * `NaNpx`. Every bound matches the one `resolveMetrics` clamps to.
 */
const designSchema = z.object({
  page: z.enum(["a4", "letter"]).optional(),
  accent: z.string().max(32).optional(),
  font: z.enum(["serif", "sans"]).optional(),
  base: z.number().min(6).max(16).optional(),
  nameDelta: z.number().min(-14).max(30).optional(),
  headDelta: z.number().min(-6).max(16).optional(),
  entryDelta: z.number().min(-5).max(14).optional(),
  lineHeight: z.number().min(1).max(2.2).optional(),
  sectionGap: z.number().min(6).max(40).optional(),
  entryGap: z.number().min(2).max(30).optional(),
  marginX: z.number().min(8).max(35).optional(),
  marginY: z.number().min(8).max(35).optional(),
  skillCols: z.number().int().min(1).max(4).optional(),
  caps: z.enum(["none", "capitalize", "upper"]).optional(),
  rule: z.boolean().optional(),
  headTone: z.enum(["accent", "ink"]).optional(),
  datePos: z.enum(["left", "right"]).optional(),
  align: z.enum(["center", "left"]).optional(),
  icons: z.enum(["none", "outline", "circle", "rounded", "square", "circle-fill", "rounded-fill", "square-fill"]).optional(),
  headIcons: z.enum(["none", "outline", "filled"]).optional(),
  links: z.object({ underline: z.boolean().optional(), colored: z.boolean().optional() }).optional(),
  dates: z.enum(["keep", "month", "dots", "hide"]).optional(),
});

const cvSchema = z.object({
  name: z.string().min(1),
  archetype: z.enum(["opening", "pitch"]).optional(),
  career_category: z.string().optional(),
  targeting: z.record(z.any()).optional(),
  blocks: z.array(z.record(z.any())).optional(),
  design: designSchema.optional(),
  template_id: z.string().nullish(),
});

cvRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "CV created", await cv.createCV(req.userId!, cvSchema.parse(req.body) as any), 201);
  } catch (e) {
    next(e);
  }
});

cvRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "CV retrieved", await cv.getCV(req.userId!, String(req.params.id)));
  } catch (e) {
    next(e);
  }
});

cvRouter.put("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const patch = cvSchema.partial().extend({ blocks: z.array(z.record(z.any())).optional() }).parse(req.body);
    ok(res, "CV updated", await cv.updateCV(req.userId!, String(req.params.id), patch as any));
  } catch (e) {
    next(e);
  }
});

cvRouter.delete("/:id", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "CV deleted", await cv.deleteCV(req.userId!, String(req.params.id)));
  } catch (e) {
    next(e);
  }
});

cvRouter.post("/:id/duplicate", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "CV duplicated", await cv.duplicateCV(req.userId!, String(req.params.id), req.body?.name), 201);
  } catch (e) {
    next(e);
  }
});

cvRouter.get("/:id/match", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Match report", await cv.matchCV(req.userId!, String(req.params.id), req.query.posting_id as string | undefined));
  } catch (e) {
    next(e);
  }
});

/* ── publishing & reviews ─────────────────────────────────────────────── */

/** Publish/unpublish a CV and set the ownership line printed under it. */
cvRouter.put("/:id/publish", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ public: z.boolean().optional(), copyright: z.string().max(240).nullish() }).parse(req.body ?? {});
    ok(res, body.public ? "CV published" : "CV visibility updated", await net.publishCv(req.userId!, String(req.params.id), body));
  } catch (e) {
    next(e);
  }
});

/** The reviews on a CV: its owner sees them always, everyone else only if it is public. */
cvRouter.get("/:id/reviews", async (req: AuthedRequest, res, next) => {
  try {
    const c = await dbGet<any>("SELECT id, user_id, public FROM cvs WHERE id = ?", String(req.params.id));
    if (!c) throw notFound("CV");
    if (!c.public && c.user_id !== req.userId) throw notFound("CV");
    ok(res, "Reviews retrieved", await net.listCvReviews(c.id));
  } catch (e) {
    next(e);
  }
});

cvRouter.post("/:id/reviews", async (req: AuthedRequest, res, next) => {
  try {
    const body = z
      .object({ rating: z.number().min(1).max(5), body: z.string().min(10).max(2000), relationship: z.enum(["hirer", "recruiter", "mentor", "peer"]).optional() })
      .parse(req.body ?? {});
    ok(res, "Review saved", await net.addCvReview(req.userId!, String(req.params.id), body), 201);
  } catch (e) {
    next(e);
  }
});

cvRouter.get("/:id/suggest", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "CV suggestions", await cv.suggestCVs(req.userId!, req.query.posting_id as string | undefined));
  } catch (e) {
    next(e);
  }
});

/**
 * Print-ready A4 HTML. Chromium's own print pipeline turns it into the PDF, so the
 * editor's preview and the printed page are the same document, at the same
 * geometry - see `../lib/cv-document` for the measured layout it implements.
 *
 * `?frame=1` is kept for the editor's URL contract; the document is always a real
 * 210×297mm sheet now, so the flag no longer changes the output. `?accent=` picks
 * the document's rule/marker colour (default: the reference's paper black).
 */
cvRouter.get("/:id/html", async (req: AuthedRequest, res, next) => {
  try {
    const c = await cv.getCV(req.userId!, String(req.params.id));
    const p = await profile.getProfile(req.userId!);
    const q = req.query as { frame?: string; accent?: string; design?: string; redline?: string; kw?: string };
    // The editor sends the design it is *currently editing* as `?design=` so a
    // setting lands on the sheet instantly rather than after the autosave, and a
    // design it has just reset to `{}` previews as the default sheet instead of
    // the last saved one. A malformed one is ignored, never a 500: the sheet can
    // always fall back to what is stored.
    let preview: unknown;
    if (typeof q.design === "string" && q.design.length <= 2000) {
      try {
        preview = designSchema.parse(JSON.parse(q.design));
      } catch {
        preview = undefined;
      }
    }
    // `?redline=1` renders the working copy: struck lines in red, rewrites and the
    // missing figure or keyword in green. Computing it here (rather than passing
    // markup over the wire) means the sheet and the ATS panel cannot disagree.
    let redline: Record<string, { after: string; rule: string; note?: string }> | undefined;
    if (q.redline === "1") {
      const design = (preview ?? c.design) as Parameters<typeof buildCvDoc>[2];
      const doc = buildCvDoc(c, p, design);
      const missing = String(q.kw ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 3);
      redline = buildRedline({ doc, missingKeywords: missing }).markup;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // `?accent=` stays for the older deep links that still carry it
    res.send(
      renderCvHtml(c, p, {
        frame: q.frame === "1",
        accent: q.accent,
        design: preview ?? c.design,
        redline,
        copyright: c.copyright ?? undefined,
      })
    );
  } catch (e) {
    next(e);
  }
});

export const templateRouter = Router();
templateRouter.use(requireAuth);

templateRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const q = req.query as any;
    ok(res, "Templates retrieved", { items: await cv.listTemplates(req.userId!, { kind: q.kind, archetype: q.archetype }) });
  } catch (e) {
    next(e);
  }
});
templateRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const body = z
      .object({ kind: z.enum(["cv", "email"]), archetype: z.enum(["opening", "pitch"]), name: z.string().min(1), subject: z.string().nullish(), body: z.string(), variables: z.array(z.string()).optional() })
      .parse(req.body);
    ok(res, "Template created", await cv.createTemplate(req.userId!, body as any), 201);
  } catch (e) {
    next(e);
  }
});
templateRouter.put("/:id", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Template updated", await cv.updateTemplate(req.userId!, String(req.params.id), req.body));
  } catch (e) {
    next(e);
  }
});
templateRouter.delete("/:id", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Template deleted", await cv.deleteTemplate(req.userId!, String(req.params.id)));
  } catch (e) {
    next(e);
  }
});
templateRouter.post("/preview", (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ body: z.string(), vars: z.record(z.any()).default({}) }).parse(req.body);
    ok(res, "Merged preview", { merged: cv.mergeTemplate(body.body, body.vars), variables: cv.extractVars(body.body) });
  } catch (e) {
    next(e);
  }
});

/* -------------------------- capture & autofill -------------------------- */
export const captureRouter = Router();
captureRouter.use(requireAuth);
const captureLimiter = rateLimit("capture", 60, 60 * 60_000);

captureRouter.post("/preview", captureLimiter, async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ url: z.string().url(), html_text: z.string().optional() }).parse(req.body);
    ok(res, "Preview parsed", await captureSvc.previewCapture(req.userId!, body.url, body.html_text));
  } catch (e) {
    next(e);
  }
});

captureRouter.post("/", captureLimiter, async (req: AuthedRequest, res, next) => {
  try {
    const body = z
      .object({
        source: z.enum(["extension", "paste", "agent", "manual"]),
        url: z.string().url(),
        html_text: z.string().optional(),
        page: z
          .object({
            title: z.string().optional(),
            company_guess: z.string().optional(),
            text_excerpt: z.string().optional(),
            salary_text: z.string().optional(),
            posted_text: z.string().optional(),
            form_fields: z.array(z.object({ name: z.string().optional(), label: z.string().optional(), type: z.string().optional() })).optional(),
          })
          .optional(),
        action: z.enum(["log_only", "create_draft", "mark_submitted"]).optional(),
        kind: z.enum(["application", "pitch"]).optional(),
        contact_email: z.string().optional(),
      })
      .parse(req.body);
    ok(res, "Captured", await captureSvc.capture(req.userId!, body as any), 201);
  } catch (e) {
    next(e);
  }
});

export const autofillRouter = Router();
autofillRouter.use(requireAuth);

autofillRouter.get("/schema", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Autofill schema", await autofill.autofillSchema(req.userId!));
  } catch (e) {
    next(e);
  }
});

autofillRouter.post("/match", async (req: AuthedRequest, res, next) => {
  try {
    const body = z
      .object({
        host: z.string().default("unknown"),
        fields: z.array(z.object({ name: z.string().optional(), id: z.string().optional(), label: z.string().optional(), autocomplete: z.string().optional(), placeholder: z.string().optional(), type: z.string().optional(), section: z.string().optional() })),
      })
      .parse(req.body);
    ok(res, "Field mappings", await autofill.matchFields(req.userId!, body.host, body.fields));
  } catch (e) {
    next(e);
  }
});

autofillRouter.post("/confirm", (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ host: z.string(), field_signature: z.string(), profile_key: z.string() }).parse(req.body);
    ok(res, "Mapping learned", autofill.confirmMapping(req.userId!, body.host, body.field_signature, body.profile_key));
  } catch (e) {
    next(e);
  }
});

/** Resume upload → profile answers (§35): PDF/txt in, reviewed identity out. */
autofillRouter.post("/parse-resume", async (req: AuthedRequest, res, next) => {
  try {
    const body = z
      .object({
        filename: z.string().min(1).max(200),
        content_base64: z.string().min(1).max(6_000_000),
      })
      .parse(req.body);
    ok(res, "Resume parsed", await resumeImport.parseResume(Buffer.from(body.content_base64, "base64"), body.filename));
  } catch (e) {
    next(e);
  }
});

/* ------------------------------ companies ------------------------------ */
export const companyRouter = Router();
companyRouter.use(requireAuth);

companyRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const q = req.query as any;
    ok(res, "Companies retrieved", { items: await captureSvc.listCompanies(req.userId!, { tier: q.tier, q: q.q }) });
  } catch (e) {
    next(e);
  }
});
companyRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Company retrieved", await captureSvc.getCompany(req.userId!, String(req.params.id)));
  } catch (e) {
    next(e);
  }
});
