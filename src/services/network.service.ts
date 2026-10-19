/**
 * The network layer: people, jobs posted on this platform, events, and CV reviews.
 *
 * Everything here ranks instead of filtering. A directory that returns rows in
 * insertion order is a database browser; a directory that puts the person in the
 * same profession, the same city, or with the skill you share at the top is a
 * network. Each row therefore carries `match: { score, reasons }` computed against
 * the signed-in user — the UI shows the reasons, so a ranking is never a black box.
 *
 * Seeds: events and platform jobs ship with `demo = 1` rows so the two new pages
 * are reviewable before anyone has posted. They are inserted once, they are marked
 * in the API, and a real posting sorts above them.
 */
import { all, get, parseJson, run } from "../core/db";
import { notFound, validation } from "../core/errors";
import { newId, nowIso } from "../util/id";
import { getProfile, updateProfile } from "./profile.service";

/* ───────────────────────────── professions ───────────────────────────── */

/** The taxonomy the whole network speaks. Aliases decide what “my profession” means. */
export const PROFESSIONS = [
  "software engineering",
  "product design",
  "graphic design",
  "data & analytics",
  "product management",
  "marketing",
  "finance",
  "sales",
  "customer success",
  "human resources",
  "operations",
  "healthcare",
  "education",
  "legal",
  "media & communications",
  "engineering (hardware)",
  "other",
] as const;

const ALIASES: Record<string, string[]> = {
  "software engineering": [
    "software", "engineer", "developer", "programmer", "frontend", "front-end", "backend", "back-end",
    "full stack", "fullstack", "devops", "sre", "mobile", "android", "ios", "qa", "testing",
    "react", "node", "python", "java", "golang", "typescript", "cloud", "data engineer", "machine learning",
  ],
  "product design": ["product design", "ux", "ui", "interaction design", "figma", "design systems", "user research", "designer"],
  "graphic design": ["graphic", "brand design", "illustration", "visual design", "motion design"],
  "data & analytics": ["data", "analyst", "analytics", "bi", "statistic", "data science", "sql"],
  "product management": ["product manager", "product owner", "pm", "roadmap"],
  marketing: ["marketing", "growth", "seo", "content", "brand", "social media", "communications"],
  finance: ["finance", "account", "audit", "tax", "investment", "banking", "fintech"],
  sales: ["sales", "business development", "account executive", "bd"],
  "customer success": ["customer success", "support", "customer experience", "cx"],
  "human resources": ["human resources", "hr", "recruit", "talent", "people ops"],
  operations: ["operations", "ops", "logistics", "supply chain", "project manager"],
  healthcare: ["health", "medical", "nurse", "doctor", "pharmac", "clinical"],
  education: ["education", "teacher", "tutor", "lecturer", "curriculum"],
  legal: ["legal", "lawyer", "counsel", "compliance", "paralegal"],
  "media & communications": ["media", "journalis", "editor", "copywriter", "public relations", "pr"],
  "engineering (hardware)": ["mechanical", "electrical", "civil", "hardware", "manufactur"],
};

/** “Front-end dev” and “frontend engineering” are the same shelf. */
export function normalizeProfession(input?: unknown): string {
  const raw = String(input ?? "").toLowerCase().trim().replace(/[_/]+/g, " ").replace(/\s+/g, " ");
  if (!raw) return "";
  for (const key of PROFESSIONS) if (raw === key) return key;
  // specific disciplines first: “graphic designer” must not become “product design”
  for (const key of ["graphic design", "product design", "data & analytics", "customer success", "human resources", "media & communications", "engineering (hardware)"]) {
    if (raw.includes(key) || ALIASES[key]?.some((a) => raw.includes(a))) return key;
  }
  for (const key of PROFESSIONS) {
    if (ALIASES[key]?.some((a) => raw.includes(a))) return key;
  }
  return raw;
}

/** The profession this account has declared, wherever it was written first. */
export async function viewerContext(userId: string) {
  const p = await getProfile(userId);
  const id: any = p.identity ?? {};
  const prefs: any = p.prefs ?? {};
  const declared = prefs.profession ?? id.profession ?? id.career_field ?? prefs.career_category ?? "";
  const profession = normalizeProfession(declared);
  const city = String(id.location ?? prefs.location ?? "").split(",")[0].trim();
  const skills = (p.skills ?? []).map((s: any) => String(s.name).toLowerCase());
  return {
    name: String(id.name ?? id.full_name ?? "").trim(),
    headline: String(id.headline ?? "").trim(),
    profession,
    profession_declared: !!profession,
    city,
    seniority: String(prefs.seniority ?? "").trim(),
    skills,
    links: (id.links ?? {}) as Record<string, string>,
    years: (p.experiences ?? []).length,
  };
}

/* ─────────────────────────────── people ──────────────────────────────── */

const QUESTIONS = [
  { key: "work", q: "What do you actually do all day?", hint: "Not your title — the work. “I turn messy spreadsheets into dashboards people trust.”" },
  { key: "proof", q: "What is one thing you built or shipped that you are proud of?", hint: "A project, a process, a team. One sentence with a number if you have one." },
  { key: "offer", q: "What can someone hire or ask you for this month?", hint: "A service, a skill, a collaboration. This is what the Offers field shows." },
  { key: "want", q: "What are you looking for right now?", hint: "A role, a co-founder, a mentor, clients — say it plainly." },
  { key: "reach", q: "How should someone reach you?", hint: "Add the social links you actually answer: LinkedIn, X, GitHub, Instagram, a portfolio." },
];

