/**
 * Pitch composer (§19.1): the text that goes into a pitch/application email.
 *
 * One deterministic pipeline instead of a single hard-coded template:
 *
 *   1. CATEGORY PROFILE   every sector gets its own hooks, value props, proof lines
 *                         and register (a bank is not an NGO).
 *   2. SEEDED SELECTION   a mulberry32 PRNG seeded by company + category + variant
 *                         picks the opener, 3 of 5 value props, the CTA and the
 *                         sign-off, so every Refresh is different but repeatable.
 *   3. GRAMMAR PASSES     article correction, filler removal, sentence-start
 *                         variety, whitespace/punctuation normalisation, active
 *                         voice nudges, repetition penalties.
 *   4. SCORING            readability, personalisation, brevity, politeness and
 *                         impact checks → 0..100 plus per-check detail, so the UI
 *                         can say *why* this wording is the one it shows.
 *
 * Portfolio signal comes from this repository's git history (cached 24h) so the
 * proof line reflects projects actually built here; a static fallback covers
 * deploys where .git is not shipped.
 */
import { execFile } from "node:child_process";

export interface PitchInput {
  kind: "pitch" | "application";
  /** sector key (airline, bank, agriculture …) or career_category */
  category?: string | null;
  company: string;
  role?: string | null;
  city?: string | null;
  contactName?: string | null;
  /** number or string; same seed → same wording */
  seed?: number | string;
}

export interface PitchCheck {
  label: string;
  pass: boolean;
  detail: string;
  weight: number;
}

export interface ComposedPitch {
  subject: string;
  body: string;
  score: number;
  checks: PitchCheck[];
  variant: number;
  category: string;
}

/* --------------------------------- PRNG ----------------------------------- */

/** mulberry32: tiny, fast, deterministic — same seed always yields same wording. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const hashSeed = (...parts: (string | number | null | undefined)[]): number => {
  const s = parts.map((p) => String(p ?? "")).join("|");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

const pick = <T>(rng: () => number, arr: T[]): T => arr[Math.floor(rng() * arr.length) % arr.length];
const sample = <T>(rng: () => number, arr: T[], n: number): T[] => {
  const copy = [...arr];
  const out: T[] = [];
  while (out.length < n && copy.length) out.push(copy.splice(Math.floor(rng() * copy.length), 1)[0]);
  return out;
};

/* ---------------------------- category profiles --------------------------- */

interface Profile {
  /** one-line context: what this kind of company actually runs on */
  context: string[];
  /** candidate value props; three are chosen per variant */
  props: string[];
  /** proof lines relevant to this kind of work */
  proof: string[];
  /** sector vocabulary used in subjects and hooks */
  words: string[];
  /** greeting register */
  formal: boolean;
}

