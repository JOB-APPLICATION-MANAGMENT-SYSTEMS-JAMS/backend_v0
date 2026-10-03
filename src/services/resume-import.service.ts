import { AppError } from "../core/errors";

/**
 * Resume import (§35 autofill): turn an uploaded CV into profile answers so a
 * first-time user doesn't have to retype what their resume already says.
 * PDF text comes from unpdf (serverless-safe); txt/md/rtf are read directly.
 * Heuristics stay conservative — extract only what a resume states plainly;
 * the /autofill page shows everything for review before the human saves.
 */

export interface ResumeParse {
  text: string;
  identity: Record<string, any>;
  warnings: string[];
}

const SUPPORTED = [".pdf", ".txt", ".md", ".rtf"];
const MAX_BYTES = 4 * 1024 * 1024;

export async function parseResume(buf: Buffer, filename: string): Promise<ResumeParse> {
  const lower = filename.toLowerCase();
  if (!SUPPORTED.some((ext) => lower.endsWith(ext))) {
    throw new AppError("UNSUPPORTED_FILE", 415, "That file type isn’t supported yet — export your resume as PDF or .txt and try again.", null);
  }
  if (!buf.length) throw new AppError("EMPTY_UPLOAD", 400, "That file came through empty — try again.", null);
  if (buf.length > MAX_BYTES) throw new AppError("FILE_TOO_LARGE", 413, "That resume is over 4 MB — export a smaller PDF and try again.", null);

  let text = "";
  if (lower.endsWith(".pdf")) {
    try {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const doc = await getDocumentProxy(new Uint8Array(buf));
      const out = await extractText(doc, { mergePages: true });
      text = out.text ?? "";
    } catch {
      throw new AppError("UNREADABLE_PDF", 422, "Couldn’t read that PDF — it may be a scan (image-only). Copy the text into a .txt file instead.", null);
    }
  } else {
    text = buf.toString("utf8");
  }

  text = text.replace(/\u0000/g, "").trim();
  if (!text) throw new AppError("EMPTY_RESUME", 422, "Couldn’t find any text in that file — if it’s a scan, paste the text into a .txt file.", null);

  const { identity, warnings } = extractIdentity(text);
  if (Object.keys(identity).length === 0) warnings.push("No contact details spotted — add them manually below.");
  return { text: text.slice(0, 4000), identity, warnings };
}

/** Heuristics: email, phone, links, name, location, headline, education. */
export function extractIdentity(raw: string): { identity: Record<string, any>; warnings: string[] } {
  const text = raw.replace(/\r/g, "");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const id: Record<string, any> = {};
  const links: Record<string, string> = {};
  const warnings: string[] = [];

  const email = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  if (email) id.email = email[0];

  const phone = text.match(/(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/);
  if (phone) id.phone = phone[0].trim();

  const li = text.match(/linkedin\.com\/[A-Za-z0-9._/-]+/i);
  if (li) links.linkedin = `https://${li[0].replace(/[.,;·]+$/, "")}`;
  const gh = text.match(/github\.com\/[A-Za-z0-9._/-]+/i);
  if (gh) links.github = `https://${gh[0].replace(/[.,;·]+$/, "")}`;

  // name: first short line of 2–4 plain words; skip obvious headlines/titles
  const TITLE_WORDS = /engineer|developer|designer|student|intern|manager|analyst|architect|specialist|consultant|lead|director|scientist|technician|nurse|teacher|candidate|resume|curriculum/i;
  const nameLine = lines.find(
    (l) =>
      l.length >= 5 &&
      l.length <= 60 &&
      !/[@\d|•·]/.test(l) &&
      /^[A-Za-z'’. -]+$/.test(l) &&
      /^[A-Z]/.test(l) &&
      !TITLE_WORDS.test(l) &&
      l.split(/\s+/).length >= 2 &&
      l.split(/\s+/).length <= 4
  );
  if (nameLine) {
    const parts = nameLine.replace(/\.$/, "").split(/\s+/);
    id.first_name = parts[0];
    id.last_name = parts[parts.length - 1];
    if (parts.length > 2) id.middle_name = parts.slice(1, -1).join(" ");
    id.name = parts.join(" ");
  } else {
    warnings.push("Couldn’t spot a name — add it manually below.");
  }

  // location: prefer "City, ST" on the contact line that carries the email
  const citySt = /\b([A-Z][a-zA-Z.' -]{2,29},\s[A-Z]{2})\b/;
  const contactLine = email ? lines.find((l) => l.includes(email[0])) : undefined;
  const loc = (contactLine && citySt.exec(contactLine)?.[1]) || text.match(citySt)?.[1];
  if (loc) id.location = loc.trim();

  // headline: first title-ish line that isn't the name
  const headline = lines.find((l) => l.length <= 70 && TITLE_WORDS.test(l) && l !== nameLine && !/@/.test(l));
  if (headline) id.headline = headline.replace(/^[-•\s]+/, "");

  // education: school, degree, field, graduation year
  const schoolLine = lines.find((l) => /(university|college|institute|polytechnic|school of)/i.test(l) && l.length <= 100);
  if (schoolLine) {
    const school = schoolLine
      .replace(/^[-•\d\s]+/, "")
      .split(/[,·|]/)[0]
      .trim();
    if (school.length >= 3) id.school = school;
  }
  const degLine = lines.find((l) => /(bachelor|master|ph\.?\s?d|b\.?s\.?c?|m\.?s\.?c?|b\.?a\.?|m\.?a\.?|b\.?tech|m\.?tech)/i.test(l));
  if (degLine) {
    const deg = degLine.match(/\b(ph\.?\s?d|bachelor(?:\s+of\s+[A-Za-z]+)?|master(?:\s+of\s+[A-Za-z]+)?|b\.?s\.?c?|m\.?s\.?c?|b\.?a\.?|m\.?a\.?|b\.?tech|m\.?tech)\b/i);
    if (deg) id.degree = deg[0].replace(/\s+/g, " ").trim();
    const field = degLine.match(/\bin\s+([A-Z][A-Za-z ]{3,40})/);
    if (field) id.field_of_study = field[1].split(/\s*\((gpa|minor)/i)[0].replace(/,.*$/, "").trim();
  }
  const grad = text.match(/(?:graduat\w*|class of|expected|degree)\D{0,20}(20\d{2})/i);
  const eduLine = degLine ?? schoolLine;
  if (grad) id.graduation_year = grad[1];
  else if (eduLine) {
    const years = [...eduLine.matchAll(/20\d{2}/g)].map((m) => m[0]);
    if (years.length) id.graduation_year = years[years.length - 1];
  }

  if (Object.keys(links).length) id.links = links;
  return { identity: id, warnings };
}