export const PEOPLE_QUESTIONS = QUESTIONS;

type PersonRow = any;

const shapePerson = (r: PersonRow) => ({
  id: r.id,
  user_id: r.user_id,
  name: r.display_name,
  headline: r.headline ?? "",
  profession: r.profession ?? "",
  seniority: r.seniority ?? "",
  location: r.location ?? "",
  bio: r.bio ?? "",
  links: parseJson<Record<string, string>>(r.links, {}),
  offers: parseJson<string[]>(r.offers, []),
  looking_for: r.looking_for ?? "",
  answers: parseJson<{ q: string; a: string }[]>(r.answers, []),
  open_to: parseJson<string[]>(r.open_to, []),
  visible: !!r.visible,
  updated_at: r.updated_at,
});

const tokenize = (s: string) =>
  String(s ?? "")
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .filter((w) => w.length > 2);

/** Does this text mention any of the skills the viewer holds? */
function skillHits(text: string, skills: string[]) {
  const hay = ` ${text.toLowerCase()} `;
  return skills.filter((s) => s.length > 2 && hay.includes(s.toLowerCase()));
}

export async function listPeople(
  userId: string,
  filters: { q?: string; profession?: string; location?: string; open_to?: string; sort?: string; limit?: number } = {}
) {
  const viewer = await viewerContext(userId);
  const rows = await all<PersonRow>("SELECT * FROM public_profiles WHERE visible = 1 AND user_id <> ?", userId);
  const mine = await get<PersonRow>("SELECT * FROM public_profiles WHERE user_id = ?", userId);

  // reviews per public CV, one query, grouped in memory
  const reviewRows = await all<any>(
    `SELECT cv_id, AVG(rating) AS avg, COUNT(*) AS n FROM cv_reviews GROUP BY cv_id`
  );
  const ratings = new Map(reviewRows.map((r) => [r.cv_id, { avg: Number(r.avg), count: Number(r.n) }]));
  const publicCvs = await all<any>("SELECT id, user_id, name, archetype, updated_at FROM cvs WHERE public = 1 ORDER BY updated_at DESC");
  const cvOf = new Map(publicCvs.map((c) => [c.user_id, c]));

  const q = String(filters.q ?? "").toLowerCase().trim();
  const profession = normalizeProfession(filters.profession);
  const location = String(filters.location ?? "").toLowerCase().trim();
  const openTo = String(filters.open_to ?? "").toLowerCase().trim();

  const items = rows
    .map((r) => {
      const person = shapePerson(r);
      const cv = cvOf.get(r.user_id) ?? null;
      const rating = cv ? ratings.get(cv.id) ?? null : null;
      const hay = [person.name, person.headline, person.profession, person.bio, person.offers.join(" "), person.looking_for, person.location].join(" ").toLowerCase();
      const reasons: string[] = [];
      let score = 0;

      if (viewer.profession && person.profession === viewer.profession) {
        score += 40;
        reasons.push(`works in ${person.profession}, same as you`);
      } else if (viewer.profession && ALIASES[person.profession]?.some((a) => viewer.profession.includes(a))) {
        score += 20;
        reasons.push("a neighbouring discipline");
      }
      const shared = skillHits(hay, viewer.skills);
      if (shared.length) {
        score += Math.min(25, shared.length * 8);
        reasons.push(`shares ${shared.slice(0, 3).join(", ")}`);
      }
      if (viewer.city && person.location && person.location.toLowerCase().includes(viewer.city.toLowerCase())) {
        score += 15;
        reasons.push(`also in ${person.location}`);
      }
      if (person.open_to.length) {
        score += 8;
        reasons.push(`open to ${person.open_to.slice(0, 2).join(", ")}`);
      }
      const age = (Date.now() - +new Date(person.updated_at)) / 86_400_000;
      if (age <= 14) {
        score += 10;
        reasons.push("updated this fortnight");
      }
      if (rating) score += Math.min(10, Math.round(rating.avg * 2));

      return { ...person, cv: cv ? { ...cv, rating } : null, is_me: false, match: { score: Math.min(100, score), reasons } };
    })
    .filter((p) => {
      if (q && !`${p.name} ${p.headline} ${p.profession} ${p.bio} ${p.offers.join(" ")}`.toLowerCase().includes(q)) return false;
      if (profession && p.profession !== profession) return false;
      if (location && !p.location.toLowerCase().includes(location)) return false;
      if (openTo && !p.open_to.map((o) => o.toLowerCase()).includes(openTo)) return false;
      return true;
    })
    .sort((a, b) => (filters.sort === "new" ? +new Date(b.updated_at) - +new Date(a.updated_at) : b.match.score - a.match.score || b.updated_at.localeCompare(a.updated_at)));

  const facet = (key: "profession" | "location") => {
    const out: Record<string, number> = {};
    for (const p of items) {
      const v = p[key] || "—";
      out[v] = (out[v] ?? 0) + 1;
    }
    return out;
  };

  return {
    items: items.slice(0, filters.limit ?? 40),
    total: items.length,
    facets: { profession: facet("profession"), location: facet("location") },
    viewer: { ...viewer, has_profile: !!mine },
    me: mine ? shapePerson(mine) : null,
    questions: QUESTIONS,
  };
}