const PROFILES: Record<string, Profile> = {
  bank: {
    context: [
      "reconciliation and back-office work still eats hours every week",
      "manual checks between core banking, cards and agency channels are slow to catch",
      "customers expect instant answers while operations run on spreadsheets",
    ],
    props: [
      "a reconciliation dashboard that flags mismatches before they reach customers",
      "internal tooling with role-based access and a full audit trail",
      "an API layer that connects your core system to the channels you already run",
      "reporting that finance can regenerate without waiting on developers",
      "alerting so a failed batch or stalled transfer is seen in minutes, not days",
    ],
    proof: [
      "audit-grade logging and role-based access built into every screen",
      "typed, tested services where a silent failure is a failing test, not a angry customer",
      "batch jobs with idempotency and replay, so a retry never double-charges",
    ],
    words: ["banking", "reconciliation", "operations"],
    formal: true,
  },
  agriculture: {
    context: [
      "stock, deliveries and output are still tracked on paper and phone calls",
      "seasonal volumes make manual record keeping break at exactly the wrong moment",
      "moving product from depot to buyer involves too many hand-offs to verify",
    ],
    props: [
      "a lightweight inventory view that works on a phone with a weak signal",
      "delivery and dispatch tracking that both the depot and the buyer can trust",
      "weighing, grading and lot records that reconcile without retyping",
      "a simple supplier and buyer ledger with balances anyone can verify",
      "reports for season, depot or product line generated in one click",
    ],
    proof: [
      "offline-tolerant flows designed for low-bandwidth field use",
      "dashboards that turn raw operational rows into decisions for non-technical teams",
      "automation of a repetitive back-office process end to end",
    ],
    words: ["agriculture", "supply", "harvest"],
    formal: false,
  },
  airline: {
    context: [
      "bookings, charter requests and cargo enquiries arrive through too many channels",
      "operations teams reconcile schedules, crews and loads by hand",
      "customers expect an answer now, not after a shift change",
    ],
    props: [
      "a booking and enquiry flow your team controls instead of a third-party form",
      "an operations board for schedules, aircraft and load at a glance",
      "an API that joins your reservation, cargo and support channels",
      "self-serve status answers that cut repetitive calls to the desk",
      "monitoring that surfaces a broken integration before a passenger does",
    ],
    proof: [
      "real-time status surfaces with clear fallbacks when an upstream feed fails",
      "typed integrations across systems that were never designed to talk",
      "search and filtering that stay fast on real operational data",
    ],
    words: ["aviation", "flights", "operations"],
    formal: true,
  },
  port: {
    context: [
      "vessel, terminal and cargo visibility still runs on calls and spreadsheets",
      "agents wait on updates that exist somewhere in the system already",
      "every hand-off between terminal, agent and line is re-keyed",
    ],
    props: [
      "a terminal and cargo visibility board shared with your agents",
      "appointment and berth scheduling that stops the phone-tag",
      "document flow (bills of lading, release notes) without the re-keying",
      "customer self-serve tracking so enquiries answer themselves",
      "alerts when a container, invoice or release stalls",
    ],
    proof: [
      "workflow automation across teams that currently paste data between tools",
      "auditable state changes: who released what, and when",
      "integrations with the systems you already run, not a rip-and-replace",
    ],
    words: ["ports", "terminal", "cargo"],
    formal: true,
  },
  retail: {
    context: [
      "sales, stock and staff rotas live in separate places that never agree",
      "head office finds out about a stock-out after the shelf is empty",
      "supplier orders are placed on gut feel because the numbers are late",
    ],
    props: [
      "a stock view across outlets that updates as sales happen",
      "reorder suggestions built from your own sales history",
      "a supplier and purchase ledger your team can trust",
      "staff rota and shift tooling that replaces the WhatsApp thread",
      "a storefront or booking flow you own end to end",
    ],
    proof: [
      "point-of-sale style data pipelines that keep working when a till goes offline",
      "clear dashboards for people who do not have time to learn a BI tool",
      "automation that gave a small team back a full working day each week",
    ],
    words: ["retail", "stores", "sales"],
    formal: false,
  },
  manufacturing: {
    context: [
      "production, orders and maintenance are recorded in books that lag reality",
      "downtime is discovered after the line has already stopped",
      "quotes and orders are re-typed between the workshop and the office",
    ],
    props: [
      "a production and order board that reflects the floor in real time",
      "maintenance scheduling with history anyone can look up",
      "quoting and job cards that move from request to invoice without retyping",
      "inventory and raw-material tracking tied to actual output",
      "quality checks recorded at the station, not reconstructed later",
    ],
    proof: [
      "event-driven updates from machines or forms into one operational view",
      "replacing a manual spreadsheet process with a tested, auditable workflow",
      "tooling built for the people wearing gloves, not just the office",
    ],
    words: ["manufacturing", "production", "industry"],
    formal: false,
  },
  laboratory: {
    context: [
      "samples, results and turnaround times are tracked across books and inboxes",
      "clients chase reports that the lab has already produced",
      "quality and accreditation evidence is assembled by hand",
    ],
    props: [
      "a sample tracker from intake to released result",
      "client portals for report delivery and status",
      "turnaround and workload reporting without spreadsheet archaeology",
      "instrument and reagent logs kept with the record they belong to",
      "audit-ready exports for accreditation reviews",
    ],
    proof: [
      "validated workflows where every state change is attributable",
      "structured data entry that prevents the error before it is stored",
      "clear provenance: which analyst, which instrument, which version",
    ],
    words: ["laboratory", "testing", "quality"],
    formal: true,
  },
  government: {
    context: [
      "citizen requests and internal approvals move on paper and email",
      "data needed for a report sits in five offices and four formats",
      "constituents wait because nobody can see where their request is",
    ],
    props: [
      "a request and approval workflow with visible status at every step",
      "a records register that is searchable instead of archived",
      "dashboards for budget, project and service delivery",
      "open data publishing from the systems you already maintain",
      "citizen-facing forms that work on low-end phones",
    ],
    proof: [
      "role-based access and full audit history on every action",
      "accessible, low-bandwidth interfaces for a general audience",
      "migrations from paper processes without losing the existing records",
    ],
    words: ["public sector", "services", "records"],
    formal: true,
  },
  humanitarian: {
    context: [
      "programme data is collected in the field and consolidated by hand",
      "donor reporting eats days that should go to the programme",
      "beneficiary records live in spreadsheets that cannot be reconciled",
    ],
    props: [
      "field data capture that works offline and syncs when signal returns",
      "a beneficiary and distribution register that reconciles across sites",
      "donor-ready reports generated from live programme data",
      "case management with the history and consent trail intact",
      "monitoring dashboards for the whole programme in one place",
    ],
    proof: [
      "offline-first tools designed for unreliable connectivity",
      "data pipelines that survive messy, partially filled field submissions",
      "privacy-aware records with consent and access controls",
    ],
    words: ["humanitarian", "programmes", "aid"],
    formal: true,
  },
  fuel: {
    context: [
      "deliveries, depots and stock are reconciled from driver calls and paper",
      "pricing and dispatch change faster than the records do",
      "product loss is found at month end, when it is already too late",
    ],
    props: [
      "delivery and dispatch tracking from loading to drop-off",
      "tank and depot stock that matches the meter, not the memory",
      "driver, waybill and proof-of-delivery captured on the phone",
      "pricing and margin reporting per product and per site",
      "reconciliation alerts for variance, loss and stalled loads",
    ],
    proof: [
      "operational tooling built for high-volume, time-sensitive transactions",
      "tolerance rules and alerts tuned to how the operation actually behaves",
      "audit trails that make month-end reconciliation a lookup, not a hunt",
    ],
    words: ["fuel", "energy", "distribution"],
    formal: false,
  },
  transporter: {
    context: [
      "jobs are dispatched over calls and tracked in a notebook",
      "customers ask for status the system could answer instantly",
      "vehicles, drivers and loads meet on a whiteboard",
    ],
    props: [
      "job dispatch and driver assignment your coordinator can run in one screen",
      "live status your customers can check instead of calling",
      "vehicle and driver records with documents and expiry reminders",
      "waybills and proof of delivery captured at the gate",
      "cost-per-route reporting from the trips you already run",
    ],
    proof: [
      "map and route views that stay responsive on real fleet sizes",
      "event streams from drivers and depots into one operational board",
      "simple tools a dispatcher learns in an afternoon",
    ],
    words: ["transport", "fleet", "logistics"],
    formal: false,
  },
  railway: {
    context: [
      "maintenance, assets and movements are recorded in separate registers",
      "planning happens on top of data nobody fully trusts",
      "incidents are reconstructed after the fact from messages",
    ],
    props: [
      "asset and maintenance registers linked to the actual work orders",
      "movement and schedule visibility across depots",
      "incident capture at the time, with the evidence attached",
      "planning dashboards built on data that reconciles",
      "document control for procedures and compliance records",
    ],
    proof: [
      "long-lived records with versioning and clear ownership",
      "operational views designed around safety and compliance reviews",
      "integrations that respect the systems already certified",
    ],
    words: ["rail", "assets", "operations"],
    formal: true,
  },
  waste: {
    context: [
      "collections, routes and bins are coordinated by phone",
      "invoices are disputed because the collection record is thin",
      "compliance evidence is assembled manually for every audit",
    ],
    props: [
      "route and collection capture at the kerbside, on a phone",
      "bin and site inspections logged with photos in the record",
      "customer accounts with collection history that settles disputes",
      "weighbridge and tonnage reporting for compliance",
      "billing built from completed collections, not memory",
    ],
    proof: [
      "field-first capture that works with gloves and poor signal",
      "reconciliation between operational events and invoices",
      "reports shaped to the regulator's questions, not a generic template",
    ],
    words: ["waste", "collections", "compliance"],
    formal: false,
  },
  supplier: {
    context: [
      "orders, quotes and stock levels live in a spreadsheet nobody trusts",
      "customers chase orders that were confirmed by phone weeks ago",
      "pricing differs per customer and nobody can prove why",
    ],
    props: [
      "a catalogue and order flow with customer-specific pricing",
      "stock and purchase ordering that reflects reality",
      "quotes that become invoices without being retyped",
      "delivery status your customers can check themselves",
      "sales and margin reporting per customer and per line",
    ],
    proof: [
      "order pipelines with clear states, from quote through delivery",
      "role-aware pricing and approval rules encoded once, enforced everywhere",
      "dashboards that answer \"what moved this week\" in one screen",
    ],
    words: ["supply", "distribution", "orders"],
    formal: false,
  },
  services: {
    context: [
      "bookings, requests and team workload arrive through inboxes",
      "clients cannot see the status of what they asked for",
      "scheduling and follow-up depend on someone remembering",
    ],
    props: [
      "a request and booking flow with status the client can see",
      "scheduling and workload views for the whole team",
      "invoicing and follow-up triggered by the work actually done",
      "a knowledge base so the same question is answered once",
      "automation of the repetitive admin between your existing tools",
    ],
    proof: [
      "workflow engines that encode a process once and run it reliably",
      "client-facing portals that cut inbound status calls",
      "integrations that remove the copy-paste between two systems",
    ],
    words: ["services", "clients", "operations"],
    formal: false,
  },
  tech: {
    context: [
      "internal tools lag behind the product and slow the team down",
      "manual processes still sit between the customer and the system",
      "data lives in enough places that nobody trusts a single number",
    ],
    props: [
      "an internal tool that removes a daily manual workflow",
      "an API integration between the systems you already pay for",
      "a dashboard that answers the question your team asks every morning",
      "automation with monitoring, so failures surface instead of hiding",
      "a customer-facing flow your team can change without a release cycle",
    ],
    proof: [
      "typed, tested product surfaces shipped end to end",
      "automation that gave a team back hours every week",
      "monitoring and alerts wired in from day one",
    ],
    words: ["software", "product", "engineering"],
    formal: false,
  },
};

