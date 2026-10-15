/**
 * The CV document — the printable sheet, and the only thing the preview shows.
 *
 * The geometry here is not invented. It was measured off a real FlowCV export
 * (`IRAOYA_ISRAEL_OMOKHAGBO_FlowCV_Resume_2026-09-30.pdf`, itself a Chrome print
 * of FlowCV's HTML — same pipeline this app uses, so the two can be compared
 * number for number). The export is a tagged Skia/PDF at 1 unit = 1 CSS px on a
 * 794 × 1126 px sheet, and every value below is one of its measured positions:
 *
 *   sheet            794 × 1126 px (210 × 297mm), white, side margin 20mm
 *   name             Amiri Bold 32.66px, centred, baseline 84
 *   contact row      Amiri Regular 14px, centred, baseline 119, 14px icons at x 171/345/486
 *   section heading  Amiri Bold 15.33px, baseline H, then a 2px black rule at H + 7
 *   first body line  baseline H + 30, then 18px lines (14px Amiri)
 *   next section     previous section's last baseline + 38
 *   entry columns    left starts at the 20mm margin, right at x = 223.36 (offset 147.8)
 *   entries          line 1 = date | title(bold), line 2 = location | org(italic), then prose
 *   entry gap        12px (so the next entry's first baseline lands +30)
 *   skills           3 equal columns, 32px column gap, 9.5px row gap, 4px square markers
 *
 * Two deliberate consequences of copying it exactly: the document is monochrome
 * (the reference has no accent colour anywhere — every run is rgb(0,0,0)), and
 * experience descriptions are plain prose lines rather than bulleted items,
 * which is what the reference actually contains.
 *
 * One geometry serves both screen and paper: `@page` supplies the vertical paper
 * margin so that *every* page of a two-page CV is inset, and the sheet supplies
 * the side margins, so the preview cannot drift from the printed page.
 */
import type { Request, Response } from "express";

export const CV_ACCENTS: Record<string, string> = {
  /** the reference document: pure paper black */
  ink: "#000000",
  /** the app's brand hue, one step down — #ff9933 only clears 2:1 as text on paper */
  ember: "#b35f00",
  graphite: "#5b564f",
};

const DEFAULT_ACCENT = "ink";

/* ------------------------------- icons ---------------------------------- */

const I = (
  d: string,
  cls = "ico",
): string =>
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

const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[m]!);