export async function getPerson(userId: string, personId: string) {
  const row = await get<PersonRow>("SELECT * FROM public_profiles WHERE id = ? AND visible = 1", personId);
  if (!row) throw notFound("Person");
  const cvs = await all<any>("SELECT id, name, archetype, updated_at, public, copyright FROM cvs WHERE user_id = ? AND public = 1", row.user_id);
  const reviews = await all<any>(
    `SELECT r.*, c.name AS cv_name FROM cv_reviews r JOIN cvs c ON c.id = r.cv_id
     WHERE r.cv_id IN (SELECT id FROM cvs WHERE user_id = ? AND public = 1) ORDER BY r.created_at DESC`,
    row.user_id
  );
  const viewer = await viewerContext(userId);
  return {
    ...shapePerson(row),
    is_me: row.user_id === userId,
    cvs: cvs.map((c) => {
      const list = reviews.filter((r) => r.cv_id === c.id);
      return {
        ...c,
        reviews: { count: list.length, avg: list.length ? Math.round((list.reduce((n, r) => n + r.rating, 0) / list.length) * 10) / 10 : null },
      };
    }),
    reviews: reviews.map((r) => ({
      id: r.id,
      cv_id: r.cv_id,
      cv_name: r.cv_name,
      reviewer_name: r.reviewer_name,
      reviewer_role: r.reviewer_role,
      relationship: r.relationship,
      rating: r.rating,
      body: r.body,
      created_at: r.created_at,
      mine: r.reviewer_id === userId,
    })),
    viewer,
  };
}