const CATEGORY_ALIASES: [RegExp, string][] = [
  [/bank|fintech|financ|payment|insurance|credit|invest/i, "bank"],
  [/agri|farm|mill|food|harvest|crop|poultry/i, "agriculture"],
  [/airline|aviation|airport|aero/i, "airline"],
  [/port|shipping|marin|terminal|cargo|freight|sea/i, "port"],
  [/retail|supermarket|shop|store|grocer|market|wholesale|distribut|supplier|commerce/i, "retail"],
  [/manufact|factor|industr|construct|produc/i, "manufacturing"],
  [/lab|clinic|hospital|health|medic|pharma|diagnos|quality test/i, "laboratory"],
  [/govern|public sector|municip|ministr|agency of state|civil/i, "government"],
  [/humanit|ngo|aid|relief|charity|donor|un |unicef|red cross/i, "humanitarian"],
  [/fuel|petrol|diesel|energ|oil ?& ?gas|gas station/i, "fuel"],
  [/transport|logistic|fleet|haulage|courier|delivery|driver|taxi/i, "transporter"],
  [/rail|train|depot/i, "railway"],
  [/waste|recycl|sanitat|refuse/i, "waste"],
  [/telecom|network|isp|software|engineer|developer|technology|data |product|saas|startup/i, "tech"],
  [/airport|aerodrome/i, "airline"],
  [/company|office|manufacturing/i, "manufacturing"],
];

