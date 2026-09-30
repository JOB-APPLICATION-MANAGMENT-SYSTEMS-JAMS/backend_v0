import { all, get, run, parseJson } from "../core/db";
import { AppError, notFound } from "../core/errors";
import { newId, nowIso } from "../util/id";
import { extractKeywords } from "./scoring.service";
import { profileSignals } from "./profile-signals";
import { scorePosting } from "./scoring.service";

export interface CaptureInput {
  source: "extension" | "paste" | "agent" | "manual";
  url: string;
  page?: {
    title?: string;
    company_guess?: string;
    text_excerpt?: string;
    salary_text?: string;
    posted_text?: string;
    form_fields?: { name?: string; label?: string; type?: string }[];
  };
  html_text?: string;
  action?: "log_only" | "create_draft" | "mark_submitted";
  posting_id?: string;
  /** pitch = CV to a company with no open role; application = replying to a posting. */
  kind?: "application" | "pitch";
  /** recipient lifted from the page (or typed) so auto-apply can actually send. */
  contact_email?: string;
}

export interface ParsedPosting {
  title: string;
  company: string;
  location: string | null;
  remote: boolean;
  salary_min: number | null;
  salary_max: number | null;
  currency: string | null;
  description: string;
  keywords: string[];
  posted_at: string | null;
  warnings: string[];
}

const UA = "JAMS-Capture/0.1 (+personal job tracker; respects robots.txt)";

/** robots.txt check before a server-side fetch (§38.4, sanctioned fetching only). */
async function robotsAllows(url: string): Promise<boolean> {
  try {
    const u = new URL(url);
    const robotsUrl = `${u.origin}/robots.txt`;
    const res = await fetch(robotsUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(4000) });
    if (!res.ok) return true;
    const text = await res.text();
    const disallows = text
      .split(/\r?\n/)
      .filter((l) => l.toLowerCase().startsWith("disallow:"))
      .map((l) => l.split(":")[1]?.trim() ?? "");
    const path = u.pathname;
    return !disallows.some((d) => d && d !== "/" && path.startsWith(d)) && !(disallows.includes("/") && path === "/");
  } catch {
    return true;
  }
}

/** Extract a JobPosting from JSON-LD if the page provides it (best signal, free). */
function fromJsonLd(html: string): any | null {
  const scripts = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const s of scripts) {
    try {
      const data = JSON.parse(s[1]);
      const nodes = Array.isArray(data) ? data : data["@graph"] ? data["@graph"] : [data];
      for (const n of nodes) {
        if (n && (n["@type"] === "JobPosting" || n["@type"]?.includes?.("JobPosting"))) return n;
      }
    } catch {
      /* ignore malformed json-ld */
    }
  }
  return null;
}

const stripTags = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

function parseSalary(text: string): { min: number | null; max: number | null; currency: string | null } {
  const currency = /\$|usd/i.test(text) ? "USD" : /€|eur/i.test(text) ? "EUR" : /£|gbp/i.test(text) ? "GBP" : null;
  const nums = [...text.matchAll(/(\d{2,3}(?:,\d{3})+|\d{2,3})(?:\s*[kK])?/g)]
    .map((m) => {
      const raw = m[1].replace(/,/g, "");
      let v = Number(raw);
      if (/k/i.test(m[0])) v *= 1000;
      else if (v < 1000) v *= 1000; // "90k" style without k is rare; treat 2-3 digit as k only when followed by k
      return v;
    })
    .filter((v) => v >= 15000 && v <= 1000000);
  if (!nums.length) return { min: null, max: null, currency };
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return { min, max: max === min ? null : max, currency };
}

function guessCompany(title: string, url: string, html?: string): string {
  const og = html?.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1];
  if (og) return og;
  const m = title.match(/(?:^|[–|:]\s*)\w[^–|:]*?\bat\s+([A-Z][\w&.' -]{2,40})$/) ?? title.match(/[–|]\s*([A-Z][\w&.' -]{2,40})\s*$/);
  if (m) return m[1].trim();
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host.split(".")[0].replace(/^\w/, (c) => c.toUpperCase());
  } catch {
    return "Unknown company";
  }
}

