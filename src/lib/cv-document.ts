/**
 * The CV document — the printable sheet, and the only thing the preview shows.
 *
 * The geometry here is not invented. It was measured off a real FlowCV export
 * (`IRAOYA_ISRAEL_OMOKHAGBO_FlowCV_Resume_2026-09-30.pdf`, itself a Chrome print
 * of FlowCV's HTML — same pipeline this app uses, so the two can be compared
 * number for number). The export is a tagged Skia/PDF at 1 unit = 1 CSS px on a
 * 794 × 1126 px sheet:
 *
 *   sheet            794 × 1126 px (210 × 297mm), white, side margin 20mm
 *   name             Amiri Bold 32.66px, centred, baseline 84
 *   contact row      Amiri Regular 14px, centred, baseline 119, 14px icons
 *   section heading  Amiri Bold 15.33px, baseline H, then a 2px black rule at H + 7
 *   first body line  baseline H + 30, then 18px lines (14px Amiri)
 *   entry columns    left at the 20mm margin, right at x = 223.36
 *   skills           3 equal columns, 32px column gap, 9.5px row gap, 4px markers
 *
 * The document is *modelled* before it is rendered: `buildCvDoc` produces the
 * sections and lines, `renderCvHtml` turns that model into markup and
 * `estimateCvDoc` measures the same model with the same metrics. That is the
 * only way the page count the ATS panel reports can be trusted to describe the
 * page the printer produces — two independent code paths would drift, and a
 * length check that drifts is worse than no length check.
 *
 * Two deliberate consequences of copying the reference exactly: the document is
 * monochrome (every run in the reference is rgb(0,0,0)), and experience
 * descriptions are plain prose lines rather than bulleted items, which is what
 * the reference actually contains.
 */

/* ------------------------- the sheet, in CSS px -------------------------- */

const MM = 96 / 25.4;

/** Paper margin, in mm. Vertical comes from `@page` so every printed page is
 *  inset; horizontal is the sheet's own padding. */
const PAPER_TOP_MM = 15;
const PAPER_SIDE_MM = 20;

/** Average advance of Amiri at 14px, measured across the reference's own body
 *  lines (110 glyphs spanning 624.8px). Used only to estimate line wrapping. */
const CHAR_W = 5.68;

export const SHEET = {
  pageW: 794,
  pageH: 1122.67,
  /** usable content height of one printed page: the box between the paper margins */
  get contentH() {
    return this.pageH - 2 * PAPER_TOP_MM * MM;
  },
  nameSize: 32.66,
  nameLine: 1.2,
  contactSize: 14,
  contactLine: 14,
  contactGap: 12.7,
  headerBottom: 7.2,
  sectionTop: 19,
  headSize: 15.33,
  headLine: 19,
  headPad: 1,
  rule: 2,
  headGap: 9,
  bodySize: 14,
  bodyLine: 18,
  colLeft: 147.8,
  entryGap: 12,
  entryTop: 1,
  skillCols: 3,
  skillColGap: 32,
  skillRowGap: 9.5,
  skillInset: 2.4,
  get contentW() {
    return this.pageW - 2 * PAPER_SIDE_MM * MM;
  },
  /** the right column of a dated entry */
  get colRight() {
    return this.contentW - this.colLeft;
  },
  get skillCol() {
    return (this.contentW - 2 * this.skillColGap) / this.skillCols;
  },
} as const;

const wrapLines = (text: string, colWidth: number): number =>
  Math.max(1, Math.ceil(text.length / Math.floor(colWidth / CHAR_W)));

/* ------------------------------ the design -------------------------------- */

/**
 * Document settings. A CV is not one fixed sheet: the same words are set
 * differently for a one-page ATS read than for a two-page executive one, so the
 * geometry is *data*, not constants.
 *
 * Every field is optional and an absent field means **the measured default**, so
 * `{}` renders the reference document exactly and a CV saved before this panel
 * existed cannot shift by a pixel. Settings that change the geometry are folded
 * into `resolveMetrics`, which both the renderer and the page estimate read —
 * that is what keeps the reported page count true after a setting changes.
 */