export function resolveProfile(category?: string | null, role?: string | null): { key: string; profile: Profile } {
  const hay = `${category ?? ""} ${role ?? ""}`;
  const hit = CATEGORY_ALIASES.find(([re]) => re.test(hay));
  const key = hit ? hit[1] : category ? "tech" : "tech";
  return { key, profile: PROFILES[key] ?? PROFILES.tech };
}

/* ------------------------- portfolio from git history --------------------- */

let portfolioCache: { at: number; items: string[] } | null = null;
const PORTFOLIO_TTL = 24 * 60 * 60 * 1000;

const KNOWN_TECH = [
  "react", "next.js", "nextjs", "typescript", "javascript", "node", "python", "fastapi", "django", "flask",
  "postgres", "sqlite", "mysql", "docker", "vercel", "cloud", "rest api", "graphql", "auth", "jwt",
  "dashboard", "analytics", "automation", "scraping", "crawler", "browser extension", "autofill", "cv",
  "ats", "matching", "job tracker", "email", "smtp", "outreach", "payment", "api", "web app", "cli",
  "test", "ci", "schema", "search", "indexing", "export", "csv", "pdf", "resume",
];

/**
 * What has actually been built in this workspace, from `git log`. Cached for a day,
 * static fallback when .git is absent (serverless deploys ship no history).
 */
