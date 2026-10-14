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

const cvSchema = z.object({
  name: z.string().min(1),
  archetype: z.enum(["opening", "pitch"]).optional(),
  career_category: z.string().optional(),
  targeting: z.record(z.any()).optional(),
  blocks: z.array(z.record(z.any())).optional(),
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

cvRouter.get("/:id/suggest", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "CV suggestions", await cv.suggestCVs(req.userId!, req.query.posting_id as string | undefined));
  } catch (e) {
    next(e);
  }
});

/**
 * Print-ready A4 HTML, the browser's print pipeline (Chromium) renders the PDF (§24.1).
 *
 * `?frame=1` wraps the document in a real 210×297mm sheet so the editor can scale it
 * to any zoom without guessing at margins, and `?accent=` switches the document accent.
 * Same HTML either way, so the preview cannot drift from the printed page.
 */
cvRouter.get("/:id/html", async (req: AuthedRequest, res, next) => {
  try {
    const c = await cv.getCV(req.userId!, String(req.params.id));
    const p = await profile.getProfile(req.userId!);
    const q = req.query as { frame?: string; accent?: string };
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderCvHtml(c, p, { frame: q.frame === "1", accent: CV_ACCENTS[q.accent ?? ""] ?? CV_ACCENTS.ember }));
  } catch (e) {
    next(e);
  }
});

/**
 * Document accents. These are the darker rungs of the app's single accent hue:
 * pure #ff9933 is a screen colour and only clears 2:1 as text on white paper, so
 * the default document accent is the same hue one step down.
 */
const CV_ACCENTS: Record<string, string> = {
  ember: "#b35f00",
  ink: "#17130f",
  graphite: "#5b564f",
};

/**
 * Structured like the reference FlowCV resume: uppercase name header + contact row
 * under a rule, uppercase section headings, dated entries as a two-column grid
 * (dates/location left, content right), skills as a multi-column grid, prose as
 * justified paragraphs. Profile-sourced blocks expand from the master profile.
 */
