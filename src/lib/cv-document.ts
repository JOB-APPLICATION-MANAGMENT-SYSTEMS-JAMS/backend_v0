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
export function range(start: unknown, end: unknown): string {
  const a = String(start ?? "").trim();
  const b = String(end ?? "").trim();
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
export type CvSection = { head: string; lines: CvLine[] };
export type CvDoc = { name: string; contact: CvContact[]; sections: CvSection[] };

/**
 * Everything the document is, in the order it appears. Nothing here knows about
 * HTML or about page counts; both consumers read this same shape.
 */
export function buildCvDoc(c: any, p: any): CvDoc {
  const id: any = p?.identity ?? {};
  const links: any = id.links ?? {};

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
    const head = String(b.title || HEADS[b.type] || "Section");
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
            when: range(e.start_date, e.end_date),
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
            when: range(e.start_date, e.end_date),
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

    if (body.length) sections.push({ head, lines: body });
  }

  return { name: String(id.name ?? "").trim() || String(c?.name ?? ""), contact, sections };
}

/* ------------------------------ the estimate ----------------------------- */

/** A page count derived from the same model and metrics the CSS is generated from. */
export function estimateCvDoc(doc: CvDoc): { pages: number; usedPx: number } {
  let y = PAPER_TOP_MM * MM; // the sheet's own top padding on screen
  y += SHEET.nameSize * SHEET.nameLine;
  y += SHEET.contactGap + SHEET.contactLine;
  y += SHEET.headerBottom;

  for (const section of doc.sections) {
    y += SHEET.sectionTop;
    y += SHEET.headLine + SHEET.headPad + SHEET.rule + SHEET.headGap;
    if (section.lines.some((l) => l.k === "entry")) y += SHEET.entryTop;

    section.lines.forEach((line, i) => {
      const last = i === section.lines.length - 1;
      if (line.k === "prose") {
        y += wrapLines(line.text, SHEET.contentW) * SHEET.bodyLine;
      } else if (line.k === "skills") {
        const rows = Math.ceil(line.items.length / SHEET.skillCols);
        y += rows * SHEET.bodyLine + Math.max(0, rows - 1) * SHEET.skillRowGap;
      } else {
        const left = (line.when ? 1 : 0) + (line.loc ? 1 : 0);
        const right =
          (line.title ? 1 : 0) +
          (line.org ? 1 : 0) +
          line.body.reduce((n, t) => n + wrapLines(t, SHEET.colRight), 0);
        y += Math.max(left, right) * SHEET.bodyLine;
        if (!last) y += SHEET.entryGap;
      }
    });
  }

  return { pages: Math.max(1, Math.ceil(y / SHEET.contentH)), usedPx: Math.round(y) };
}

export function estimateCvPages(c: any, p: any): number {
  return estimateCvDoc(buildCvDoc(c, p)).pages;
}

/* ----------------------------- the document ------------------------------ */

export type CvDocOptions = { frame?: boolean; accent?: string };

