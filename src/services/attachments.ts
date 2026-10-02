/**
 * Email attachments for pitches and applications (§19.1): a file picked in the
 * preview, or a CV from CV Studio rendered to a self-contained HTML document.
 *
 * Stored base64 in TEXT so sqlite and Postgres share one code path; the row id is
 * unguessable, which is what lets the download link below be public — the recipient
 * of a pitch has no JAMS account and must still be able to open the CV.
 */
import { all, get, run, parseJson } from "../core/db";
import { notFound, validation } from "../core/errors";
import { newId, nowIso } from "../util/id";
import { config } from "../core/config";
import { reconcileIdentity } from "./profile.service";

/** Where a link inside an email should point: reachable by the recipient, not just us. */
export const publicBase = (): string =>
  process.env.PUBLIC_API_BASE ||
  process.env.API_BASE_URL ||
  (process.env.VERCEL ? "https://backend-v0-3aeu-omega.vercel.app" : `http://localhost:${config.port}`);

export const attachmentUrl = (id: string): string => `${publicBase()}/api/v1/pitch-targets/attachments/${id}/download`;

const MAX_BYTES = 4 * 1024 * 1024; // base64 payload stays inside the 8mb json limit

export interface SavedAttachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  url: string;
}

export async function saveAttachment(userId: string, input: { filename: string; content_type: string; content_b64: string }): Promise<SavedAttachment> {
  const b64 = input.content_b64.replace(/^data:[^,]+,/, "").replace(/\s+/g, "");
  const size = Math.floor((b64.length * 3) / 4);
  if (!b64) throw validation("Empty file");
  if (size > MAX_BYTES) throw validation(`File is too large (limit ${Math.round(MAX_BYTES / 1024 / 1024)}MB)`);
  const id = newId();
  const filename = input.filename.slice(0, 200);
  const contentType = (input.content_type || "application/octet-stream").slice(0, 120);
  await run(
    `INSERT INTO pitch_attachments (id, user_id, filename, content_type, size_bytes, content_b64, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id, userId, filename, contentType, size, b64, nowIso()
  );
  return { id, filename, content_type: contentType, size_bytes: size, url: attachmentUrl(id) };
}

/** Read one attachment (the public download only needs the unguessable id). */
export async function getAttachment(id: string) {
  const row = await get<any>(`SELECT * FROM pitch_attachments WHERE id = ?`, id);
  if (!row) throw notFound("Attachment");
  return row;
}

/* ------------------------------ CV rendering ------------------------------ */

const esc = (s: string): string =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));

const profileOf = (userId: string) => get<any>(`SELECT id FROM profiles WHERE user_id = ?`, userId);

const childrenOf = async (userId: string, table: "profile_experiences" | "profile_education" | "profile_skills") => {
  const p = await profileOf(userId);
  if (!p) return [];
  const order = table === "profile_skills" ? "sort_order" : "sort_order";
  return all<any>(`SELECT * FROM ${table} WHERE profile_id = ? ORDER BY ${order}`, p.id);
};

/**
 * CV Studio document → a single-file HTML page the recipient can read and print
 * to PDF straight from the browser. No external assets, so it renders inside webmail.
 */
export async function saveCvAttachment(userId: string, cvId: string): Promise<SavedAttachment> {
  const cv = await get<any>(`SELECT * FROM cvs WHERE id = ? AND user_id = ?`, cvId, userId);
  if (!cv) throw notFound("CV");
  const profile = await get<any>(`SELECT * FROM profiles WHERE user_id = ?`, userId);
  const identity = reconcileIdentity(profile ? parseJson<any>(profile.identity, {}) : {});
  const blocks = parseJson<any[]>(cv.blocks, []);
  const name = identity.name || cv.name;

  const section = (title: string, inner: string) => (inner.trim() ? `<section><h2>${esc(title)}</h2>${inner}</section>` : "");
  const parts: string[] = [];

  for (const b of blocks) {
    if (b.type === "summary") {
      parts.push(section("Profile", `<p>${esc(b.text ?? "")}</p>`));
    } else if (b.type === "experience") {
      const exps = await childrenOf(userId, "profile_experiences");
      const inner = exps
        .map((e: any) => {
          const dates = e.start_date ? `<span class="meta">${esc(e.start_date)}${e.end_date ? ` – ${esc(e.end_date)}` : ""}</span>` : "";
          const bullets = e.bullets ? `<ul>${parseJson<string[]>(e.bullets, []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
          return `<div class="item"><strong>${esc(e.title ?? "")}</strong>${e.company ? `, ${esc(e.company)}` : ""}${dates}${bullets}</div>`;
        })
        .join("");
      parts.push(section("Experience", inner));
    } else if (b.type === "skills") {
      const skills = await childrenOf(userId, "profile_skills");
      parts.push(section("Skills", `<p>${skills.map((s: any) => esc(s.name)).join(" · ")}</p>`));
    } else if (b.type === "education") {
      const edu = await childrenOf(userId, "profile_education");
      const inner = edu
        .map((e: any) => `<div class="item"><strong>${esc(e.school ?? "")}</strong>${e.degree ? `, ${esc(e.degree)}` : ""}${e.end_date ? `<span class="meta">${esc(e.end_date)}</span>` : ""}</div>`)
        .join("");
      parts.push(section("Education", inner));
    } else if (b.text || b.title) {
      const inner = b.bullets
        ? `<ul>${(b.bullets as string[]).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
        : `<p>${esc(b.text ?? "")}</p>`;
      parts.push(section(b.title ?? "Notes", inner));
    }
  }

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(name)}: CV</title>
<style>
  body{font-family:Georgia,'Times New Roman',serif;color:#14181f;max-width:760px;margin:40px auto;padding:0 24px;line-height:1.55}
  h1{font-size:26px;margin:0 0 4px}h2{font-size:14px;letter-spacing:.12em;text-transform:uppercase;color:#5b6472;margin:26px 0 8px;border-bottom:1px solid #e3e7ee;padding-bottom:4px}
  .meta{color:#5b6472;font-weight:400;margin-left:8px;font-size:14px}.item{margin-bottom:12px}ul{margin:6px 0 0 18px;padding:0}li{margin-bottom:4px}
  .head{border-bottom:2px solid #14181f;padding-bottom:12px}.contact{color:#5b6472;font-size:14px}
</style></head><body>
<div class="head"><h1>${esc(name)}</h1><div class="contact">${esc(identity.headline ?? "")}${identity.email ? ` · ${esc(identity.email)}` : ""}</div></div>
${parts.join("\n")}
</body></html>`;

  return saveAttachment(userId, {
    filename: `${(cv.name || "CV").replace(/[^a-z0-9]+/gi, "-")}.html`,
    content_type: "text/html; charset=utf-8",
    content_b64: Buffer.from(html, "utf8").toString("base64"),
  });
}
