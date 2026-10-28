/**
 * Higher As: vocational discovery with evidence attached.
 *
 * Three rules shape this service:
 *
 *   1. A professional cannot verify themselves. Submitting a document writes a
 *      `pending` row; only `reviewCredential` (admin/moderation) can produce
 *      `verified` or `rejected`, and expiry is derived from `expires_on`.
 *   2. A review counts as "verified service" only when it points at an engagement
 *      the customer created and the professional confirmed as completed. Any other
 *      review is allowed but stored and labelled as unverified feedback.
 *   3. A professional may answer a review and ask for moderation, but nothing in
 *      this file lets them edit a rating or delete a review.
 *
 * Contact details (phone, WhatsApp) never leave the server on a list or public
 * profile payload; they are returned only by `proContact`, which is authenticated.
 */
import { all, get, run, parseJson } from "../core/db";
import { AppError, conflict, forbidden, notFound, validation } from "../core/errors";
import { newId, nowIso } from "../util/id";

export const TRADES = [
  { slug: "mechanic", label: "Mechanic" },
  { slug: "plumber", label: "Plumber" },
  { slug: "electrician", label: "Electrician" },
  { slug: "welder", label: "Welder" },
  { slug: "machine_operator", label: "Machine operator" },
  { slug: "oil_and_gas", label: "Oil and gas" },
  { slug: "carpenter", label: "Carpenter" },
  { slug: "mason", label: "Mason" },
  { slug: "tailor", label: "Tailor" },
  { slug: "auto_body", label: "Auto body" },
  { slug: "hvac", label: "HVAC technician" },
  { slug: "solar", label: "Solar installer" },
] as const;

const TRADE_LABEL = Object.fromEntries(TRADES.map((t) => [t.slug, t.label])) as Record<string, string>;

const daysAgo = (iso: string | null | undefined) => {
  if (!iso) return Number.POSITIVE_INFINITY;
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
};

const today = () => new Date().toISOString().slice(0, 10);

/** Expiry is a fact about the document, not a status someone has to remember to set. */
function effectiveCredentialStatus(row: any): string {
  if (row.status === "verified" && row.expires_on && String(row.expires_on) < today()) return "expired";
  return row.status;
}

function publicCredential(row: any) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    issuer: row.issuer ?? null,
    reference: row.reference ?? null,
    issued_on: row.issued_on ?? null,
    expires_on: row.expires_on ?? null,
    status: effectiveCredentialStatus(row),
    reviewed_at: row.reviewed_at ?? null,
    review_note: row.review_note ?? null,
  };
}

/** An extractive line, built only from words the professional wrote. No LLM is wired. */
export function autoSummary(title: string, body: string, tags: string[], trade: string) {
  const label = TRADE_LABEL[trade] ?? "Trade professional";
  const first = String(body ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s/)[0]
    ?.trim();
  const core = first && first.length > 12 ? first : String(title ?? "").trim();
  const skills = tags.slice(0, 3).join(", ");
  const tail = skills ? ` Focus: ${skills}.` : "";
  const text = `${label}. ${core}`.replace(/\.\./g, ".").trim();
  return `${text.slice(0, 220)}${text.length > 220 ? "…" : ""}${tail}`.slice(0, 320);
}