/** strip the scheme so a link reads as `github.com/izzychils` on the page */
const bare = (v: unknown): string => String(v ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");

const href = (v: unknown): string => {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  return /@/.test(s) && !/^https?:/i.test(s) ? `mailto:${s}` : `https://${s}`;
};

/** one paragraph per non-empty line — the reference's prose unit */
const lines = (t: unknown): string[] =>
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
function range(start: unknown, end: unknown): string {
  const a = String(start ?? "").trim();
  const b = String(end ?? "").trim();
  if (!a && !b) return "";
  if (!a) return b;
  return `${a} \u2013 ${b || "Present"}`;
}

/* ---------------------------- the document ------------------------------ */

export type CvDocOptions = { frame?: boolean; accent?: string };

export function renderCvHtml(c: any, p: any, opts: CvDocOptions = {}): string {
  const accent = CV_ACCENTS[String(opts.accent)] ?? CV_ACCENTS[DEFAULT_ACCENT];
  const id: any = p?.identity ?? {};
  const links: any = id.links ?? {};

  const name = String(id.name ?? "").trim() || String(c?.name ?? "");
  const contact: { icon: string; label: string; url: string }[] = [
    id.email ? { icon: "mail", label: String(id.email), url: href(id.email) } : null,
    id.phone ? { icon: "phone", label: String(id.phone), url: href(id.phone) } : null,
    links.linkedin ? { icon: "linkedin", label: bare(links.linkedin), url: href(links.linkedin) } : null,
    links.github ? { icon: "github", label: bare(links.github), url: href(links.github) } : null,
    links.website ? { icon: "globe", label: bare(links.website), url: href(links.website) } : null,
    id.location ? { icon: "pin", label: String(id.location), url: "" } : null,
  ].filter(Boolean) as any;

  const HEADS: Record<string, string> = {
    summary: "Profile",
    experience: "Professional Experience",
    skills: "Skills",
    education: "Education",
    projects: "Projects",
    awards: "Awards",
    custom: "Section",
  };

  const profExps: any[] = p?.experiences ?? [];
  const profEdu: any[] = p?.education ?? [];
  const profSkills: any[] = p?.skills ?? [];

  /** dates + location on the left, everything else on the right */
  const entry = (when: string, loc: string, what: string): string =>
    `<div class="entry"><div class="when">${when ? `<div>${esc(when)}</div>` : ""}${
      loc ? `<div>${esc(loc)}</div>` : ""
    }</div><div class="what">${what}</div></div>`;

  const prose = (arr: string[]): string => arr.map((x) => `<p>${esc(x)}</p>`).join("");

  const sections = (c?.blocks ?? [])
    .map((b: any) => {
      const head = esc(b.title || HEADS[b.type] || "Section");
      const wrap = (inner: string) => (inner ? `<section><h2>${head}</h2>${inner}</section>` : "");

      if (b.type === "summary" || b.type === "custom") return wrap(prose(paras(b.text)));

      if (b.type === "skills") {
        // `groups` is the local override, otherwise the profile's skill list
        const fromGroups = (b.groups ?? []).flatMap((g: string) =>
          lines(g).flatMap((l) => l.split(",")),
        );
        const items = (fromGroups.length ? fromGroups : profSkills.map((s: any) => s.name))
          .map((x: any) => String(x ?? "").trim())
          .filter(Boolean);
        return wrap(items.length ? `<div class="skills">${items.map((x: string) => `<span>${esc(x)}</span>`).join("")}</div>` : "");
      }

      if (b.type === "experience") {
        const fromProfile = (b.source === "profile" ? profExps : [])
          .map((e: any) =>
            entry(
              range(e.start_date, e.end_date),
              e.location,
              `<div class="t">${e.title ? esc(e.title) : ""}</div>` +
                (e.company ? `<div class="org">${esc(e.company)}</div>` : "") +
                prose(Array.isArray(e.bullets) ? e.bullets : []),
            ),
          )
          .join("");
        // a hand-written entry: no dates to show, so the whole block is prose
        const local = lines(b.text).length
          ? entry("", "", prose([...(b.bullets ?? []), ...lines(b.text)]))
          : "";
        return wrap(fromProfile + local);
      }

      if (b.type === "education") {
        const fromProfile = (b.source === "profile" ? profEdu : [])
          .map((e: any) => {
            const qual = [e.degree, e.field]
              .map((x: any) => String(x ?? "").trim())
              .filter(Boolean)
              .join(" \u00b7 ");
            return entry(
              range(e.start_date, e.end_date),
              e.location,
              (qual ? `<div class="t">${esc(qual)}</div>` : "") +
                (e.school ? `<div class="org">${esc(e.school)}</div>` : ""),
            );
          })
          .join("");
        const local = lines(b.text).length
          ? entry("", "", `${b.title ? `<div class="t">${esc(b.title)}</div>` : ""}${prose(lines(b.text))}`)
          : "";
        return wrap(fromProfile + local);
      }

      if (b.type === "projects" || b.type === "awards") {
        const items = lines(b.text).length ? lines(b.text) : (b.bullets ?? []);
        return wrap(items.length ? entry("", "", prose(items)) : "");
      }

      return "";
    })
    .join("");

  const contactHtml = contact.length
    ? `<div class="contact">${contact
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
<title>${esc(name)} \u2014 CV</title>
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

:root {
  --serif: Amiri, "Iowan Old Style", Palatino, "Palatino Linotype", "Book Antiqua", Georgia, "Times New Roman", serif;
  --rule: ${esc(accent)};
  --ink: #000;
  --mark: ${esc(accent)};
  --side: 20mm;   /* measured: the text column starts at 75.59px == 20mm */
  --myn: 15mm;    /* measured: the name box top sits 56.69px below the top edge */
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; }
/* vertical paper margin comes from the page box, so page 2 of a long CV is
   inset exactly like page 1; the sheet then only supplies the side margins. */
@page { size: A4; margin: var(--myn) 0; }

.page {
  width: 210mm; min-height: 297mm; margin: 0 auto; background: #fff;
  padding: var(--myn) var(--side) 0;
  font: 400 14px/18px var(--serif);
  color: var(--ink); -webkit-font-kerning: normal;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}

/* ── header ────────────────────────────────────────────────────────────── */
.hdr { padding-bottom: 7.2px; }
.name { font: 700 32.66px/1.2 var(--serif); text-align: center; margin: 0; letter-spacing: 0; }
.contact {
  display: flex; flex-wrap: wrap; justify-content: center; align-items: center;
  gap: 6px 14px; margin-top: 12.7px; font-size: 14px; line-height: 14px;
}
.contact > a, .contact > span { display: inline-flex; align-items: center; gap: 8px; color: inherit; text-decoration: none; }
.ico {
  width: 14px; height: 14px; flex: 0 0 14px; fill: none;
  stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round;
}

/* ── sections ──────────────────────────────────────────────────────────── */
section { margin-top: 19px; }
h2 {
  font: 700 15.33px/19px var(--serif); color: var(--rule);
  margin: 0 0 9px; padding-bottom: 1px; border-bottom: 2px solid var(--rule);
}
p { margin: 0; }

/* ── dated entries: when/location left, title/org/prose right ──────────── */
.entry { display: grid; grid-template-columns: 147.8px 1fr; margin-bottom: 12px; }
.entry:last-child { margin-bottom: 0; }
/* The reference starts an entry's first line 31px below its heading but prose
   lines at 30px — one pixel of its own box model, kept so every later section
   lands on the measured baseline instead of drifting. Padding, not margin:
   a margin here would collapse into the heading's own margin-bottom. */
h2 + .entry { padding-top: 1px; }
.when { font-size: 14px; line-height: 18px; }
.what .t { font-weight: 700; }
.what .org { font-style: italic; }
.ext-link { color: inherit; text-decoration: none; white-space: nowrap; }
.ext {
  width: 10px; height: 10px; margin-left: 4px; fill: none;
  stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round;
  vertical-align: -1px;
}

/* ── skills: three equal columns with a square marker, as measured ─────── */
/* measured: the skill text sits 12.6px from the text column, i.e. the grid is
   inset 2.4px so the 4px square starts at x = 78 and the label at x = 88.2 */
.skills { display: grid; grid-template-columns: repeat(3, 1fr); column-gap: 32px; row-gap: 9.5px; padding-left: 2.4px; }
.skills > span { display: flex; align-items: center; gap: 6px; font-size: 14px; line-height: 18px; break-inside: avoid; }
.skills > span::before { content: ""; width: 4px; height: 4px; flex: 0 0 4px; background: var(--mark); }

/* On screen the sheet carries the 297mm floor and the top margin itself, so the
   preview shows a real page. On paper the page box supplies the vertical margin
   — which is what gives page 2 of a long CV the same inset as page 1. */
@media print { .page { min-height: 0; margin: 0; padding-top: 0; } }
</style>
</head>
<body>
<div class="page">
<header class="hdr">
  <h1 class="name">${esc(name)}</h1>
  ${contactHtml}
</header>
${sections}
</div>
</body>
</html>`;
}

/** small helper the route uses to keep its handler to one line */
export function sendCvHtml(res: Response, _req: Request, c: any, p: any, opts: CvDocOptions): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(renderCvHtml(c, p, opts));
}