export function renderCvHtml(c: any, p: any, opts: CvDocOptions = {}): string {
  const accent = CV_ACCENTS[String(opts.accent)] ?? CV_ACCENTS[DEFAULT_ACCENT];
  const doc = buildCvDoc(c, p);

  const linesHtml = (body: CvLine[]): string =>
    body
      .map((line) => {
        if (line.k === "prose") return `<p>${esc(line.text)}</p>`;
        if (line.k === "skills")
          return `<div class="skills">${line.items.map((x) => `<span>${esc(x)}</span>`).join("")}</div>`;
        const left = `${line.when ? `<div>${esc(line.when)}</div>` : ""}${line.loc ? `<div>${esc(line.loc)}</div>` : ""}`;
        const right =
          (line.title ? `<div class="t">${esc(line.title)}</div>` : "") +
          (line.org ? `<div class="org">${esc(line.org)}</div>` : "") +
          line.body.map((t) => `<p>${esc(t)}</p>`).join("");
        return `<div class="entry"><div class="when">${left}</div><div class="what">${right}</div></div>`;
      })
      .join("");

  const sections = doc.sections
    .map((s) => `<section><h2>${esc(s.head)}</h2>${linesHtml(s.lines)}</section>`)
    .join("");

  const contactHtml = doc.contact.length
    ? `<div class="contact">${doc.contact
        .map((x) =>
          x.url
            ? `<a href="${esc(x.url)}">${ICONS[x.icon]()}<span>${esc(x.label)}</span></a>`
            : `<span>${ICONS[x.icon]()}<span>${esc(x.label)}</span></span>`,
        )
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
  --rule: ${esc(accent)};
  --ink: #000;
  --mark: ${esc(accent)};
  --side: ${PAPER_SIDE_MM}mm;
  --myn: ${PAPER_TOP_MM}mm;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
/* vertical paper margin comes from the page box, so page 2 of a long CV is
   inset exactly like page 1; the sheet then only supplies the side margins. */
@page { size: A4; margin: var(--myn) 0; }

.page {
  width: 210mm; min-height: 297mm; margin: 0 auto; background: #fff;
  padding: var(--myn) var(--side) 0;
  font: 400 ${SHEET.bodySize}px/${SHEET.bodyLine}px var(--serif);
  color: var(--ink); -webkit-font-kerning: normal;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
  /* the sheet is a document, not a web page: it must not inherit the app's
     text rendering or smoothing, or the print stops matching the preview */
  text-rendering: geometricPrecision;
}

/* ── header ────────────────────────────────────────────────────────────── */
.hdr { padding-bottom: ${SHEET.headerBottom}px; }
.name { font: 700 ${SHEET.nameSize}px/${SHEET.nameLine} var(--serif); text-align: center; margin: 0; letter-spacing: 0; }
.contact {
  display: flex; flex-wrap: wrap; justify-content: center; align-items: center;
  gap: 6px 14px; margin-top: ${SHEET.contactGap}px; font-size: ${SHEET.contactSize}px; line-height: ${SHEET.contactLine}px;
}
.contact > a, .contact > span { display: inline-flex; align-items: center; gap: 8px; color: inherit; text-decoration: none; }
.ico {
  width: 14px; height: 14px; flex: 0 0 14px; fill: none;
  stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round;
}

/* ── sections ──────────────────────────────────────────────────────────── */
section { margin-top: ${SHEET.sectionTop}px; }
h2 {
  font: 700 ${SHEET.headSize}px/${SHEET.headLine}px var(--serif); color: var(--rule);
  margin: 0 0 ${SHEET.headGap}px; padding-bottom: ${SHEET.headPad}px; border-bottom: ${SHEET.rule}px solid var(--rule);
}
p { margin: 0; }

/* ── dated entries: when/location left, title/org/prose right ──────────── */
.entry { display: grid; grid-template-columns: ${SHEET.colLeft}px 1fr; margin-bottom: ${SHEET.entryGap}px; }
.entry:last-child { margin-bottom: 0; }
/* The reference starts an entry's first line 31px below its heading but prose
   lines at 30px — one pixel of its own box model, kept so every later section
   lands on the measured baseline instead of drifting. Padding, not margin:
   a margin here would collapse into the heading's own margin-bottom. */
h2 + .entry { padding-top: ${SHEET.entryTop}px; }
.when { font-size: ${SHEET.bodySize}px; line-height: ${SHEET.bodyLine}px; }
.what .t { font-weight: 700; }
.what .org { font-style: italic; }

/* ── skills: three equal columns with a square marker, as measured ─────── */
.skills { display: grid; grid-template-columns: repeat(${SHEET.skillCols}, 1fr);
  column-gap: ${SHEET.skillColGap}px; row-gap: ${SHEET.skillRowGap}px; padding-left: ${SHEET.skillInset}px; }
.skills > span { display: flex; align-items: center; gap: 6px; font-size: ${SHEET.bodySize}px;
  line-height: ${SHEET.bodyLine}px; break-inside: avoid; }
.skills > span::before { content: ""; width: 4px; height: 4px; flex: 0 0 4px; background: var(--mark); }

/* On screen the sheet carries the 297mm floor and the top margin itself, so the
   preview shows a real page. On paper the page box supplies the vertical margin
   — which is what gives page 2 of a long CV the same inset as page 1. */
@media print { .page { min-height: 0; margin: 0; padding-top: 0; } }
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
</div>
</body>
</html>`;
}