export function isAdmin(user: any): boolean {
  if (!user) return false;
  if (String(user.role ?? "member") === "admin") return true;
  const list = String(process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(String(user.email ?? "").toLowerCase());
}

async function requireAdmin(userId: string) {
  const user = await get<any>("SELECT id, email, role FROM users WHERE id = ?", userId);
  if (!user) throw notFound("User");
  if (!isAdmin(user)) throw forbidden("FORBIDDEN", "Only a platform reviewer can verify credentials or moderate reviews");
  return user;
}

async function profileIdentity(userId: string) {
  const row = await get<any>("SELECT identity FROM profiles WHERE user_id = ?", userId);
  const id = parseJson<any>(row?.identity, {});
  return {
    name: String(id.full_name ?? id.name ?? "").trim(),
    location: String(id.location ?? "").trim(),
  };
}

async function proRow(proId: string) {
  const row = await get<any>("SELECT * FROM pro_profiles WHERE id = ?", proId);
  if (!row) throw notFound("Professional");
  return row;
}

async function ratingFor(proIds: string[]) {
  if (!proIds.length) return new Map<string, any>();
  const rows = await all<any>(
    `SELECT pro_id, rating, verified FROM pro_reviews WHERE hidden = 0 AND pro_id IN (${proIds.map(() => "?").join(",")})`,
    ...proIds
  );
  const map = new Map<string, any>();
  for (const id of proIds) {
    const mine = rows.filter((r) => r.pro_id === id);
    const count = mine.length;
    const avg = count ? Math.round((mine.reduce((n, r) => n + r.rating, 0) / count) * 10) / 10 : null;
    map.set(id, {
      avg,
      count,
      verified: mine.filter((r) => r.verified).length,
      distribution: [5, 4, 3, 2, 1].map((star) => ({ star, count: mine.filter((r) => r.rating === star).length })),
    });
  }
  return map;
}

async function credentialsFor(proIds: string[]) {
  if (!proIds.length) return new Map<string, any>();
  const rows = await all<any>(
    `SELECT pro_id, status, expires_on FROM pro_credentials WHERE pro_id IN (${proIds.map(() => "?").join(",")})`,
    ...proIds
  );
  const map = new Map<string, any>();
  for (const id of proIds) {
    const mine = rows.filter((r) => r.pro_id === id).map((r) => ({ ...r, status: effectiveCredentialStatus(r) }));
    map.set(id, {
      verified: mine.filter((r) => r.status === "verified").length,
      pending: mine.filter((r) => r.status === "pending").length,
      total: mine.length,
    });
  }
  return map;
}

/* ─────────────────────────────── feed ────────────────────────────────── */

export type FeedFilters = {
  q?: string;
  trade?: string;
  city?: string;
  verified?: string;
  available?: string;
  min_rating?: string;
  sort?: string;
  saved?: string;
  limit?: number;
};

export async function listFeed(userId: string, filters: FeedFilters = {}) {
  const viewer = await profileIdentity(userId);
  const pros = await all<any>("SELECT * FROM pro_profiles");
  const ids = pros.map((p) => p.id);
  const ratings = await ratingFor(ids);
  const creds = await credentialsFor(ids);
  const savedRows = await all<any>("SELECT pro_id FROM saved_pros WHERE user_id = ?", userId);
  const saved = new Set(savedRows.map((r) => r.pro_id));
  const posts = await all<any>("SELECT * FROM pro_posts ORDER BY created_at DESC");
  const visibleReviews = await all<any>("SELECT pro_id, body, created_at FROM pro_reviews WHERE hidden = 0 ORDER BY created_at DESC");

  const q = String(filters.q ?? "").toLowerCase().trim();
  const city = String(filters.city ?? "").toLowerCase().trim();
  const trade = String(filters.trade ?? "").toLowerCase().trim();
  const minRating = Number(filters.min_rating ?? 0) || 0;
  const wantVerified = filters.verified === "true";
  const wantAvailable = filters.available === "true";

  const items = pros
    .map((p) => {
      const rating = ratings.get(p.id) ?? { avg: null, count: 0, verified: 0, distribution: [] };
      const cred = creds.get(p.id) ?? { verified: 0, pending: 0, total: 0 };
      const post = posts.find((x) => x.pro_id === p.id) ?? null;
      const tags: string[] = post ? parseJson(post.tags, []) : [];
      const hay = [p.display_name, p.headline, p.summary, p.city, p.service_area, TRADE_LABEL[p.trade], post?.title, post?.body, tags.join(" ")]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      const reasons: string[] = [];
      let score = 0;
      if (viewer.location && p.city && p.city.toLowerCase() === viewer.location.toLowerCase()) {
        score += 30;
        reasons.push(`works in ${p.city}`);
      }
      if (cred.verified > 0) {
        score += Math.min(30, cred.verified * 15);
        reasons.push(`${cred.verified} verified credential${cred.verified === 1 ? "" : "s"}`);
      }
      if (rating.count) {
        score += Math.round((rating.avg ?? 0) * 5);
        reasons.push(`${rating.avg} from ${rating.count} review${rating.count === 1 ? "" : "s"}`);
      }
      if (rating.verified) {
        score += Math.min(20, rating.verified * 5);
        reasons.push(`${rating.verified} verified engagement review${rating.verified === 1 ? "" : "s"}`);
      }
      if (p.available) score += 8;
      if (post && daysAgo(post.created_at) <= 30) {
        score += 10;
        reasons.push("posted recently");
      }
      if (saved.has(p.id)) score += 6;
      if (!p.summary) score -= 6;

      return { p, post, tags, rating, cred, hay, score, reasons };
    })
    .filter(({ p, hay, rating, cred }) => {
      if (q && !hay.includes(q)) return false;
      if (trade && p.trade !== trade) return false;
      if (city && !`${p.city ?? ""} ${p.service_area ?? ""}`.toLowerCase().includes(city)) return false;
      if (minRating && (rating.avg ?? 0) < minRating) return false;
      if (wantVerified && cred.verified === 0) return false;
      if (wantAvailable && !p.available) return false;
      if (filters.saved === "true" && !saved.has(p.id)) return false;
      return true;
    })
    .sort((a, b) => {
      if (filters.sort === "rating") return (b.rating.avg ?? 0) - (a.rating.avg ?? 0) || b.rating.count - a.rating.count;
      if (filters.sort === "recent") return String(b.post?.created_at ?? "").localeCompare(String(a.post?.created_at ?? ""));
      if (filters.sort === "experience") return (b.p.years_experience ?? 0) - (a.p.years_experience ?? 0);
      return b.score - a.score;
    })
    .slice(0, Math.max(1, Math.min(60, filters.limit ?? 30)));

  const facet = (fn: (x: (typeof items)[number]) => string | null | undefined) => {
    const out: Record<string, number> = {};
    for (const it of items) {
      const key = fn(it);
      if (!key) continue;
      out[key] = (out[key] ?? 0) + 1;
    }
    return out;
  };

  return {
    items: items.map(({ p, post, tags, rating, cred, reasons, score }) => ({
      id: p.id,
      user_id: p.user_id,
      display_name: p.display_name,
      trade: p.trade,
      trade_label: TRADE_LABEL[p.trade] ?? p.trade,
      headline: p.headline,
      summary: p.summary,
      city: p.city,
      service_area: p.service_area,
      years_experience: p.years_experience,
      available: !!p.available,
      day_rate_min: p.day_rate_min,
      day_rate_max: p.day_rate_max,
      currency: p.currency,
      rating,
      credentials: cred,
      latest_post: post
        ? {
            id: post.id,
            title: post.title,
            body: post.body,
            kind: post.kind,
            image_url: post.image_url,
            tags,
            auto_summary: post.auto_summary,
            created_at: post.created_at,
          }
        : null,
      saved: saved.has(p.id),
      is_owner: p.user_id === userId,
      match: { score: Math.min(100, Math.max(0, score)), reasons },
    })),
    total: items.length,
    facets: {
      trade: facet((x) => x.p.trade),
      city: facet((x) => x.p.city),
    },
    trades: TRADES,
    viewer: { city: viewer.location, saved: saved.size },
    reviews: visibleReviews
      .filter((r) => items.some((it) => it.p.id === r.pro_id))
      .slice(0, 6)
      .map((r) => ({ pro_id: r.pro_id, body: r.body, created_at: r.created_at })),
  };
}

/* ───────────────────────────── pro profile ───────────────────────────── */

export async function getPro(userId: string, proId: string) {
  const p = await proRow(proId);
  const user = await get<any>("SELECT email, role FROM users WHERE id = ?", userId);
  const admin = isAdmin(user);
  const isOwner = p.user_id === userId;
  const rating = (await ratingFor([proId])).get(proId);
  const creds = await all<any>("SELECT * FROM pro_credentials WHERE pro_id = ? ORDER BY created_at DESC", proId);
  const posts = await all<any>("SELECT * FROM pro_posts WHERE pro_id = ? ORDER BY created_at DESC", proId);
  const reviewRows = await all<any>("SELECT * FROM pro_reviews WHERE pro_id = ? ORDER BY created_at DESC", proId);
  const savedRow = await get<any>("SELECT 1 FROM saved_pros WHERE user_id = ? AND pro_id = ?", userId, proId);
  const myReview = reviewRows.find((r) => r.customer_id === userId) ?? null;

  // A review is eligible only against a job this professional confirmed as done.
  const engagements = await all<any>(
    "SELECT * FROM pro_engagements WHERE pro_id = ? AND customer_id = ? AND confirmed_at IS NOT NULL AND completed_at IS NOT NULL ORDER BY completed_at DESC",
    proId,
    userId
  );
  const openEngagement = engagements.find((e) => !reviewRows.some((r) => r.engagement_id === e.id)) ?? null;

  return {
    id: p.id,
    user_id: p.user_id,
    display_name: p.display_name,
    trade: p.trade,
    trade_label: TRADE_LABEL[p.trade] ?? p.trade,
    headline: p.headline,
    summary: p.summary,
    city: p.city,
    service_area: p.service_area,
    years_experience: p.years_experience,
    available: !!p.available,
    day_rate_min: p.day_rate_min,
    day_rate_max: p.day_rate_max,
    currency: p.currency,
    website: p.website ?? null,
    has_contact: Boolean(p.phone || p.whatsapp),
    rating: rating ?? { avg: null, count: 0, verified: 0, distribution: [] },
    credentials: creds.map((c) => (isOwner || admin ? { ...publicCredential(c), document_name: c.document_name ?? null } : publicCredential(c))),
    posts: posts.map((x) => ({
      id: x.id,
      title: x.title,
      body: x.body,
      kind: x.kind,
      image_url: x.image_url,
      tags: parseJson(x.tags, []),
      auto_summary: x.auto_summary,
      created_at: x.created_at,
    })),
    reviews: reviewRows
      .filter((r) => !r.hidden || isOwner || admin)
      .map((r) => ({
        id: r.id,
        customer_name: r.customer_name,
        rating: r.rating,
        body: r.body,
        verified: !!r.verified,
        engagement_id: r.engagement_id,
        response: r.response,
        responded_at: r.responded_at,
        dispute_status: r.dispute_status,
        dispute_reason: isOwner || admin ? r.dispute_reason : null,
        hidden: !!r.hidden,
        created_at: r.created_at,
      })),
    saved: !!savedRow,
    is_owner: isOwner,
    can_review: !!openEngagement && !myReview,
    reviewable_engagement: openEngagement ? { id: openEngagement.id, title: openEngagement.title } : null,
    my_review: myReview ? { id: myReview.id, rating: myReview.rating, body: myReview.body } : null,
    is_admin: admin,
  };
}

/** Authenticated contact release. Signed-out users and list payloads never see these. */
export async function proContact(userId: string, proId: string) {
  const p = await proRow(proId);
  const viewer = await get<any>("SELECT role FROM users WHERE id = ?", userId);
  if (!viewer) throw notFound("User");
  return {
    display_name: p.display_name,
    phone: p.phone ?? null,
    whatsapp: p.whatsapp ?? null,
    website: p.website ?? null,
    city: p.city ?? null,
    service_area: p.service_area ?? null,
    note: "Shared by the professional. JAMS has not verified this number.",
  };
}

const slugExists = (v: string) => TRADES.some((t) => t.slug === v);

export async function upsertMyPro(
  userId: string,
  body: {
    display_name: string;
    trade: string;
    headline?: string;
    summary?: string;
    city?: string;
    service_area?: string;
    years_experience?: number;
    phone?: string;
    whatsapp?: string;
    website?: string;
    available?: boolean;
    day_rate_min?: number;
    day_rate_max?: number;
    currency?: string;
  }
) {
  if (!slugExists(body.trade)) throw validation("Pick a trade from the list", { trade: "unknown trade" });
  if (body.day_rate_min != null && body.day_rate_max != null && body.day_rate_min > body.day_rate_max) {
    throw validation("Minimum rate cannot be above the maximum");
  }
  const existing = await get<any>("SELECT * FROM pro_profiles WHERE user_id = ?", userId);
  const now = nowIso();
  const values = [
    String(body.display_name).trim().slice(0, 120),
    body.trade,
    body.headline?.trim().slice(0, 160) ?? null,
    String(body.summary ?? "").trim().slice(0, 2000),
    body.city?.trim().slice(0, 120) ?? null,
    body.service_area?.trim().slice(0, 160) ?? null,
    body.years_experience ?? null,
    // A blank field clears the number rather than keeping a stale one.
    body.phone?.trim() || null,
    body.whatsapp?.trim() || null,
    body.website?.trim() || null,
    body.available === false ? 0 : 1,
    body.day_rate_min ?? null,
    body.day_rate_max ?? null,
    body.currency?.slice(0, 8) || "NGN",
  ];
  if (existing) {
    await run(
      `UPDATE pro_profiles SET display_name = ?, trade = ?, headline = ?, summary = ?, city = ?, service_area = ?,
       years_experience = ?, phone = ?, whatsapp = ?, website = ?, available = ?, day_rate_min = ?, day_rate_max = ?,
       currency = ?, updated_at = ? WHERE id = ?`,
      ...values,
      now,
      existing.id
    );
    return getPro(userId, existing.id);
  }
  const id = newId();
  await run(
    `INSERT INTO pro_profiles (id, user_id, display_name, trade, headline, summary, city, service_area, years_experience,
      phone, whatsapp, website, available, day_rate_min, day_rate_max, currency, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    ...values,
    now,
    now
  );
  return getPro(userId, id);
}

/** The owner's workspace: private fields included, plus the review queue they can answer. */
export async function myPro(userId: string) {
  const p = await get<any>("SELECT * FROM pro_profiles WHERE user_id = ?", userId);
  if (!p) return { profile: null, trades: TRADES, credentials: [], posts: [], reviews: [], engagements: [] };
  const [creds, posts, reviews, engagements] = await Promise.all([
    all<any>("SELECT * FROM pro_credentials WHERE pro_id = ? ORDER BY created_at DESC", p.id),
    all<any>("SELECT * FROM pro_posts WHERE pro_id = ? ORDER BY created_at DESC", p.id),
    all<any>("SELECT * FROM pro_reviews WHERE pro_id = ? ORDER BY created_at DESC", p.id),
    all<any>("SELECT * FROM pro_engagements WHERE pro_id = ? ORDER BY created_at DESC", p.id),
  ]);
  return {
    profile: await getPro(userId, p.id),
    trades: TRADES,
    credentials: creds.map((c) => ({ ...publicCredential(c), document_name: c.document_name ?? null })),
    posts: posts.map((x) => ({ id: x.id, title: x.title, body: x.body, kind: x.kind, image_url: x.image_url, tags: parseJson(x.tags, []), auto_summary: x.auto_summary, created_at: x.created_at })),
    reviews: reviews.map((r) => ({
      id: r.id,
      customer_name: r.customer_name,
      rating: r.rating,
      body: r.body,
      verified: !!r.verified,
      response: r.response,
      responded_at: r.responded_at,
      dispute_status: r.dispute_status,
      dispute_reason: r.dispute_reason,
      hidden: !!r.hidden,
      created_at: r.created_at,
    })),
    engagements: engagements.map((e) => ({
      id: e.id,
      title: e.title,
      detail: e.detail,
      completed_at: e.completed_at,
      confirmed_at: e.confirmed_at,
      created_at: e.created_at,
      awaiting_confirm: !e.confirmed_at,
    })),
  };
}

/* ─────────────────────────────── posts ───────────────────────────────── */

export async function createPost(
  userId: string,
  body: { title: string; body?: string; kind?: "work" | "service"; image_url?: string; tags?: string[] }
) {
  const p = await get<any>("SELECT * FROM pro_profiles WHERE user_id = ?", userId);
  if (!p) throw validation("Create your professional profile before posting work");
  const title = String(body.title ?? "").trim();
  if (title.length < 3) throw validation("Give the post a title");
  const text = String(body.body ?? "").trim().slice(0, 4000);
  const tags = (body.tags ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 8);
  const id = newId();
  await run(
    `INSERT INTO pro_posts (id, pro_id, title, body, kind, image_url, tags, auto_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    p.id,
    title.slice(0, 180),
    text,
    body.kind === "service" ? "service" : "work",
    body.image_url?.trim() || null,
    JSON.stringify(tags),
    autoSummary(title, text, tags, p.trade),
    nowIso()
  );
  return get<any>("SELECT * FROM pro_posts WHERE id = ?", id);
}

export async function deletePost(userId: string, postId: string) {
  const row = await get<any>(
    "SELECT p.* FROM pro_posts p JOIN pro_profiles pr ON pr.id = p.pro_id WHERE p.id = ? AND pr.user_id = ?",
    postId,
    userId
  );
  if (!row) throw notFound("Post");
  await run("DELETE FROM pro_posts WHERE id = ?", postId);
  return { deleted: true };
}

/* ──────────────────────────── credentials ────────────────────────────── */

export async function submitCredential(
  userId: string,
  body: { kind: string; title: string; issuer?: string; reference?: string; issued_on?: string; expires_on?: string; document_name?: string; document_b64?: string }
) {
  const p = await get<any>("SELECT * FROM pro_profiles WHERE user_id = ?", userId);
  if (!p) throw validation("Create your professional profile before submitting a credential");
  const kind = ["licence", "certificate", "training", "registration"].includes(body.kind) ? body.kind : "certificate";
  const title = String(body.title ?? "").trim();
  if (title.length < 3) throw validation("Name the credential");
  if (body.document_b64 && body.document_b64.length > 6_000_000) {
    throw new AppError("FILE_TOO_LARGE", 413, "That document is over 4 MB, compress the scan and try again");
  }
  const id = newId();
  await run(
    `INSERT INTO pro_credentials (id, pro_id, kind, title, issuer, reference, issued_on, expires_on, document_name, document_b64, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    id,
    p.id,
    kind,
    title.slice(0, 180),
    body.issuer?.trim().slice(0, 160) || null,
    body.reference?.trim().slice(0, 120) || null,
    body.issued_on || null,
    body.expires_on || null,
    body.document_name?.trim().slice(0, 200) || null,
    body.document_b64 || null,
    nowIso()
  );
  const row = await get<any>("SELECT * FROM pro_credentials WHERE id = ?", id);
  return { ...publicCredential(row), document_name: row.document_name };
}

export async function credentialQueue(userId: string) {
  await requireAdmin(userId);
  const rows = await all<any>(
    `SELECT c.*, p.display_name, p.trade FROM pro_credentials c JOIN pro_profiles p ON p.id = c.pro_id
     WHERE c.status = 'pending' ORDER BY c.created_at ASC`
  );
  return {
    items: rows.map((r) => ({
      ...publicCredential(r),
      pro_id: r.pro_id,
      pro_name: r.display_name,
      trade: r.trade,
      trade_label: TRADE_LABEL[r.trade] ?? r.trade,
      document_name: r.document_name ?? null,
      has_document: !!r.document_b64,
      submitted_at: r.created_at,
    })),
  };
}

export async function reviewCredential(userId: string, credentialId: string, decision: "verified" | "rejected", note?: string) {
  const admin = await requireAdmin(userId);
  const row = await get<any>("SELECT * FROM pro_credentials WHERE id = ?", credentialId);
  if (!row) throw notFound("Credential");
  await run(
    "UPDATE pro_credentials SET status = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?",
    decision,
    note?.trim().slice(0, 500) || null,
    String(admin.email ?? admin.id),
    nowIso(),
    credentialId
  );
  return { id: credentialId, status: decision };
}

/** Only the reviewer who owns the queue can open the private document. */
export async function credentialDocument(userId: string, credentialId: string) {
  await requireAdmin(userId);
  const row = await get<any>("SELECT document_name, document_b64 FROM pro_credentials WHERE id = ?", credentialId);
  if (!row?.document_b64) throw notFound("Document");
  return { filename: row.document_name ?? "credential", b64: row.document_b64 };
}

/* ──────────────────────────── engagements ────────────────────────────── */

export async function createEngagement(userId: string, proId: string, body: { title: string; detail?: string; completed_at?: string }) {
  const p = await proRow(proId);
  if (p.user_id === userId) throw validation("You cannot book your own service");
  const title = String(body.title ?? "").trim();
  if (title.length < 3) throw validation("Describe the job");
  const existing = await get<any>("SELECT id FROM pro_engagements WHERE pro_id = ? AND customer_id = ? AND title = ?", proId, userId, title);
  if (existing) throw conflict("This job is already recorded with this professional");
  const id = newId();
  await run(
    `INSERT INTO pro_engagements (id, pro_id, customer_id, title, detail, completed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    proId,
    userId,
    title.slice(0, 180),
    body.detail?.trim().slice(0, 1200) || null,
    body.completed_at || nowIso(),
    nowIso()
  );
  return get<any>("SELECT * FROM pro_engagements WHERE id = ?", id);
}

export async function confirmEngagement(userId: string, engagementId: string) {
  const row = await get<any>(
    "SELECT e.* FROM pro_engagements e JOIN pro_profiles p ON p.id = e.pro_id WHERE e.id = ? AND p.user_id = ?",
    engagementId,
    userId
  );
  if (!row) throw notFound("Engagement");
  if (row.confirmed_at) throw conflict("This job is already confirmed");
  await run("UPDATE pro_engagements SET confirmed_at = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?", nowIso(), nowIso(), engagementId);
  return { id: engagementId, confirmed: true };
}

/* ────────────────────────────── reviews ──────────────────────────────── */

export async function createReview(
  userId: string,
  proId: string,
  body: { rating: number; body: string; engagement_id?: string }
) {
  const p = await proRow(proId);
  if (p.user_id === userId) throw forbidden("FORBIDDEN", "You cannot review your own professional profile");
  const rating = Math.round(Number(body.rating));
  if (!(rating >= 1 && rating <= 5)) throw validation("Rating must be between 1 and 5");
  const text = String(body.body ?? "").trim();
  if (text.length < 10) throw validation("Write at least a sentence - “good” does not help anyone");
  if (text.length > 3000) throw validation("Keep the review under 3000 characters");

  let verified = 0;
  let engagementId: string | null = null;
  if (body.engagement_id) {
    const engagement = await get<any>(
      "SELECT * FROM pro_engagements WHERE id = ? AND pro_id = ? AND customer_id = ?",
      body.engagement_id,
      proId,
      userId
    );
    if (!engagement) throw notFound("Engagement");
    if (!engagement.confirmed_at) throw validation("The professional has not confirmed this job yet, so it cannot count as verified");
    engagementId = engagement.id;
    verified = 1;
  }

  const identity = await profileIdentity(userId);
  const name = identity.name || "A JAMS member";
  const existing = await get<any>("SELECT * FROM pro_reviews WHERE pro_id = ? AND customer_id = ?", proId, userId);
  if (existing) {
    // Editing your own review is allowed; creating a second one is not, and a
    // verified review keeps its engagement (and therefore its evidence).
    await run(
      "UPDATE pro_reviews SET rating = ?, body = ?, verified = ?, engagement_id = COALESCE(?, engagement_id) WHERE id = ?",
      rating,
      text,
      existing.verified || verified,
      engagementId,
      existing.id
    );
    return { id: existing.id, updated: true };
  }

  const id = newId();
  await run(
    `INSERT INTO pro_reviews (id, pro_id, engagement_id, customer_id, customer_name, rating, body, verified, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    proId,
    engagementId,
    userId,
    name.slice(0, 120),
    rating,
    text,
    verified,
    nowIso()
  );
  return { id, verified: !!verified };
}

export async function respondToReview(userId: string, reviewId: string, response: string) {
  const row = await get<any>(
    "SELECT r.*, p.user_id AS owner_id FROM pro_reviews r JOIN pro_profiles p ON p.id = r.pro_id WHERE r.id = ?",
    reviewId
  );
  if (!row) throw notFound("Review");
  if (row.owner_id !== userId) throw forbidden("FORBIDDEN", "Only the professional being reviewed can respond");
  const text = String(response ?? "").trim();
  if (text.length < 2) throw validation("Write a response first");
  if (text.length > 1500) throw validation("Keep the response under 1500 characters");
  // Deliberately no rating column in this UPDATE.
  await run("UPDATE pro_reviews SET response = ?, responded_at = ? WHERE id = ?", text, nowIso(), reviewId);
  return { id: reviewId, responded: true };
}

export async function disputeReview(userId: string, reviewId: string, reason: string) {
  const row = await get<any>(
    "SELECT r.*, p.user_id AS owner_id FROM pro_reviews r JOIN pro_profiles p ON p.id = r.pro_id WHERE r.id = ?",
    reviewId
  );
  if (!row) throw notFound("Review");
  if (row.owner_id !== userId) throw forbidden("FORBIDDEN", "Only the professional being reviewed can request moderation");
  const text = String(reason ?? "").trim();
  if (text.length < 10) throw validation("Explain what is wrong with the review");
  if (row.dispute_status === "open") throw conflict("This review is already in the moderation queue");
  await run("UPDATE pro_reviews SET dispute_status = 'open', dispute_reason = ? WHERE id = ?", text.slice(0, 1000), reviewId);
  return { id: reviewId, dispute_status: "open" };
}

export async function moderationQueue(userId: string) {
  await requireAdmin(userId);
  const rows = await all<any>(
    `SELECT r.*, p.display_name, p.trade FROM pro_reviews r JOIN pro_profiles p ON p.id = r.pro_id
     WHERE r.dispute_status = 'open' ORDER BY r.created_at ASC`
  );
  return {
    items: rows.map((r) => ({
      id: r.id,
      pro_name: r.display_name,
      trade_label: TRADE_LABEL[r.trade] ?? r.trade,
      customer_name: r.customer_name,
      rating: r.rating,
      body: r.body,
      verified: !!r.verified,
      dispute_reason: r.dispute_reason,
      response: r.response,
      created_at: r.created_at,
    })),
  };
}

/**
 * `upheld` means the reviewer found a policy violation, so the review is hidden
 * from aggregates. `dismissed` leaves the review exactly as the customer wrote it.
 * Neither outcome changes the star rating.
 */
export async function moderateReview(userId: string, reviewId: string, outcome: "upheld" | "dismissed", note?: string) {
  await requireAdmin(userId);
  const row = await get<any>("SELECT * FROM pro_reviews WHERE id = ?", reviewId);
  if (!row) throw notFound("Review");
  if (row.dispute_status !== "open") throw conflict("This review is not awaiting moderation");
  await run(
    "UPDATE pro_reviews SET dispute_status = ?, hidden = ?, response = COALESCE(response, ?) WHERE id = ?",
    outcome,
    outcome === "upheld" ? 1 : 0,
    note?.trim() ? `Moderation note: ${note.trim().slice(0, 400)}` : null,
    reviewId
  );
  return { id: reviewId, outcome };
}

/* ─────────────────────────── saved / follow ──────────────────────────── */

export async function toggleSaved(userId: string, proId: string) {
  await proRow(proId);
  const row = await get<any>("SELECT 1 FROM saved_pros WHERE user_id = ? AND pro_id = ?", userId, proId);
  if (row) {
    await run("DELETE FROM saved_pros WHERE user_id = ? AND pro_id = ?", userId, proId);
    return { saved: false };
  }
  await run("INSERT INTO saved_pros (user_id, pro_id, created_at) VALUES (?, ?, ?)", userId, proId, nowIso());
  return { saved: true };
}