export type CvDesign = {
  /** Paper: `a4` is the reference sheet, `letter` the US one. */
  page?: "a4" | "letter";
  /** `ink` | `ember` | `graphite`, or any CSS hex. */
  accent?: string;
  /** Body face. `serif` is the reference's Amiri; `sans` reads more neutral. */
  font?: "serif" | "sans";
  /** Body size in pt. 10.5pt is the reference's 14px. */
  base?: number;
  /** pt added to the name, the section headings and the entry titles. */
  nameDelta?: number;
  headDelta?: number;
  entryDelta?: number;
  /** Line height as a multiple of the body size. The reference is 1.29. */
  lineHeight?: number;
  /** px between sections and between entries. */
  sectionGap?: number;
  entryGap?: number;
  /** Paper margins in mm. */
  marginX?: number;
  marginY?: number;
  /** Skill columns, 1–4. */
  skillCols?: number;
  /** Section-heading case. */
  caps?: "none" | "capitalize" | "upper";
  /** The rule under a section heading. */
  rule?: boolean;
  /** Runs that carry the accent colour: the heading and its rule, or the rule only. */
  headTone?: "accent" | "ink";
  /** Which side the dates column sits on. */
  datePos?: "left" | "right";
  /** Header alignment (the name and the contact row). */
  align?: "center" | "left";
  /** Frame drawn around each contact icon. */
  icons?: IconFrame;
  /** A glyph beside each section heading: none, a bare outline, or a filled chip. */
  headIcons?: "none" | "outline" | "filled";
  /** Contact-link styling. */
  links?: { underline?: boolean; colored?: boolean };
  /** How a `YYYY-MM` / `YYYY/MM` date is written out. Anything else is left alone. */
  dates?: "keep" | "month" | "dots" | "hide";
};

export type IconFrame = "none" | "outline" | "circle" | "rounded" | "square" | "circle-fill" | "rounded-fill" | "square-fill";

export const ICON_FRAMES: IconFrame[] = ["none", "outline", "circle", "rounded", "square", "circle-fill", "rounded-fill", "square-fill"];

export const CV_PAPER = { a4: { w: 210, h: 297 }, letter: { w: 215.9, h: 279.4 } } as const;

/** 1pt in CSS px. Font sizes are authored in pt, the sheet is laid out in px. */
const PT = 96 / 72;

/** px → the shortest string that still round-trips, for generated CSS. */
const px = (n: number): string => String(Math.round(n * 100) / 100);
/** px → mm, because paper is specified in mm. */
const mm = (n: number): string => String(Math.round((n / MM) * 1000) / 1000);