export async function upsertMyPerson(
  userId: string,
  input: {
    name?: string;
    headline?: string;
    profession?: string;
    seniority?: string;
    location?: string;
    bio?: string;
    links?: Record<string, string>;
    offers?: string[];
    looking_for?: string;
    answers?: { q: string; a: string }[];
    open_to?: string[];
    visible?: boolean;
  }
) {
  const existing = await get<PersonRow>("SELECT * FROM public_profiles WHERE user_id = ?", userId);
  const viewer = await viewerContext(userId);
  const profession = normalizeProfession(input.profession ?? existing?.profession ?? viewer.profession);
  const name = String(input.name ?? existing?.display_name ?? viewer.name ?? "You").trim() || "You";
  const now = nowIso();

  // The profession is shared state: Hirers asks for it too, so writing it here
  // means the next page does not ask again.
  if (profession) await updateProfile(userId, { prefs: { profession } });

  if (existing) {
    await run(
      `UPDATE public_profiles SET display_name = ?, headline = ?, profession = ?, seniority = ?, location = ?, bio = ?,
         links = ?, offers = ?, looking_for = ?, answers = ?, open_to = ?, visible = ?, updated_at = ? WHERE user_id = ?`,
      name,
      input.headline ?? existing.headline ?? viewer.headline,
      profession,
      input.seniority ?? existing.seniority ?? viewer.seniority,
      input.location ?? existing.location ?? viewer.city,
      input.bio ?? existing.bio ?? "",
      JSON.stringify(input.links ?? parseJson(existing.links, {})),
      JSON.stringify(input.offers ?? parseJson(existing.offers, [])),
      input.looking_for ?? existing.looking_for ?? "",
      JSON.stringify(input.answers ?? parseJson(existing.answers, [])),
      JSON.stringify(input.open_to ?? parseJson(existing.open_to, [])),
      (input.visible ?? !!existing.visible) ? 1 : 0,
      now,
      userId
    );
  } else {
    await run(
      `INSERT INTO public_profiles (id, user_id, display_name, headline, profession, seniority, location, bio, links, offers, looking_for, answers, open_to, visible, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId(),
      userId,
      name,
      input.headline ?? viewer.headline,
      profession,
      input.seniority ?? viewer.seniority,
      input.location ?? viewer.city,
      input.bio ?? "",
      JSON.stringify(input.links ?? viewer.links ?? {}),
      JSON.stringify(input.offers ?? []),
      input.looking_for ?? "",
      JSON.stringify(input.answers ?? []),
      JSON.stringify(input.open_to ?? []),
      input.visible === false ? 0 : 1,
      now,
      now
    );
  }
  return listPeople(userId);
}

/* ─────────────────────────── platform jobs ───────────────────────────── */

const JOB_SEEDS: {
  company: string;
  title: string;
  profession: string;
  seniority: string;
  location: string;
  remote: number;
  salary_min: number;
  salary_max: number;
  currency: string;
  description: string;
  tags: string[];
}[] = [
  { company: "Paystack", title: "Frontend Engineer (React, TypeScript)", profession: "software engineering", seniority: "mid", location: "Lagos, Nigeria", remote: 0, salary_min: 9_000_000, salary_max: 14_000_000, currency: "NGN", description: "Own the merchant dashboard: React 19, TypeScript, a design system used by every product team. You will ship weekly and review other people's UI.", tags: ["react", "typescript", "design systems", "testing"] },
  { company: "Moniepoint", title: "Backend Engineer — Payments", profession: "software engineering", seniority: "senior", location: "Lagos, Nigeria", remote: 0, salary_min: 14_000_000, salary_max: 20_000_000, currency: "NGN", description: "Node and Go services moving money for 2m+ businesses. Strong on idempotency, ledgers and on-call discipline.", tags: ["node", "go", "postgres", "payments"] },
  { company: "Andela", title: "DevOps Engineer (Remote, Africa)", profession: "software engineering", seniority: "mid", location: "Remote", remote: 1, salary_min: 12_000_000, salary_max: 18_000_000, currency: "NGN", description: "Kubernetes, Terraform, GitHub Actions. You will cut deploy time for client teams and keep the pager quiet.", tags: ["kubernetes", "terraform", "aws", "ci/cd"] },
  { company: "Cowrywise", title: "Product Designer", profession: "product design", seniority: "mid", location: "Lagos, Nigeria", remote: 1, salary_min: 7_000_000, salary_max: 11_000_000, currency: "NGN", description: "End-to-end product design for savings and investment flows: research, prototypes, shipped UI. Figma and a design system you help shape.", tags: ["figma", "prototyping", "user research", "fintech"] },
  { company: "Kuda", title: "Data Analyst, Growth", profession: "data & analytics", seniority: "mid", location: "Lagos, Nigeria", remote: 0, salary_min: 6_000_000, salary_max: 9_500_000, currency: "NGN", description: "SQL, dbt and a warehouse you can trust. Turn activation and retention questions into dashboards product can act on.", tags: ["sql", "dbt", "looker", "experimentation"] },
  { company: "Bumpa", title: "Growth Marketing Manager", profession: "marketing", seniority: "senior", location: "Remote", remote: 1, salary_min: 8_000_000, salary_max: 12_000_000, currency: "NGN", description: "Own paid and lifecycle for a commerce app used by 50k+ merchants. You will run the experiments yourself, not just brief them.", tags: ["paid media", "lifecycle", "analytics", "seo"] },
  { company: "Flutterwave", title: "Customer Success Lead", profession: "customer success", seniority: "mid", location: "Lagos, Nigeria", remote: 0, salary_min: 7_000_000, salary_max: 10_000_000, currency: "NGN", description: "Lead a pod of five supporting enterprise merchants across West Africa. Own escalation, renewal and the QBR story.", tags: ["enterprise", "retention", "crm", "payments"] },
  { company: "Stears", title: "Content Strategist", profession: "media & communications", seniority: "mid", location: "Remote", remote: 1, salary_min: 5_000_000, salary_max: 8_000_000, currency: "NGN", description: "Shape the editorial calendar and write the analysis that gets quoted. Data-literate writing, not keyword filler.", tags: ["writing", "editorial", "data", "newsletters"] },
  { company: "PwC Nigeria", title: "Financial Analyst, Deals", profession: "finance", seniority: "junior", location: "Lagos, Nigeria", remote: 0, salary_min: 4_800_000, salary_max: 6_500_000, currency: "NGN", description: "Modelling, diligence and client reporting for mid-market transactions. Excel and slide craft matter here.", tags: ["modelling", "excel", "valuation", "diligence"] },
  { company: "MTN Nigeria", title: "HR Business Partner", profession: "human resources", seniority: "senior", location: "Lagos, Nigeria", remote: 0, salary_min: 9_000_000, salary_max: 13_000_000, currency: "NGN", description: "Partner with two technology divisions on org design, performance and hiring. Data-led people decisions.", tags: ["org design", "performance", "hiring", "hris"] },
];

async function seedJobs() {
  const n = await get<{ n: number }>("SELECT COUNT(*) AS n FROM platform_jobs");
  if (Number(n?.n ?? 0) > 0) return;
  for (const j of JOB_SEEDS) {
    await run(
      `INSERT INTO platform_jobs (id, posted_by, company, title, profession, seniority, location, remote, employment_type, salary_min, salary_max, currency, description, tags, status, demo, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, 'full-time', ?, ?, ?, ?, ?, 'open', 1, ?)`,
      newId(),
      j.company,
      j.title,
      j.profession,
      j.seniority,
      j.location,
      j.remote,
      j.salary_min,
      j.salary_max,
      j.currency,
      j.description,
      JSON.stringify(j.tags),
      nowIso()
    );
  }
}

export async function listPlatformJobs(
  userId: string,
  filters: { q?: string; location?: string; remote?: string; seniority?: string; profession?: string } = {}
) {
  await seedJobs();
  const viewer = await viewerContext(userId);
  // An explicit filter wins over the stored profession only for this query; the
  // page still knows it has no declared profession and asks.
  const profession = normalizeProfession(filters.profession || viewer.profession);
  const rows = await all<any>("SELECT * FROM platform_jobs WHERE status = 'open'");
  const q = String(filters.q ?? "").toLowerCase().trim();
  const location = String(filters.location ?? "").toLowerCase().trim();
  const remote = filters.remote === "true";
  const seniority = String(filters.seniority ?? "").toLowerCase().trim();

  const items = rows
    .map((r) => {
      const tags = parseJson<string[]>(r.tags, []);
      const hay = [r.title, r.company, r.description, tags.join(" "), r.location].join(" ").toLowerCase();
      const reasons: string[] = [];
      let score = 0;
      if (profession && r.profession === profession) {
        score += 55;
        reasons.push(`posted for ${r.profession}`);
      } else if (profession && ALIASES[r.profession]?.some((a) => profession.includes(a))) {
        score += 20;
        reasons.push("related discipline");
      }
      const shared = skillHits(hay, viewer.skills);
      if (shared.length) {
        score += Math.min(25, shared.length * 9);
        reasons.push(`asks for ${shared.slice(0, 3).join(", ")}`);
      }
      if (viewer.city && r.location?.toLowerCase().includes(viewer.city.toLowerCase())) {
        score += 12;
        reasons.push(`in ${r.location}`);
      }
      if (seniority && r.seniority === seniority) {
        score += 8;
        reasons.push(`${r.seniority} level`);
      }
      if (r.remote) score += 3;
      if (!r.demo) {
        score += 6;
        reasons.push("posted on JAMS");
      }
      return {
        id: r.id,
        company: r.company,
        title: r.title,
        profession: r.profession,
        seniority: r.seniority,
        location: r.location,
        remote: !!r.remote,
        employment_type: r.employment_type,
        salary: r.salary_min ? { min: r.salary_min, max: r.salary_max, currency: r.currency } : null,
        description: r.description,
        tags,
        contact_email: r.contact_email,
        demo: !!r.demo,
        posted_at: r.created_at,
        mine: r.posted_by === userId,
        match: { score: Math.min(100, score), reasons },
      };
    })
    .filter((j) => {
      if (q && !`${j.title} ${j.company} ${j.description} ${j.tags.join(" ")}`.toLowerCase().includes(q)) return false;
      if (location && !String(j.location ?? "").toLowerCase().includes(location)) return false;
      if (remote && !j.remote) return false;
      if (seniority && j.seniority !== seniority) return false;
      return true;
    })
    .sort((a, b) => b.match.score - a.match.score || b.posted_at.localeCompare(a.posted_at));

  const facets = {
    profession: items.reduce<Record<string, number>>((acc, j) => ({ ...acc, [j.profession]: (acc[j.profession] ?? 0) + 1 }), {}),
    seniority: items.reduce<Record<string, number>>((acc, j) => ({ ...acc, [j.seniority ?? "—"]: (acc[j.seniority ?? "—"] ?? 0) + 1 }), {}),
  };

  return {
    items,
    total: items.length,
    facets,
    viewer: { ...viewer, needs_profession: !viewer.profession },
    /** the professions the form offers, aliases already folded in */
    professions: PROFESSIONS,
    demo: items.some((j) => j.demo),
  };
}

export async function setProfession(userId: string, profession: string) {
  const normalized = normalizeProfession(profession);
  if (!normalized) throw validation("Pick or type a profession first");
  await updateProfile(userId, { prefs: { profession: normalized } });
  const person = await get("SELECT id FROM public_profiles WHERE user_id = ?", userId);
  if (person) await run("UPDATE public_profiles SET profession = ?, updated_at = ? WHERE user_id = ?", normalized, nowIso(), userId);
  return { profession: normalized };
}

export async function createPlatformJob(
  userId: string,
  input: {
    company: string;
    title: string;
    profession: string;
    seniority?: string;
    location?: string;
    remote?: boolean;
    employment_type?: string;
    salary_min?: number;
    salary_max?: number;
    currency?: string;
    description?: string;
    tags?: string[];
    contact_email?: string;
  }
) {
  const profession = normalizeProfession(input.profession);
  if (!input.company?.trim() || !input.title?.trim()) throw validation("A company and a role title are required");
  if (!profession) throw validation("Say which profession this role is for");
  const id = newId();
  await run(
    `INSERT INTO platform_jobs (id, posted_by, company, title, profession, seniority, location, remote, employment_type, salary_min, salary_max, currency, description, tags, contact_email, status, demo, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?)`,
    id,
    userId,
    input.company.trim(),
    input.title.trim(),
    profession,
    input.seniority ?? null,
    input.location ?? null,
    input.remote ? 1 : 0,
    input.employment_type ?? "full-time",
    input.salary_min ?? null,
    input.salary_max ?? null,
    input.currency ?? null,
    input.description ?? null,
    JSON.stringify((input.tags ?? []).map((t) => String(t).trim()).filter(Boolean)),
    input.contact_email ?? null,
    nowIso()
  );
  return { id, profession };
}

/* ─────────────────────────────── events ──────────────────────────────── */

const EVENT_SEEDS: {
  title: string;
  kind: string;
  host: string;
  city: string;
  venue: string;
  format: string;
  in_days: number;
  hours: number;
  description: string;
  tags: string[];
  price: string;
  seats?: number;
  featured?: number;
}[] = [
  { title: "Lagos Tech Hiring Fair — Q4", kind: "hiring", host: "Lagos State Employment Trust Fund", city: "Lagos", venue: "Landmark Event Centre, Victoria Island", format: "in-person", in_days: 12, hours: 6, description: "Forty companies hiring across engineering, design, data and support. Bring six printed CVs; on-the-spot screens for junior and mid roles.", tags: ["engineering", "design", "data", "graduate"], price: "Free", featured: 1 },
  { title: "Frontend Systems Workshop", kind: "training", host: "React Lagos", city: "Lagos", venue: "Co-Creation Hub, Yaba", format: "hybrid", in_days: 6, hours: 4, description: "A hands-on day on React 19, server components and design systems. Laptops required; a working repo is provided.", tags: ["react", "typescript", "frontend"], price: "Free", seats: 60 },
  { title: "Product Design Portfolio Clinic", kind: "seminar", host: "Design Lagos", city: "Lagos", venue: "Ventures Park, Ikoyi", format: "in-person", in_days: 18, hours: 3, description: "Bring two case studies. Six practising designers review them line by line, live. Twelve slots, observers welcome.", tags: ["product design", "portfolio", "career"], price: "₦5,000", seats: 40 },
  { title: "Careers in Data: ask me anything", kind: "story", host: "Data Community Nigeria", city: "Lagos", venue: "Online", format: "virtual", in_days: 4, hours: 2, description: "Three analysts and a hiring manager answer the questions people are afraid to ask in interviews: salary, gaps, switching in.", tags: ["data", "career", "interviews"], price: "Free" },
  { title: "Abuja Public Sector Career Expo", kind: "hiring", host: "Federal Civil Service Commission", city: "Abuja", venue: "International Conference Centre", format: "in-person", in_days: 25, hours: 8, description: "Ministries, agencies and state-owned enterprises with open graduate and experienced roles. Registration closes a week before.", tags: ["government", "graduate", "policy"], price: "Free" },
  { title: "Cloud & DevOps Bootcamp", kind: "training", host: "AWS User Group Lagos", city: "Lagos", venue: "Online", format: "virtual", in_days: 9, hours: 12, description: "Three evenings: containers, CI/CD and cost control on AWS. Includes a lab account and a certificate.", tags: ["aws", "devops", "kubernetes"], price: "₦25,000" },
  { title: "Startup Founders Hiring Night", kind: "meetup", host: "Ventures Park", city: "Lagos", venue: "Ventures Park, Ikoyi", format: "in-person", in_days: 15, hours: 3, description: "Founders pitch the roles they cannot fill, candidates pitch what they can do. Twenty startups, one room, no recruiters.", tags: ["startups", "hiring", "networking"], price: "Free", seats: 120 },
  { title: "Remote Work Readiness Seminar", kind: "seminar", host: "JAMS", city: "Lagos", venue: "Online", format: "virtual", in_days: 2, hours: 2, description: "How remote teams actually screen: async writing tests, timezone questions and the tools they expect you to know.", tags: ["remote", "career", "interviews"], price: "Free", featured: 1 },
  { title: "Women in Tech Mentorship Circle", kind: "meetup", host: "Women in Tech Nigeria", city: "Lagos", venue: "MTN House, Ikoyi", format: "in-person", in_days: 21, hours: 2, description: "Small-group mentoring with engineers, PMs and founders. Apply for a mentor slot or come as a peer.", tags: ["mentorship", "women", "career"], price: "Free", seats: 50 },
  { title: "Graduate Trainee Programme — info session", kind: "ad", host: "Flutterwave", city: "Lagos", venue: "Online", format: "virtual", in_days: 8, hours: 1, description: "The 2027 graduate programme opens applications. Meet the team, hear the assessment stages, ask about relocation.", tags: ["graduate", "fintech", "hiring"], price: "Free" },
  { title: "Customer Success Masterclass", kind: "training", host: "CS Collective", city: "Lagos", venue: "Zoom", format: "virtual", in_days: 30, hours: 3, description: "Retention maths, QBR storytelling and how to run an escalation. Built for people moving from support into success.", tags: ["customer success", "retention", "career"], price: "₦15,000" },
  { title: "Build in Lagos Hack Weekend", kind: "meetup", host: "Co-Creation Hub", city: "Lagos", venue: "Co-Creation Hub, Yaba", format: "in-person", in_days: 11, hours: 30, description: "Two days, teams of four, a civic-tech brief. Hardware and API credits provided; demo night is open to the public.", tags: ["hackathon", "engineering", "design"], price: "Free", seats: 100 },
  { title: "Finance Careers Evening", kind: "seminar", host: "Deloitte Nigeria", city: "Lagos", venue: "Deloitte HQ, Victoria Island", format: "in-person", in_days: 17, hours: 2, description: "Audit, tax and deals partners on what the graduate scheme looks for, and what the first three years actually involve.", tags: ["finance", "graduate", "career"], price: "Free", seats: 80 },
  { title: "Healthcare Hiring Drive", kind: "hiring", host: "Lagoon Hospitals", city: "Lagos", venue: "Lagoon Hospital, Ikeja", format: "in-person", in_days: 20, hours: 5, description: "Nurses, lab scientists and administrators. Bring your licence and two references; interviews run the same day.", tags: ["healthcare", "nursing", "hiring"], price: "Free" },
  { title: "Port Harcourt Energy Jobs Fair", kind: "hiring", host: "Rivers State Employment Bureau", city: "Port Harcourt", venue: "Alfred Diete-Spiff Centre", format: "in-person", in_days: 28, hours: 7, description: "Oil, gas and renewables operators hiring technicians, HSE officers and project engineers across the Niger Delta.", tags: ["engineering (hardware)", "hse", "energy"], price: "Free" },
];

async function seedEvents() {
  const n = await get<{ n: number }>("SELECT COUNT(*) AS n FROM event_listings");
  if (Number(n?.n ?? 0) > 0) return;
  for (const e of EVENT_SEEDS) {
    const start = new Date(Date.now() + e.in_days * 86_400_000);
    start.setHours(9, 0, 0, 0);
    const end = new Date(start.getTime() + e.hours * 3_600_000);
    await run(
      `INSERT INTO event_listings (id, title, kind, host, city, country, venue, format, starts_at, ends_at, description, tags, url, price, seats, featured, demo, created_at)
       VALUES (?, ?, ?, ?, ?, 'Nigeria', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 1, ?)`,
      newId(),
      e.title,
      e.kind,
      e.host,
      e.city,
      e.venue,
      e.format,
      start.toISOString(),
      end.toISOString(),
      e.description,
      JSON.stringify(e.tags),
      e.price,
      e.seats ?? null,
      e.featured ?? 0,
      nowIso()
    );
  }
}

const EVENT_KINDS = ["hiring", "training", "seminar", "story", "meetup", "ad"] as const;

/** Query expansion: “job fair” and “hiring” are the same search. */
const EVENT_SYNONYMS: Record<string, string[]> = {
  hiring: ["hiring", "job fair", "jobs", "recruitment", "career fair", "vacancy"],
  training: ["training", "bootcamp", "workshop", "course", "class", "boot camp"],
  seminar: ["seminar", "talk", "panel", "clinic", "masterclass", "info session"],
  story: ["story", "ama", "fireside", "experience", "journey"],
  meetup: ["meetup", "networking", "community", "circle", "hackathon"],
  ad: ["ad", "programme", "program", "opening", "cohort", "apply"],
};

/**
 * Query expansion, separated from query matching.
 *
 * `words` must all appear for an event to match; `kinds` is the category the
 * query names, and every event of that kind matches. Mixing the two — putting
 * “career” into the same term list as “job fair” — made a search for fairs
 * return every event whose tags happened to say career.
 */
function expandEventQuery(q: string) {
  const low = q.toLowerCase();
  const words = tokenize(q);
  const kinds = new Set<string>();
  const terms = new Set(words);
  for (const [kind, list] of Object.entries(EVENT_SYNONYMS)) {
    if (list.some((phrase) => phrase.includes(low) || low.includes(phrase))) {
      kinds.add(kind);
      for (const w of list.flatMap(tokenize)) terms.add(w);
    }
  }
  return { words, kinds, terms: [...terms] };
}

export async function listEvents(
  userId: string,
  filters: { q?: string; kind?: string; city?: string; format?: string; when?: string; limit?: number } = {}
) {
  await seedEvents();
  const viewer = await viewerContext(userId);
  const rows = await all<any>("SELECT * FROM event_listings");
  const q = String(filters.q ?? "").toLowerCase().trim();
  const expanded = q ? expandEventQuery(q) : { words: [], kinds: new Set<string>(), terms: [] };
  const city = String(filters.city ?? "").toLowerCase().trim();
  const kind = String(filters.kind ?? "").toLowerCase().trim();
  const format = String(filters.format ?? "").toLowerCase().trim();
  const when = String(filters.when ?? "all");
  const now = Date.now();
  const horizon = when === "week" ? 7 : when === "month" ? 31 : Infinity;

  const items = rows
    .map((r) => {
      const tags: string[] = parseJson(r.tags, []);
      const hay = [r.title, r.host, r.description, tags.join(" "), r.city, r.venue].join(" ").toLowerCase();
      const reasons: string[] = [];
      let score = 0;

      if (viewer.city && r.city && r.city.toLowerCase() === viewer.city.toLowerCase()) {
        score += 40;
        reasons.push(`in ${r.city}, where you are`);
      }
      if (viewer.profession) {
        const key = viewer.profession.split(" ")[0];
        if (hay.includes(key) || tags.some((t) => normalizeProfession(t) === viewer.profession)) {
          score += 25;
          reasons.push(`relevant to ${viewer.profession}`);
        }
      }
      if (q) {
        let hits = 0;
        for (const t of expanded.terms) if (hay.includes(t)) hits++;
        score += Math.min(35, hits * 12);
        if (hits) reasons.push(`mentions ${expanded.terms.filter((t) => hay.includes(t)).slice(0, 3).join(", ")}`);
      }
      if (r.featured) {
        score += 12;
        reasons.push("featured");
      }
      if (!r.demo) score += 5;
      const days = Math.max(0, (new Date(r.starts_at).getTime() - now) / 86_400_000);
      score += Math.max(0, 10 - Math.round(days / 3));

      return {
        id: r.id,
        title: r.title,
        kind: r.kind,
        host: r.host,
        city: r.city,
        country: r.country,
        venue: r.venue,
        format: r.format,
        starts_at: r.starts_at,
        ends_at: r.ends_at,
        description: r.description,
        tags,
        url: r.url,
        price: r.price,
        seats: r.seats,
        featured: !!r.featured,
        demo: !!r.demo,
        match: { score: Math.min(100, score), reasons },
        /** searchable text, dropped before the response is serialised */
        hay,
      };
    })
    .filter((e) => {
      // A query is a filter as well as a ranking signal: an expanded “job fair”
      // must not return a design clinic just because it is in Lagos. Either every
      // word in the query appears, or the event is of the category it named.
      if (q) {
        const everyWord = expanded.words.every((w) => e.hay.includes(w));
        if (!everyWord && !expanded.kinds.has(e.kind)) return false;
      }
      if (kind && e.kind !== kind) return false;
      if (city && !String(e.city ?? "").toLowerCase().includes(city)) return false;
      if (format && e.format !== format) return false;
      const start = new Date(e.starts_at).getTime();
      if (start + 86_400_000 < now) return false;
      if (horizon !== Infinity && start - now > horizon * 86_400_000) return false;
      return true;
    })
    .sort((a, b) => b.match.score - a.match.score || a.starts_at.localeCompare(b.starts_at))
    .map(({ hay: _hay, ...event }) => event);

  const facet = (key: "kind" | "city" | "format") => {
    const out: Record<string, number> = {};
    for (const e of items) {
      const v = String(e[key] ?? "—");
      out[v] = (out[v] ?? 0) + 1;
    }
    return out;
  };

  return {
    items: items.slice(0, filters.limit ?? 60),
    total: items.length,
    facets: { kind: facet("kind"), city: facet("city"), format: facet("format") },
    viewer: { city: viewer.city, profession: viewer.profession },
    kinds: EVENT_KINDS,
    demo: items.some((e) => e.demo),
  };
}

/* ──────────────────────────── CV reviews ─────────────────────────────── */

export async function listCvReviews(cvId: string) {
  const rows = await all<any>("SELECT * FROM cv_reviews WHERE cv_id = ? ORDER BY created_at DESC", cvId);
  return summarizeReviews(rows);
}

export function summarizeReviews(rows: any[]) {
  const count = rows.length;
  const avg = count ? Math.round((rows.reduce((n, r) => n + r.rating, 0) / count) * 10) / 10 : null;
  const distribution = [5, 4, 3, 2, 1].map((star) => ({ star, count: rows.filter((r) => r.rating === star).length }));
  return {
    count,
    avg,
    distribution,
    items: rows.map((r) => ({
      id: r.id,
      cv_id: r.cv_id,
      reviewer_name: r.reviewer_name,
      reviewer_role: r.reviewer_role,
      relationship: r.relationship,
      rating: r.rating,
      body: r.body,
      created_at: r.created_at,
    })),
  };
}

export async function publishCv(userId: string, cvId: string, patch: { public?: boolean; copyright?: string | null }) {
  const cv = await get<any>("SELECT * FROM cvs WHERE id = ? AND user_id = ?", cvId, userId);
  if (!cv) throw notFound("CV");
  const sets: string[] = ["updated_at = ?"];
  const args: any[] = [nowIso()];
  if (patch.public !== undefined) {
    sets.push("public = ?");
    args.push(patch.public ? 1 : 0);
  }
  if (patch.copyright !== undefined) {
    sets.push("copyright = ?");
    args.push(patch.copyright ? String(patch.copyright).slice(0, 240) : null);
  }
  await run(`UPDATE cvs SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, ...args, cvId, userId);
  return get("SELECT id, name, public, copyright FROM cvs WHERE id = ?", cvId);
}

export async function addCvReview(
  userId: string,
  cvId: string,
  input: { rating: number; body: string; relationship?: string }
) {
  const cv = await get<any>("SELECT id, user_id, public, name FROM cvs WHERE id = ?", cvId);
  if (!cv) throw notFound("CV");
  if (!cv.public) throw validation("This CV is private, its owner has not published it");
  if (cv.user_id === userId) throw validation("Review someone else's CV, not your own");
  const rating = Math.round(Number(input.rating));
  if (!(rating >= 1 && rating <= 5)) throw validation("Rating must be between 1 and 5");
  const body = String(input.body ?? "").trim();
  if (body.length < 10) throw validation("Write at least a sentence — “nice” does not help anyone");

  const profile = await getProfile(userId);
  const id: any = profile.identity ?? {};
  const name = String(id.name ?? id.full_name ?? "A JAMS member").trim() || "A JAMS member";
  const role = [id.headline, id.location].filter(Boolean).join(" · ") || null;
  const relationship = ["hirer", "recruiter", "mentor", "peer"].includes(String(input.relationship)) ? String(input.relationship) : "peer";

  const existing = await get<any>("SELECT id FROM cv_reviews WHERE cv_id = ? AND reviewer_id = ?", cvId, userId);
  if (existing) {
    await run(
      "UPDATE cv_reviews SET rating = ?, body = ?, relationship = ?, reviewer_name = ?, reviewer_role = ?, created_at = ? WHERE id = ?",
      rating,
      body,
      relationship,
      name,
      role,
      nowIso(),
      existing.id
    );
  } else {
    await run(
      `INSERT INTO cv_reviews (id, cv_id, owner_id, reviewer_id, reviewer_name, reviewer_role, relationship, rating, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId(),
      cvId,
      cv.user_id,
      userId,
      name,
      role,
      relationship,
      rating,
      body,
      nowIso()
    );
  }
  return listCvReviews(cvId);
}

/** Public CVs on the network, newest first — the pool Discover's review modal draws from. */
export async function publicCvFeed(limit = 12) {
  const rows = await all<any>(
    `SELECT c.id, c.name, c.archetype, c.updated_at, c.copyright, p.display_name, p.headline, p.profession
     FROM cvs c JOIN public_profiles p ON p.user_id = c.user_id
     WHERE c.public = 1 AND p.visible = 1 ORDER BY c.updated_at DESC LIMIT ${Math.max(1, Math.min(50, limit))}`
  );
  const allReviews = await all<any>("SELECT cv_id, rating FROM cv_reviews");
  return rows.map((r) => {
    const mine = allReviews.filter((x) => x.cv_id === r.id);
    return {
      ...r,
      reviews: { count: mine.length, avg: mine.length ? Math.round((mine.reduce((n, x) => n + x.rating, 0) / mine.length) * 10) / 10 : null },
    };
  });
}