function renderCvHtml(c: any, p: any, opts: { frame: boolean; accent: string } = { frame: false, accent: CV_ACCENTS.ember }): string {
  const esc = (s: string) => String(s ?? "").replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[m]!);
  const id = p?.identity ?? {};
  const links = id.links ?? {};
  const clean = (v: any) => String(v ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "").trim();

  const name = String(id.name ?? "").trim() || c.name;
  const contact = [id.email, id.phone, id.location, clean(links.linkedin)].map((x) => String(x ?? "").trim()).filter(Boolean);

  const fmtRange = (s: any, e: any) => {
    const a = String(s ?? "").trim();
    const b = String(e ?? "").trim();
    if (!a && !b) return "";
    if (!a) return esc(b);
    return `${esc(a)} – ${esc(b || "Present")}`;
  };
  const lines = (t: any) => String(t ?? "").split(/\n/).map((x) => x.trim()).filter(Boolean);
  const paras = (t: any) => String(t ?? "")
    .split(/\n\s*\n/)
    .map((para) => esc(para.replace(/\s*\n\s*/g, " ")).trim())
    .filter(Boolean);
  const bulletList = (arr: string[]) =>
    arr.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  const entry = (when: string, loc: string, what: string) =>
    `<div class="entry"><div class="when">${when ? `<div class="d">${when}</div>` : ""}${loc ? `<div class="loc">${esc(loc)}</div>` : ""}</div><div class="what">${what}</div></div>`;

  const HEADS: Record<string, string> = {
    summary: "Profile",
    experience: "Experience",
    skills: "Skills",
    education: "Education",
    projects: "Projects",
    awards: "Awards",
    custom: "Section",
  };

  const profExps: any[] = p?.experiences ?? [];
  const profEdu: any[] = p?.education ?? [];
  const profSkills: any[] = p?.skills ?? [];

  const body = c.blocks
    .map((b: any) => {
      const head = esc(b.title || HEADS[b.type] || "Section");
      const section = (inner: string) => (inner ? `<section><h2>${head}</h2>${inner}</section>` : "");

      if (b.type === "summary") return section(paras(b.text).map((x) => `<p class="prose">${x}</p>`).join(""));
      if (b.type === "custom") return section(paras(b.text).map((x) => `<p class="prose">${x}</p>`).join(""));

      if (b.type === "skills") {
        const fromGroups = (b.groups ?? []).flatMap((g: string) => lines(g).flatMap((l) => l.split(",")));
        const items = (fromGroups.length ? fromGroups : profSkills.map((s: any) => s.name))
          .map((x: any) => String(x ?? "").trim())
          .filter(Boolean);
        return section(items.length ? `<div class="skills">${items.map((x: string) => `<span>${esc(x)}</span>`).join("")}</div>` : "");
      }

      if (b.type === "experience") {
        const fromProfile = (b.source === "profile" ? profExps : [])
          .map((e: any) => entry(fmtRange(e.start_date, e.end_date), e.location, `<div class="t">${esc(e.title)}</div>${e.company ? `<div class="org">${esc(e.company)}</div>` : ""}${bulletList(e.bullets ?? [])}`))
          .join("");
        const local = lines(b.text).length
          ? entry("", "", `${b.title ? `<div class="t">${esc(b.title)}</div>` : ""}${bulletList(lines(b.text))}`)
          : "";
        return section(fromProfile + local);
      }

      if (b.type === "education") {
        const fromProfile = (b.source === "profile" ? profEdu : [])
          .map((e: any) => {
            const qual = [e.degree, e.field].map((x: any) => String(x ?? "").trim()).filter(Boolean).join(" · ");
            const what = `${qual ? `<div class="t">${esc(qual)}</div>` : ""}${e.school ? `<div class="org">${esc(e.school)}</div>` : ""}`;
            return entry(fmtRange(e.start_date, e.end_date), "", what);
          })
          .join("");
        const local = lines(b.text).length
          ? entry("", "", `${b.title ? `<div class="t">${esc(b.title)}</div>` : ""}${bulletList(lines(b.text))}`)
          : "";
        return section(fromProfile + local);
      }

      if (b.type === "projects" || b.type === "awards") {
        const items = lines(b.text).length ? lines(b.text) : (b.bullets ?? []);
        return section(items.length ? bulletList(items) : "");
      }

      return "";
    })
    .join("");

  const contactHtml = contact.length
    ? `<div class="contact">${contact.map((x) => `<span>${esc(x)}</span>`).join("")}</div>`
    : "";

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(name)}</title>
<style>
 :root { --accent: ${esc(opts.accent)}; --ink: #17130f; --soft: #4d4842; --faint: #6f6961; --rule: #dad4cc; }
 @page { size: A4; margin: 15mm; }
 * { box-sizing: border-box; }
 html, body { margin: 0; }
 body { font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: var(--ink); font-size: 10.4pt; line-height: 1.45; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
 /* the sheet: exact A4 geometry, so a parent can scale it to any zoom and the
   printed page stays identical. Padding is dropped again for print because
   @page margin already supplies it. */
 .page { width: 210mm; min-height: 297mm; padding: 15mm; margin: 0 auto; background: #fff; }
 header { padding-bottom: 9pt; border-bottom: 2px solid var(--accent); }
 .name { font-size: 22pt; font-weight: 800; letter-spacing: .045em; text-transform: uppercase; line-height: 1.08; margin: 0; }
 .headline { font-size: 10.2pt; font-weight: 600; color: var(--soft); margin: 3.5pt 0 0; }
 .contact { display: flex; flex-wrap: wrap; gap: 2pt 14pt; font-size: 9.2pt; color: var(--faint); margin-top: 7pt; }
 section { margin-top: 13pt; }
 section:first-of-type { margin-top: 15pt; }
 h2 { font-size: 10.4pt; font-weight: 800; text-transform: uppercase; letter-spacing: .14em; color: var(--accent); margin: 0 0 7pt; padding-bottom: 3pt; border-bottom: 1px solid var(--rule); }
 .entry { display: grid; grid-template-columns: 33mm 1fr; gap: 0 10pt; margin-bottom: 9pt; page-break-inside: avoid; }
 .entry:last-child { margin-bottom: 0; }
 .when { font-size: 9.2pt; }
 .when .d { font-weight: 700; color: var(--soft); }
 .when .loc { color: var(--faint); font-size: 8.8pt; margin-top: 1pt; }
 .what .t { font-weight: 700; }
 .what .org { color: var(--soft); font-size: 9.6pt; }
 ul { margin: 3.5pt 0 0; padding-left: 14pt; }
 li { margin-bottom: 1.5pt; }
 li::marker { color: var(--accent); }
 p.prose { margin: 0 0 5pt; }
 p.prose:last-child { margin-bottom: 0; }
 /* one flowing line rather than a grid: skills stay a plain comma-ish list, which
   is what a parser reads most reliably, with the accent carrying the separators */
 .skills { font-size: 10pt; }
 .skills span:not(:last-child)::after { content: "·"; color: var(--accent); margin: 0 7pt; }
 @media print { .page { width: auto; min-height: 0; padding: 0; margin: 0; background: none; } }
</style></head><body>
${opts.frame ? `<div class="page">` : ""}
<header><h1 class="name">${esc(name)}</h1>${id.headline ? `<p class="headline">${esc(id.headline)}</p>` : ""}${contactHtml}</header>
${body}
${opts.frame ? `</div>` : ""}
</body></html>`;
}

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