const num = (v: unknown, d: number, lo: number, hi: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;

/**
 * Every distance the sheet uses, in CSS px, resolved from a design. The renderer
 * generates its CSS from this and `estimateCvDoc` measures with it, so the two
 * cannot disagree about how tall the document is.
 */
export type CvMetrics = {
  page: keyof typeof CV_PAPER;
  pageW: number;
  pageH: number;
  marginX: number;
  marginY: number;
  contentW: number;
  contentH: number;
  bodySize: number;
  bodyLine: number;
  entrySize: number;
  nameSize: number;
  headSize: number;
  contactSize: number;
  contactLine: number;
  contactGap: number;
  headerBottom: number;
  sectionTop: number;
  headLine: number;
  headPad: number;
  rule: number;
  headGap: number;
  entryTop: number;
  entryGap: number;
  colLeft: number;
  skillCols: number;
  skillColGap: number;
  skillRowGap: number;
  skillInset: number;
};

export function resolveMetrics(design: CvDesign = {}): CvMetrics {
  const page = design.page === "letter" ? "letter" : "a4";
  const paper = CV_PAPER[page];
  const marginX = num(design.marginX, PAPER_SIDE_MM, 8, 35) * MM;
  const marginY = num(design.marginY, PAPER_TOP_MM, 8, 35) * MM;
  const pageW = paper.w * MM;
  const pageH = paper.h * MM;
  const contentW = pageW - 2 * marginX;

  // one knob moves the type scale; the deltas are then absolute pt, the way a
  // desktop word processor presents them ("Full name +14pt")
  const grow = num(design.base, SHEET.bodySize / PT, 6, 16) / (SHEET.bodySize / PT);
  const bodySize = SHEET.bodySize * grow;
  const bodyLine = bodySize * num(design.lineHeight, SHEET.bodyLine / SHEET.bodySize, 1, 2.2);

  return {
    page,
    pageW,
    pageH,
    marginX,
    marginY,
    contentW,
    contentH: pageH - 2 * marginY,
    bodySize,
    bodyLine,
    entrySize: bodySize + num(design.entryDelta, 0, -5, 14) * PT,
    nameSize: SHEET.nameSize * grow + num(design.nameDelta, 0, -14, 30) * PT,
    headSize: SHEET.headSize * grow + num(design.headDelta, 0, -6, 16) * PT,
    contactSize: SHEET.contactSize * grow,
    contactLine: SHEET.contactLine * grow,
    contactGap: SHEET.contactGap * grow,
    headerBottom: SHEET.headerBottom * grow,
    sectionTop: num(design.sectionGap, SHEET.sectionTop, 6, 40) * grow,
    headLine: SHEET.headLine * grow + num(design.headDelta, 0, -6, 16) * PT,
    headPad: SHEET.headPad * grow,
    rule: design.rule === false ? 0 : SHEET.rule * grow,
    headGap: SHEET.headGap * grow,
    entryTop: SHEET.entryTop * grow,
    entryGap: num(design.entryGap, SHEET.entryGap, 2, 30) * grow,
    // the entry columns keep the reference's proportion as the margins move
    colLeft: (SHEET.colLeft / SHEET.contentW) * contentW,
    skillCols: Math.round(num(design.skillCols, SHEET.skillCols, 1, 4)),
    skillColGap: SHEET.skillColGap * grow,
    skillRowGap: SHEET.skillRowGap * grow,
    skillInset: SHEET.skillInset * grow,
  };
}

/** `#rrggbb`, or a key of `CV_ACCENTS`. Anything else falls back to paper black. */
export function resolveAccent(accent: unknown): string {
  const key = typeof accent === "string" ? accent.trim() : "";
  if (CV_ACCENTS[key]) return CV_ACCENTS[key];
  return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(key) ? key : CV_ACCENTS[DEFAULT_ACCENT];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const YM = /^(\d{4})[-/](\d{1,2})$/;

/**
 * Rewrite a `YYYY-MM` / `YYYY/MM` value per the design. Free text ("Summer 2024",
 * "2019") is passed through untouched — guessing at prose would mangle it.
 */
export function formatDate(value: unknown, mode: CvDesign["dates"] = "keep"): string {
  const s = String(value ?? "").trim();
  if (!s || s === "_") return s;
  if (mode === "hide") return "";
  const m = YM.exec(s);
  if (!m || (mode !== "month" && mode !== "dots")) return s;
  const mo = Math.min(12, Math.max(1, +m[2]));
  return mode === "month" ? `${MONTHS[mo - 1]} ${m[1]}` : `${String(mo).padStart(2, "0")}.${m[1]}`;
}

const applyCaps = (s: string, caps: CvDesign["caps"]): string =>
  caps === "upper"
    ? s.toUpperCase()
    : caps === "capitalize"
      ? s.replace(/\S+/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
      : s;

/* ------------------------------ accents --------------------------------- */

export const CV_ACCENTS: Record<string, string> = {
  /** the reference document: pure paper black */
  ink: "#000000",
  /** the app's brand hue, one step down — #ff9933 only clears 2:1 as text on paper */
  ember: "#b35f00",
  graphite: "#5b564f",
};

const DEFAULT_ACCENT = "ink";

/* ------------------------------- icons ---------------------------------- */

const I = (d: string, cls = "ico"): string =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${d}</svg>`;

const ICONS: Record<string, (cls?: string) => string> = {
  mail: (c) => I('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>', c),
  phone: (c) => I('<path d="M5 3h3l2 5-2.5 1.5a12 12 0 0 0 6 6L15 13l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2Z"/>', c),
  github: (c) => I('<path d="M9 19c-4 1.5-4-2-6-2.5m12 5v-3.9a3.4 3.4 0 0 0-.9-2.6c3-.3 4.9-1.7 4.9-5.9a4.6 4.6 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.2s-1-.3-3.4 1.3a11.6 11.6 0 0 0-6 0C5.8 2.4 4.8 2.7 4.8 2.7a4.3 4.3 0 0 0-.1 3.2A4.6 4.6 0 0 0 3.4 9.1c0 4.2 1.9 5.6 4.9 5.9a3.4 3.4 0 0 0-.9 2.6V21" transform="translate(1.4 .5) scale(.92)"/>', c),
  linkedin: (c) => I('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 10.5V17M8 7.2v.01M12.5 17v-3.6a2.2 2.2 0 0 1 4.4 0V17M12.5 10.5V17"/>', c),
  globe: (c) => I('<circle cx="12" cy="12" r="9"/><path d="M3.2 9.5h17.6M3.2 14.5h17.6M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z"/>', c),
  pin: (c) => I('<path d="M12 21.5s7-6.3 7-11.5a7 7 0 1 0-14 0c0 5.2 7 11.5 7 11.5Z"/><circle cx="12" cy="10" r="2.6"/>', c),
  // section-heading glyphs, for the `headIcons` setting
  user: (c) => I('<circle cx="12" cy="8" r="3.6"/><path d="M5.5 20c.6-3.6 3.3-5.6 6.5-5.6s5.9 2 6.5 5.6"/>', c),
  briefcase: (c) => I('<rect x="3" y="7.5" width="18" height="12" rx="2"/><path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M3 12.5h18"/>', c),
  code: (c) => I('<path d="m9 8-5 4 5 4M15 8l5 4-5 4"/>', c),
  book: (c) => I('<path d="M4 5.5A2 2 0 0 1 6 3.5h13v15H6a2 2 0 0 0-2 2Z"/><path d="M4 20.5A2 2 0 0 1 6 18.5h13"/>', c),
  award: (c) => I('<circle cx="12" cy="9" r="5.5"/><path d="m8.5 14-1.5 7 5-3 5 3-1.5-7"/>', c),
  folder: (c) => I('<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h6a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>', c),
  star: (c) => I('<path d="m12 3.5 2.7 5.6 6 .9-4.4 4.3 1.1 6-5.4-2.9-5.4 2.9 1.1-6L3.3 10l6-.9Z"/>', c),
};

/** The glyph a section heading carries when `headIcons` is on. */
const SECTION_ICONS: Record<string, keyof typeof ICONS> = {
  summary: "user",
  experience: "briefcase",
  skills: "code",
  education: "book",
  projects: "folder",
  awards: "award",
  custom: "star",
};

/* ------------------------------ helpers --------------------------------- */

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]!);

/** strip the scheme so a link reads as `github.com/izzychils` on the page */
const bare = (v: unknown): string => String(v ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");

const href = (v: unknown): string => {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  return /@/.test(s) ? `mailto:${s}` : `https://${s}`;
};

/** one paragraph per non-empty line — the reference's prose unit */
export const lines = (t: unknown): string[] =>
  String(t ?? "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

const paras = (t: unknown): string[] =>
  String(t ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);

/** `2026/07 – Present`, the reference's date form */
export function range(start: unknown, end: unknown, dates: CvDesign["dates"] = "keep"): string {
  const a = formatDate(start, dates);
  const b = formatDate(end, dates);
  if (!a && !b) return "";
  if (!a) return b;
  return `${a} \u2013 ${b || "Present"}`;
}

const HEADS: Record<string, string> = {
  summary: "Profile",
  experience: "Professional Experience",
  skills: "Skills",
  education: "Education",
  projects: "Projects",
  awards: "Awards",
  custom: "Section",
};

/* ------------------------------ the model -------------------------------- */

export type CvContact = { icon: keyof typeof ICONS; label: string; url: string };
export type CvLine =
  | { k: "prose"; text: string }
  | { k: "entry"; when: string; loc: string; title?: string; org?: string; body: string[] }
  | { k: "skills"; items: string[] };
export type CvSection = { head: string; lines: CvLine[]; /** glyph key, for the heading-icon setting */ icon?: keyof typeof ICONS };
export type CvDoc = { name: string; contact: CvContact[]; sections: CvSection[] };

/**
 * Everything the document is, in the order it appears. Nothing here knows about
 * HTML or about page counts; both consumers read this same shape.
 */
export function buildCvDoc(c: any, p: any, design: CvDesign = {}): CvDoc {
  const id: any = p?.identity ?? {};
  const links: any = id.links ?? {};
  const dates = design.dates;
  const caps = design.caps;

  const contact: CvContact[] = [
    id.email ? { icon: "mail" as const, label: String(id.email), url: href(id.email) } : null,
    id.phone ? { icon: "phone" as const, label: String(id.phone), url: href(id.phone) } : null,
    links.linkedin ? { icon: "linkedin" as const, label: bare(links.linkedin), url: href(links.linkedin) } : null,
    links.github ? { icon: "github" as const, label: bare(links.github), url: href(links.github) } : null,
    links.website ? { icon: "globe" as const, label: bare(links.website), url: href(links.website) } : null,
    id.location ? { icon: "pin" as const, label: String(id.location), url: "" } : null,
  ].filter(Boolean) as CvContact[];

  const profExps: any[] = p?.experiences ?? [];
  const profEdu: any[] = p?.education ?? [];
  const profSkills: any[] = p?.skills ?? [];

  const sections: CvSection[] = [];
  for (const b of c?.blocks ?? []) {
    const head = applyCaps(String(b.title || HEADS[b.type] || "Section"), caps);
    const body: CvLine[] = [];

    if (b.type === "summary" || b.type === "custom") {
      for (const para of paras(b.text)) body.push({ k: "prose", text: para });
    } else if (b.type === "skills") {
      // `groups` is the local override, otherwise the profile's skill list
      const fromGroups = (b.groups ?? []).flatMap((g: string) => lines(g).flatMap((l) => l.split(",")));
      const items = (fromGroups.length ? fromGroups : profSkills.map((s: any) => s.name))
        .map((x: any) => String(x ?? "").trim())
        .filter(Boolean);
      if (items.length) body.push({ k: "skills", items });
    } else if (b.type === "experience") {
      if (b.source === "profile") {
        for (const e of profExps)
          body.push({
            k: "entry",
            when: range(e.start_date, e.end_date, dates),
            loc: String(e.location ?? ""),
            title: String(e.title ?? ""),
            org: String(e.company ?? ""),
            body: Array.isArray(e.bullets) ? e.bullets.map(String) : [],
          });
      }
      // a hand-written entry: no dates to show, so the whole block is prose
      const local = lines(b.text);
      if (local.length) body.push({ k: "entry", when: "", loc: "", body: [...(b.bullets ?? []), ...local] });
    } else if (b.type === "education") {
      if (b.source === "profile") {
        for (const e of profEdu) {
          const qual = [e.degree, e.field]
            .map((x: any) => String(x ?? "").trim())
            .filter(Boolean)
            .join(" \u00b7 ");
          body.push({
            k: "entry",
            when: range(e.start_date, e.end_date, dates),
            loc: String(e.location ?? ""),
            title: qual,
            org: String(e.school ?? ""),
            body: [],
          });
        }
      }
      const local = lines(b.text);
      if (local.length) body.push({ k: "entry", when: "", loc: "", title: String(b.title ?? ""), body: local });
    } else if (b.type === "projects" || b.type === "awards") {
      const items = lines(b.text).length ? lines(b.text) : (b.bullets ?? []);
      if (items.length) body.push({ k: "entry", when: "", loc: "", body: items });
    }

    if (body.length) sections.push({ head, icon: SECTION_ICONS[b.type] ?? "star", lines: body });
  }

  return { name: String(id.name ?? "").trim() || String(c?.name ?? ""), contact, sections };
}

/* ------------------------------ the estimate ----------------------------- */

/**
 * A page count derived from the same model and metrics the CSS is generated from.
 *
 * The metrics arrive from `resolveMetrics`, never from `SHEET` directly, so a CV
 * set in Letter, at 11pt, with 8mm margins is measured against the sheet it will
 * actually print on. The contact row is the one place the estimate measures text
 * rather than counting lines: a long list of details wraps, and `flex-wrap` is
 * exactly what the CSS does with it.
 */
export function estimateCvDoc(doc: CvDoc, design: CvDesign = {}): { pages: number; usedPx: number } {
  const m = resolveMetrics(design);
  const charW = CHAR_W * (m.bodySize / SHEET.bodySize);
  let y = m.marginY; // the sheet's own top padding on screen
  y += m.nameSize * SHEET.nameLine;
  // one detail is `icon + label`, the details are separated by a 14px column gap;
  // a framed icon is a 20px box, not the bare 14px glyph
  const iconW = !design.icons || design.icons === "none" ? 22 : 28;
  const contactWidth = doc.contact.reduce((n, c) => n + c.label.length * charW + iconW + 14, 0);
  y += m.contactGap + m.contactLine * Math.max(1, Math.ceil(contactWidth / m.contentW));
  y += m.headerBottom;

  for (const section of doc.sections) {
    y += m.sectionTop;
    y += m.headLine + m.headPad + m.rule + m.headGap;
    if (section.lines.some((l) => l.k === "entry")) y += m.entryTop;

    section.lines.forEach((line, i) => {
      const last = i === section.lines.length - 1;
      if (line.k === "prose") {
        y += wrapLines(line.text, m.contentW) * m.bodyLine;
      } else if (line.k === "skills") {
        const rows = Math.ceil(line.items.length / m.skillCols);
        y += rows * m.bodyLine + Math.max(0, rows - 1) * m.skillRowGap;
      } else {
        const left = (line.when ? 1 : 0) + (line.loc ? 1 : 0);
        const right =
          (line.title ? 1 : 0) +
          (line.org ? 1 : 0) +
          line.body.reduce((n, t) => n + wrapLines(t, m.contentW - m.colLeft), 0);
        y += Math.max(left, right) * m.bodyLine;
        if (!last) y += m.entryGap;
      }
    });
  }

  return { pages: Math.max(1, Math.ceil(y / m.contentH)), usedPx: Math.round(y) };
}

export function estimateCvPages(c: any, p: any, design: CvDesign = {}): number {
  return estimateCvDoc(buildCvDoc(c, p, design), design).pages;
}

/* ----------------------------- the document ------------------------------ */

export type CvDocOptions = {
  /** kept for the editor's URL contract; the sheet is always a real page now */
  frame?: boolean;
  /** legacy accent key; `design.accent` wins when both are present */
  accent?: string;
  /** the CV's own document settings */
  design?: CvDesign;
  /**
   * The redline pass, keyed by the exact printed line. Present only while the
   * editor is reviewing: strikethrough for what goes, green for what replaces it.
   * Printing an annotated sheet prints the *accepted* text (see the print rules).
   */
  redline?: Record<string, { after: string; rule: string; note?: string }>;
  /** the ownership line a published CV can carry */
  copyright?: string;
};

export function renderCvHtml(c: any, p: any, opts: CvDocOptions = {}): string {
  const design: CvDesign =
    opts.accent && !opts.design?.accent ? { ...(opts.design ?? {}), accent: opts.accent } : (opts.design ?? {});
  const accent = resolveAccent(design.accent);
  const m = resolveMetrics(design);
  const doc = buildCvDoc(c, p, design);

  const face = design.font === "sans" ? "var(--sans)" : "var(--serif)";
  const align = design.align === "left" ? "left" : "center";
  // the frame class is interpolated into CSS, so only a known frame reaches it
  const frame: IconFrame = design.icons && ICON_FRAMES.includes(design.icons) ? design.icons : "none";
  // `circle-fill` is a shape plus a fill; the two are separate classes so a frame
  // and its fill can be chosen independently without enumerating seven combos
  const frameCls = frame === "none" ? "" : ` ico--${frame.replace("-fill", "")}${frame.endsWith("-fill") ? " ico--fill" : ""}`;
  const headIcon = !design.headIcons || design.headIcons === "none" ? "" : design.headIcons;
  const links = design.links ?? {};
  const dateRight = design.datePos === "right";
  const rule = m.rule > 0;
  const headColour = design.headTone === "ink" ? "var(--ink)" : "var(--mark)";
  const redline = opts.redline ?? {};

  /** A printed line, annotated when the redline pass has something to say about it. */
  const marked = (text: string): string => {
    const mark = redline[text];
    if (!mark) return esc(text);
    const body = mark.after ? `<del>${esc(text)}</del> <ins>${esc(mark.after)}</ins>` : esc(text);
    const note = mark.note ? ` <ins class="rl-note">+ ${esc(mark.note)}</ins>` : "";
    return body + note;
  };

  const linesHtml = (body: CvLine[]): string =>
    body
      .map((line) => {
        if (line.k === "prose") return `<p>${marked(line.text)}</p>`;
        if (line.k === "skills")
          return `<div class="skills">${line.items.map((x) => `<span>${esc(x)}</span>`).join("")}</div>`;
        const left = `${line.when ? `<div>${esc(line.when)}</div>` : ""}${line.loc ? `<div>${esc(line.loc)}</div>` : ""}`;
        const right =
          (line.title ? `<div class="t">${esc(line.title)}</div>` : "") +
          (line.org ? `<div class="org">${esc(line.org)}</div>` : "") +
          line.body.map((t) => `<p>${marked(t)}</p>`).join("");
        const when = `<div class="when">${left}</div>`;
        const what = `<div class="what">${right}</div>`;
        return `<div class="entry">${dateRight ? what + when : when + what}</div>`;
      })
      .join("");

  const sections = doc.sections
    .map((s) => {
      const glyph = headIcon ? ICONS[s.icon ?? "star"](`hico hico--${headIcon}`) : "";
      return `<section><h2>${glyph}${esc(s.head)}</h2>${linesHtml(s.lines)}</section>`;
    })
    .join("");

  const contactHtml = doc.contact.length
    ? `<div class="contact">${doc.contact
        .map((x) => {
          // the glyph is always drawn; `icons` only chooses its frame (the
          // default, "none", is the reference's bare 14px outline)
          const inner = `${ICONS[x.icon](`ico${frameCls}`)}<span>${esc(x.label)}</span>`;
          return x.url ? `<a href="${esc(x.url)}">${inner}</a>` : `<span>${inner}</span>`;
        })
        .join("")}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.name)} \u2014 CV</title>
<style>
/* Amiri is the face the reference document embeds (ascent 1.124em / descent
   0.634em, upem 1000 — identical to the file the PDF carries). Bundled rather
   than fetched so a CV prints the same on every machine, and \`block\` so nothing
   is laid out in a fallback face and re-flowed once the real one arrives. */
@font-face { font-family: Amiri; font-style: normal; font-weight: 400; font-display: block;
  src: url("/fonts/amiri-regular.woff2") format("woff2"); }
@font-face { font-family: Amiri; font-style: normal; font-weight: 700; font-display: block;
  src: url("/fonts/amiri-bold.woff2") format("woff2"); }
@font-face { font-family: Amiri; font-style: italic; font-weight: 400; font-display: block;
  src: url("/fonts/amiri-italic.woff2") format("woff2"); }

/* Every number below is one of the measured metrics; see SHEET in cv-document.ts,
   which is also what the page estimate is computed from. */
:root {
  --serif: Amiri, "Iowan Old Style", Palatino, "Palatino Linotype", "Book Antiqua", Georgia, "Times New Roman", serif;
  --sans: "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", ui-sans-serif, system-ui, sans-serif;
  --rule: ${esc(accent)};
  --ink: #000;
  --mark: ${esc(accent)};
  --side: ${mm(m.marginX)}mm;
  --myn: ${mm(m.marginY)}mm;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
/* vertical paper margin comes from the page box, so page 2 of a long CV is
   inset exactly like page 1; the sheet then only supplies the side margins.
   Written as millimetres, not a variable: custom properties do not resolve
   inside a page box, and an unresolved margin would silently become zero. */
@page { size: ${m.page}; margin: ${mm(m.marginY)}mm 0; }

.page {
  width: ${mm(m.pageW)}mm; min-height: ${mm(m.pageH)}mm; margin: 0 auto; background: #fff;
  padding: var(--myn) var(--side) 0;
  font: 400 ${px(m.bodySize)}px/${px(m.bodyLine)}px ${face};
  color: var(--ink); -webkit-font-kerning: normal;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
  /* the sheet is a document, not a web page: it must not inherit the app's
     text rendering or smoothing, or the print stops matching the preview */
  text-rendering: geometricPrecision;
}

/* ── header ────────────────────────────────────────────────────────────── */
.hdr { padding-bottom: ${px(m.headerBottom)}px; }
.name { font: 700 ${px(m.nameSize)}px/${SHEET.nameLine} ${face}; text-align: ${align}; margin: 0; letter-spacing: 0; }
.contact {
  display: flex; flex-wrap: wrap; justify-content: ${align === "left" ? "flex-start" : "center"}; align-items: center;
  gap: 6px 14px; margin-top: ${px(m.contactGap)}px; font-size: ${px(m.contactSize)}px; line-height: ${px(m.contactLine)}px;
}
.contact > a, .contact > span { display: inline-flex; align-items: center; gap: 8px;
  color: ${links.colored ? "var(--mark)" : "inherit"}; text-decoration: ${links.underline ? "underline" : "none"};
  text-underline-offset: 2px; text-decoration-thickness: 0.75px; }
.ico {
  width: 14px; height: 14px; flex: 0 0 14px; fill: none;
  stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round;
}
/* the frame the panel can draw around a contact icon: a shape, and a fill */
.ico--outline, .ico--circle, .ico--rounded, .ico--square {
  width: 20px; height: 20px; flex: 0 0 20px; padding: 2.6px; border: 1.2px solid var(--mark);
}
.ico--outline, .ico--square { border-radius: 0; }
.ico--rounded { border-radius: 5px; }
.ico--circle { border-radius: 50%; }
.ico--fill { background: var(--mark); border-color: var(--mark); color: #fff; }

/* ── sections ──────────────────────────────────────────────────────────── */
section { margin-top: ${px(m.sectionTop)}px; }
h2 {
  font: 700 ${px(m.headSize)}px/${px(m.headLine)}px ${face}; color: ${headColour};
  margin: 0 0 ${px(m.headGap)}px; padding-bottom: ${px(m.headPad)}px;
  border-bottom: ${rule ? `${px(m.rule)}px solid var(--mark)` : "0"};
}
/* the heading glyph: a bare outline, or a chip filled with the accent */
.hico { display: inline-block; vertical-align: -2.5px; margin-right: 7px;
  width: ${px(m.headSize)}px; height: ${px(m.headSize)}px; }
.hico--filled { padding: 2px; border-radius: 4px; background: var(--mark); color: #fff; }
p { margin: 0; }

/* ── dated entries: the dates column beside the entry body ──────────────── */
.entry { display: grid; grid-template-columns: ${dateRight ? `1fr ${px(m.colLeft)}px` : `${px(m.colLeft)}px 1fr`};
  margin-bottom: ${px(m.entryGap)}px; }
.entry:last-child { margin-bottom: 0; }
/* The reference starts an entry's first line 31px below its heading but prose
   lines at 30px — one pixel of its own box model, kept so every later section
   lands on the measured baseline instead of drifting. Padding, not margin:
   a margin here would collapse into the heading's own margin-bottom. */
h2 + .entry { padding-top: ${px(m.entryTop)}px; }
.when { font-size: ${px(m.bodySize)}px; line-height: ${px(m.bodyLine)}px; }
.what .t { font-size: ${px(m.entrySize)}px; line-height: ${px(m.bodyLine)}px; font-weight: 700; }
.what .org { font-style: italic; }

/* ── skills: equal columns with a square marker, as measured ───────────── */
.skills { display: grid; grid-template-columns: repeat(${m.skillCols}, 1fr);
  column-gap: ${px(m.skillColGap)}px; row-gap: ${px(m.skillRowGap)}px; padding-left: ${px(m.skillInset)}px; }
.skills > span { display: flex; align-items: center; gap: 6px; font-size: ${px(m.bodySize)}px;
  line-height: ${px(m.bodyLine)}px; break-inside: avoid; }
.skills > span::before { content: ""; width: 4px; height: 4px; flex: 0 0 4px; background: var(--mark); }

/* ── redline: what goes, and what replaces it ─────────────────────────── */
/* Review marks, not document formatting: red says strike this line, green says
   the rewrite (or the figure/claim the line is missing). */
del { color: #9f1414; background: #fdecec; text-decoration: line-through; text-decoration-thickness: 1px; }
ins { color: #0a6b3b; background: #e9f7ee; text-decoration: none; border-bottom: 1px solid rgb(10 107 59 / 0.5); }
ins.rl-note { display: inline-block; background: transparent; border: 1px dashed rgb(10 107 59 / 0.55);
  border-radius: 2px; padding: 0 3px; font-style: italic; font-size: 0.92em; }

/* the ownership line a published CV carries */
.copy { margin-top: ${px(m.sectionTop)}px; padding-top: 6px; border-top: 1px solid rgb(0 0 0 / 0.12);
  font-size: 8pt; text-align: center; color: rgb(0 0 0 / 0.62); }

/* On screen the sheet carries the 297mm floor and the top margin itself, so the
   preview shows a real page. On paper the page box supplies the vertical margin
   — which is what gives page 2 of a long CV the same inset as page 1. */
@media print { .page { min-height: 0; margin: 0; padding-top: 0; } }
/* Annotated sheets are a working copy. Printing accepts the edits: the struck
   line disappears, the rewrite prints as plain text, and the note stays advice. */
@media print {
  del { display: none; }
  ins { color: inherit; background: none; border: 0; text-decoration: none; }
  ins.rl-note { display: none; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>
</head>
<body>
<div class="page">
<header class="hdr">
  <h1 class="name">${esc(doc.name)}</h1>
  ${contactHtml}
</header>
${sections}
${opts.copyright ? `<footer class="copy">${esc(opts.copyright)}</footer>` : ""}
</div>
</body>
</html>`;
}