export async function portfolioSignals(): Promise<string[]> {
  if (portfolioCache && Date.now() - portfolioCache.at < PORTFOLIO_TTL) return portfolioCache.items;
  try {
    const subjects = await new Promise<string[]>((resolve, reject) => {
      execFile("git", ["log", "--pretty=%s", "-n", "300"], { timeout: 6000, cwd: process.cwd(), windowsHide: true }, (err, stdout) =>
        err ? reject(err) : resolve(String(stdout).split("\n"))
      );
    });
    const counts = new Map<string, number>();
    for (const s of subjects) {
      const low = s.toLowerCase();
      for (const t of KNOWN_TECH) if (low.includes(t)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const items = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([t]) => t);
    if (items.length >= 3) {
      portfolioCache = { at: Date.now(), items };
      return items;
    }
  } catch {
    /* no git on the host */
  }
  const fallback = ["typed APIs", "automation tooling", "data dashboards"];
  portfolioCache = { at: Date.now(), items: fallback };
  return fallback;
}

/* ------------------------------ grammar passes ---------------------------- */

const FILLERS = /\b(very|really|quite|basically|actually|literally|hopefully|maybe|just|simply|somewhat|rather|kind of|sort of)\s+/gi;
const PASSIVE = /\b(is|are|was|were|be|been|being)\s+\w+ed\s+(by|to)\b/gi;

/** Words that start with a vowel letter but a consonant sound (a university, not an university). */
const CONSONANT_SOUND = /^(university|union|user|usage|unit|unique|uniform|one|once|european|useful|usual|unicorn|utility|eulogy)/i;
/** Words that start with a consonant letter but a vowel sound (an hour, not a hour). */
const VOWEL_SOUND = /^(hour|honest|honor|honour|heir|herb|historic)/i;

/** a/an is chosen by the following word's first *sound*, not its first letter. */
export const fixArticles = (s: string): string =>
  s
    .replace(/\ban\s+([a-z]+)/gi, (m, w) => (/^[bcdfgjklmnpqrstvwxyz]/i.test(w) && !VOWEL_SOUND.test(w) ? `a ${w}` : m))
    .replace(/\ba\s+([a-z]+)/gi, (m, w) =>
      ((/^[aeiou]/i.test(w) && !CONSONANT_SOUND.test(w)) || VOWEL_SOUND.test(w)) ? `an ${w}` : m
    );

/** "is a a message" → "is a message", before the article pass runs. */
const dedupeWords = (s: string): string => s.replace(/\b([a-z]+)\s+\1\b/gi, (_m, w) => w);

const capitalizeSentences = (s: string): string =>
  s.replace(/(^|[.!?]\s+|\n)([a-z])/g, (_m, pre, c) => pre + c.toUpperCase());

/** Two adjacent sentences should not start with the same word. */
const varyOpeners = (sentences: string[]): string[] => {
  for (let i = 1; i < sentences.length; i++) {
    const prev = (sentences[i - 1].match(/^[\"\']?([A-Za-z]+)/) ?? [])[1]?.toLowerCase();
    const cur = (sentences[i].match(/^[\"\']?([A-Za-z]+)/) ?? [])[1]?.toLowerCase();
    if (prev && prev === cur) {
      const alternatives = ["Second,", "Separately,", "Just as importantly,", "On top of that,", "Alongside that,"];
      sentences[i] = `${alternatives[i % alternatives.length]} ${sentences[i].charAt(0).toLowerCase()}${sentences[i].slice(1)}`;
    }
  }
  return sentences;
};

/** Final normalisation: spacing, punctuation, capitalisation, filler words.
 *  `{{merge.token}}` placeholders are masked first: the punctuation pass would
 *  otherwise turn `{{profile.first_name}}` into `{{profile. first_name}}` and the
 *  template merge would leave that literal text in the email. */
export function polish(text: string): string {
  const tokens: string[] = [];
  const masked = text.replace(/\{\{[^{}]+\}\}/g, (m) => {
    tokens.push(m);
    return `\u0000${tokens.length - 1}\u0000`;
  });
  let out = masked
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(FILLERS, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([,.;:])([A-Za-z])/g, "$1 $2")
    .replace(/ {2,}/g, " ")
    .trim();
  // sentence-level passes on the prose (blank lines separate blocks)
  out = out
    .split("\n")
    .map((line) => {
      if (!line.trim() || /^\s*[-•]/.test(line)) return line; // bullets keep their shape
      const sentences = line.split(/(?<=[.!?])\s+/).filter(Boolean);
      const varied = varyOpeners(sentences).map((s) => fixArticles(dedupeWords(s)));
      return capitalizeSentences(varied.join(" "));
    })
    .join("\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  // no doubled words anywhere ("the the", "a a")
  out = out.replace(/\b([a-z]+)\s+\1\b/gi, (_m, w) => w);
  return out
    .trim()
    .replace(/\u0000(\d+)\u0000/g, (_m, i) => tokens[Number(i)] ?? "");
}

/* --------------------------------- scoring -------------------------------- */

/** Readability + impact audit of a composed message. Deterministic, pure. */
export function scorePitch(body: string, input: Pick<PitchInput, "company" | "role" | "category" | "kind">): { score: number; checks: PitchCheck[] } {
  const text = body.trim();
  const words = text.split(/\s+/).filter(Boolean);
  const sentences = text.split(/[.!?]+(\s|$)/).map((s) => s.trim()).filter((s) => s.split(/\s+/).length > 1);
  const lower = text.toLowerCase();
  const company = (input.company ?? "").toLowerCase().split(/\s+/)[0] ?? "";
  const checks: PitchCheck[] = [];

  const wordCount = words.length;
  checks.push({ label: "Brevity", pass: wordCount >= 70 && wordCount <= 240, detail: `${wordCount} words (aim 70–240)`, weight: 14 });

  const avgSentence = sentences.length ? wordCount / sentences.length : wordCount;
  checks.push({ label: "Sentence rhythm", pass: avgSentence >= 6 && avgSentence <= 22, detail: `${avgSentence.toFixed(1)} words per sentence`, weight: 12 });

  const unique = new Set(words.map((w) => w.toLowerCase().replace(/[^a-z]/g, ""))).size;
  const variety = wordCount ? unique / wordCount : 0;
  checks.push({ label: "Word variety", pass: variety > 0.55, detail: `${Math.round(variety * 100)}% unique words`, weight: 10 });

  const fillers = (text.match(FILLERS) ?? []).length;
  checks.push({ label: "No filler", pass: fillers === 0, detail: fillers ? `${fillers} filler words removed/remaining` : "clean of hedges", weight: 10 });

  const personalised = !!company && lower.includes(company);
  checks.push({ label: "Personalised", pass: personalised, detail: personalised ? `mentions ${input.company}` : "company not named", weight: 16 });

  const youCount = (lower.match(/\byou\b|\byour\b/g) ?? []).length;
  checks.push({ label: "Reader-focused", pass: youCount >= 3, detail: `${youCount} “you/your” references`, weight: 12 });

  const passive = (text.match(PASSIVE) ?? []).length;
  checks.push({ label: "Active voice", pass: passive <= 2, detail: `${passive} passive constructions`, weight: 8 });

  const hasGreeting = /^(hi|hello|dear|hey|good (morning|afternoon))\b/i.test(text.trim());
  checks.push({ label: "Opens with a greeting", pass: hasGreeting, detail: hasGreeting ? "greeting present" : "missing greeting", weight: 8 });

  const hasCta = /(reply|let me know|happy to|glad to|would you be open|send over|share|call|walk you|proposal|next step)/i.test(text);
  checks.push({ label: "Clear next step", pass: hasCta, detail: hasCta ? "asks for a next step" : "no call to action", weight: 12 });

  const signsOff = /(best regards|kind regards|regards|sincerely|thanks and|thank you,?$)/im.test(text);
  checks.push({ label: "Closes properly", pass: signsOff, detail: signsOff ? "sign-off present" : "missing sign-off", weight: 6 });

  const score = Math.round(
    checks.reduce((sum, c) => sum + (c.pass ? c.weight : 0), 0) / checks.reduce((sum, c) => sum + c.weight, 0) * 100
  );
  return { score, checks };
}

/* -------------------------------- composing ------------------------------- */

const GREETINGS_FORMAL = ["Dear {{company}} team,", "Hello {{company}} team,", "Good day {{company}} team,"];
const GREETINGS_CASUAL = ["Hi {{company}} team,", "Hello {{company}} team,", "Hey {{company}} team,"];
const SIGNOFFS_FORMAL = ["Kind regards,", "Best regards,", "Yours sincerely,"];
const SIGNOFFS_CASUAL = ["Best,", "Kind regards,", "Thanks,"];

const CTAS = [
  "If this is useful, I am happy to send a short proposal for one concrete improvement you could make this month.",
  "If it fits, reply here and I will send a one-page plan for the first piece of work.",
  "Either way, I would be glad to hear what is already on your roadmap for this year.",
  "Open to a short call this week if that is easier; I can show a working example rather than a deck.",
  "If someone else owns this, a pointer in their direction is just as helpful. Thank you.",
];

const APPLICATION_CTAS = [
  "My CV is attached; I would welcome a short conversation about the role this week.",
  "I have attached my CV and would be glad to walk through the most relevant project on a call.",
  "Happy to provide samples or do a short working session if that helps you decide.",
];

const SUBJECT_PITCH = [
  "{{company}} x {{focus}}",
  "A concrete build idea for {{company}}",
  "{{company}}: software help, one month in",
  "Quick idea for {{company}}'s {{word}} operations",
  "{{company}} and a small piece of software I would take on",
];

const SUBJECT_APPLICATION = ["Application: {{role}}", "{{role}}: {{company}}", "Interest in the {{role}} position"];

/** Replace {{token}} only when the value exists; leave nothing looking unfinished. */
const fill = (template: string, vars: Record<string, string>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_m, key) => vars[key] ?? "");

/**
 * Compose the email. Same inputs (including seed) always produce the same text;
 * bumping the seed is what the Refresh button does.
 */
export async function composePitch(input: PitchInput): Promise<ComposedPitch> {
  const { key, profile } = resolveProfile(input.category, input.role);
  const variant = Math.abs(typeof input.seed === "number" ? input.seed : hashSeed(input.seed ?? 0)) % 1_000_000;
  const rng = mulberry32(hashSeed(input.company, key, variant, input.role ?? ""));
  const portfolio = await portfolioSignals();

  const company = (input.company ?? "your team").trim();
  const city = input.city && input.city !== "Nigeria" ? input.city : null;
  const focus = input.role ?? profile.words[0];
  const vars = {
    company,
    focus,
    role: input.role ?? "the role",
    word: pick(rng, profile.words),
    city: city ?? "Lagos",
  };

  const formal = profile.formal;
  const greeting = input.contactName
    ? `Dear ${input.contactName.split(" ")[0]},`
    : fill(pick(rng, formal ? GREETINGS_FORMAL : GREETINGS_CASUAL), vars);

  const chosenProps = sample(rng, profile.props, 3);
  const proof = pick(rng, [...profile.proof, ...profile.proof]);
  const portfolioLine = sample(rng, portfolio, 2).join(" and ");
  const cta = input.kind === "application" ? pick(rng, APPLICATION_CTAS) : pick(rng, CTAS);

  // sentences, assembled then polished: the passes below fix articles, fillers,
  // repeated openers, spacing and capitalisation across the whole message.
  const opener = input.kind === "application"
    ? [
        `I am applying for the ${vars.role} and wanted to introduce myself directly rather than only through the form.`,
        `I saw the ${vars.role} opening and am writing to make sure my application reaches a person.`,
      ][Math.floor(rng() * 2)]
    : [
        `I came across ${company} and wanted to introduce myself directly, since I did not see an open engineering role on your careers page.`,
        `I have been following ${company} and wanted to reach out directly about work I could take on.`,
        `Most teams like yours get approached with a generic deck; this is a specific one for ${company}.`,
      ][Math.floor(rng() * 3)];

  const context = `${city ? `${city} is where much of this work happens, and ` : ""}${pick(rng, profile.context)}.`;

  const proofSentence = input.kind === "application"
    ? `On the practical side: ${proof}, and most recently ${portfolioLine}.`
    : `Why this is credible: ${proof}. Recent work here includes ${portfolioLine}.`;

  const bullets = chosenProps.map((p) => `- ${p}`);
  const signoff = pick(rng, formal ? SIGNOFFS_FORMAL : SIGNOFFS_CASUAL);

  const subjectTemplate = input.kind === "application" ? pick(rng, SUBJECT_APPLICATION) : pick(rng, SUBJECT_PITCH);
  const subject = fill(subjectTemplate, vars).replace(/\s+—\s+$/g, "").slice(0, 120);

  const body = polish(
    [
      greeting,
      "",
      opener,
      "",
      context,
      "",
      `I am a software engineer who builds typed, well-tested product surfaces end to end: web apps, APIs and the automation that removes manual work. For ${company} specifically, I would start with:`,
      "",
      ...bullets,
      "",
      proofSentence,
      "",
      cta,
      "",
      `${signoff}`,
      `{{profile.first_name}} {{profile.last_name}}`,
    ].join("\n")
  );

  const { score, checks } = scorePitch(body, input);
  return { subject, body, score, checks, variant, category: key };
}