/** Server-side fetch + parse without saving (paste flow / capture preview). */
export async function previewCapture(userId: string, url: string, htmlText?: string): Promise<{ parsed: ParsedPosting; warnings: string[]; emails: string[] }> {
  let html = htmlText ?? "";
  const warnings: string[] = [];
  if (!html) {
    if (!(await robotsAllows(url))) throw new AppError("FORBIDDEN", 403, "robots.txt disallows fetching this URL", "paste the posting text instead");
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(8000), redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (e: any) {
      throw new AppError("SOURCE_DOWN", 502, "Could not fetch that URL", String(e.message ?? e));
    }
  }

  const ld = fromJsonLd(html);
  const text = stripTags(html);
  const pageTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];

  let title = ld?.title ?? ogTitle ?? pageTitle ?? url;
  title = title.split(/\s+[|–-]\s+/)[0].trim();
  let company = ld?.hiringOrganization?.name ?? guessCompany(title, url, html);
  const location = ld?.jobLocation?.address?.addressLocality ?? ld?.jobLocation?.address?.addressRegion ?? null;
  const remote = !!ld?.jobLocationType || /remote|anywhere|work from home/i.test(`${text.slice(0, 2000)}`);
  const salaryRaw = ld?.baseSalary?.value?.minValue ? String(ld.baseSalary.value.minValue) : text.match(/(salary|compensation|pay)[:\s]*([€$£]?[\d,.]+\s*[kK]?\s*[-–to]+\s*[€$£]?[\d,.]+\s*[kK]?)/i)?.[2] ?? "";
  const salary = salaryRaw ? parseSalary(salaryRaw) : parseSalary(text.slice(0, 4000));
  if (!salary.min) warnings.push("salary not found, add manually");
  const description = (ld?.description ? stripTags(ld.description) : text).slice(0, 8000);
  const keywords = extractKeywords(`${title} ${description}`);
  // emails are the pitch/apply currency: pull every plausible address from the source page
  const emails = [
    ...new Set(
      (`${html}\n${text}`).toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? []
    ),
  ]
    .filter((e) => !/\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ico)$/.test(e) && !e.includes("sentry") && !e.includes("example.") && !e.includes("noreply") && !e.includes("no-reply"))
    .slice(0, 5);
  let posted_at: string | null = ld?.datePosted ?? null;
  if (!posted_at) {
    const m = text.match(/posted(?:\s+on)?[:\s]+(\w+\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+\w+\s+\d{4})/i);
    if (m) {
      const d = new Date(m[1]);
      if (!isNaN(d.getTime())) posted_at = d.toISOString();
    }
  }

  return {
    parsed: {
      title,
      company,
      location,
      remote,
      salary_min: salary.min,
      salary_max: salary.max,
      currency: salary.currency,
      description,
      keywords,
      posted_at,
      warnings,
    },
    warnings,
    emails,
  };
}

async function upsertPosting(userId: string, url: string, parsed: ParsedPosting, source: string) {
  const signals = await profileSignals(userId);
  const externalId = Buffer.from(url).toString("base64url").slice(0, 40);
  const existing = await get("SELECT id FROM job_postings WHERE user_id = ? AND source = ? AND external_id = ?", userId, source, externalId);
  const id = existing?.id ?? newId();
  const scored = scorePosting(signals, {
    title: parsed.title,
    description: parsed.description,
    companyName: parsed.company,
    seniority: null,
    remote: parsed.remote,
    location: parsed.location,
    salaryMin: parsed.salary_min,
    salaryMax: parsed.salary_max,
    postedAt: parsed.posted_at,
  });
  const dedupeKey = `${parsed.title.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim()}|${parsed.company.toLowerCase()}|${(parsed.location ?? "").toLowerCase()}`;
  const now = nowIso();
  if (existing) {
    await run(
      "UPDATE job_postings SET title = ?, company_name = ?, description = ?, jd_keywords = ?, salary_min = ?, salary_max = ?, score = ?, explain = ?, last_seen_at = ? WHERE id = ?",
      parsed.title,
      parsed.company,
      parsed.description,
      JSON.stringify(parsed.keywords),
      parsed.salary_min,
      parsed.salary_max,
      scored.score,
      JSON.stringify(scored.explain),
      now,
      id
    );
  } else {
    await run(
      `INSERT INTO job_postings (id, user_id, company_name, source, external_id, title, location, remote, salary_min, salary_max, currency, career_category, description, jd_keywords, url, posted_at, first_seen_at, last_seen_at, score, explain, dedupe_key, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'software_engineering', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      id,
      userId,
      parsed.company,
      source,
      externalId,
      parsed.title,
      parsed.location,
      parsed.remote ? 1 : 0,
      parsed.salary_min,
      parsed.salary_max,
      parsed.currency,
      parsed.description,
      JSON.stringify(parsed.keywords),
      url,
      parsed.posted_at,
      now,
      now,
      scored.score,
      JSON.stringify(scored.explain),
      dedupeKey,
      now
    );
  }
  return { posting_id: id, score: scored.score, explain: scored.explain };
}

/**
 * POST /capture (§35.3), persists a posting snapshot and (optionally) a draft application.
 * Never marks applied on its own: only the human's `mark_submitted` does (§35 principle).
 */
export async function capture(userId: string, input: CaptureInput) {
  const page = input.page ?? {};
  let parsed: ParsedPosting;
  let warnings: string[] = [];
  if (input.html_text || !page.title) {
    const res = await previewCapture(userId, input.url, input.html_text);
    parsed = res.parsed;
    warnings = res.warnings;
  } else {
    const description = (page.text_excerpt ?? "").slice(0, 8000);
    parsed = {
      title: page.title,
      company: page.company_guess ?? guessCompany(page.title, input.url),
      location: null,
      remote: /remote/i.test(page.title + description),
      salary_min: page.salary_text ? (parseSalary(page.salary_text).min ?? null) : null,
      salary_max: page.salary_text ? (parseSalary(page.salary_text).max ?? null) : null,
      currency: page.salary_text ? parseSalary(page.salary_text).currency : null,
      description,
      keywords: extractKeywords(`${page.title} ${description}`),
      posted_at: null,
      warnings: [],
    };
    if (!parsed.salary_min) warnings.push("salary not found, add manually");
  }

  const upserted = await upsertPosting(userId, input.url, parsed, input.source === "paste" ? "manual" : input.source);
  const action = input.action ?? "create_draft";
  let application_id: string | null = null;

  if (action !== "log_only") {
    const { createApplication, changeStatus } = await import("./application.service");
    let contactId: string | null = null;
    if (input.contact_email?.trim()) {
      const email = input.contact_email.trim().toLowerCase();
      const existingContact = await get("SELECT id FROM contacts WHERE user_id = ? AND lower(email) = ?", userId, email);
      if (existingContact) contactId = existingContact.id;
      else {
        contactId = newId();
        await run(
          `INSERT INTO contacts (id, user_id, company_id, name, email, source_note, never_contact, created_at)
           VALUES (?, ?, NULL, 'Contact', ?, ?, 0, ?)`,
          contactId, userId, email, `captured from ${new URL(input.url).hostname}`, nowIso()
        );
      }
    }
    const app = await createApplication(userId, {
      company_name: parsed.company,
      posting_id: upserted.posting_id,
      contact_id: contactId,
      kind: input.kind ?? "application",
      status: "saved",
      role_title: parsed.title,
      source: input.source,
      url: input.url,
      capture: { ...parsed, captured_via: input.source, captured_at: nowIso(), form_fields: page.form_fields ?? [], contact_email: input.contact_email ?? null },
    }, input.source === "extension" ? "extension" : "user");
    application_id = app.id;
    if (action === "mark_submitted") await changeStatus(userId, app.id, "applied");
  }

  return { application_id, posting_id: upserted.posting_id, parsed: { ...parsed, ...{ warnings: [] } }, warnings, score: upserted.score };
}

/** Companies (CRM lite) for the pitch-target path (§19.1 mode 2). */
export async function listCompanies(userId: string, filter: { tier?: string; q?: string } = {}) {
  const where = ["user_id = ?"];
  const args: any[] = [userId];
  if (filter.tier) {
    where.push("tier = ?");
    args.push(filter.tier);
  }
  if (filter.q) {
    where.push("lower(name) LIKE ?");
    args.push(`%${filter.q.toLowerCase()}%`);
  }
  const rows = await all<any>(
    `SELECT c.*, (SELECT count(*) FROM applications WHERE company_id = c.id) AS applications,
            (SELECT count(*) FROM contacts WHERE company_id = c.id) AS contacts
     FROM companies c WHERE ${where.join(" AND ")} ORDER BY c.name ASC`,
    ...args
  );
  // stack is a TEXT column, parse it like getCompany does or the client receives a string
  return rows.map((r) => ({ ...r, stack: parseJson(r.stack, []) }));
}

export async function getCompany(userId: string, id: string) {
  const c = await get("SELECT * FROM companies WHERE id = ? AND user_id = ?", id, userId);
  if (!c) throw notFound("Company");
  return {
    ...c,
    stack: parseJson(c.stack, []),
    contacts: await all<any>("SELECT * FROM contacts WHERE company_id = ? AND user_id = ?", id, userId),
    applications: await all<any>("SELECT * FROM applications WHERE company_id = ? AND user_id = ? ORDER BY created_at DESC", id, userId),
  };
}
