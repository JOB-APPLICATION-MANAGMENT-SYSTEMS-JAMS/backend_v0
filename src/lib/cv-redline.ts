/**
 * The redline pass: what a recruiter would strike out, and what they would write
 * in its place.
 *
 * A CV is read by two audiences — a parser that looks for structure and keywords,
 * and a person who decides in seven seconds. Most weak bullets fail both for the
 * same reasons: a weak opener ("Responsible for…"), the passive voice, first
 * person, filler words, a missing figure. Those are mechanical enough to detect
 * deterministically, which is why this lives beside the document model instead of
 * behind a model call: the same CV always produces the same redlines, they print
 * no differently on two machines, and the editor can show them instantly.
 *
 * Every rewrite is a *suggestion*. Nothing is applied automatically — the editor
 * renders `del`/`ins` and the user keeps what is true.
 */
import type { CvDoc, CvLine } from "./cv-document";

export type RedlineRule =
  | "weak-verb"
  | "passive"
  | "first-person"
  | "filler"
  | "grammar"
  | "duplicate"
  | "no-figure"
  | "too-long"
  | "keyword";

export type RedlineEdit = {
  id: string;
  section: string;
  kind: "replace" | "add";
  /** the printed line this edit is about; empty for a pure insertion */
  before: string;
  /** the rewrite (kind "replace") or the text to insert (kind "add") */
  after: string;
  reason: string;
  rule: RedlineRule;
  severity: "important" | "polish";
};

/** What the document renderer needs: the replacement text and the rule that made it. */
export type RedlineMark = { after: string; rule: RedlineRule; note?: string };

export type RedlineReport = {
  edits: RedlineEdit[];
  markup: Record<string, RedlineMark>;
  counts: { replace: number; add: number; important: number; polish: number };
  /** 100 = nothing mechanical left to fix */
  hygiene: number;
  summary: string;
  by_rule: { rule: RedlineRule; count: number; label: string }[];
};

const RULE_LABEL: Record<RedlineRule, string> = {
  "weak-verb": "Weak opener",
  passive: "Passive voice",
  "first-person": "First person",
  filler: "Filler / wordy",
  grammar: "Grammar",
  duplicate: "Repeated word",
  "no-figure": "No figure",
  "too-long": "Too long",
  keyword: "Missing keyword",
};

/** Openers that describe a job description instead of an achievement. */
const WEAK_OPENERS: { re: RegExp; replacement: string; why: string }[] = [
  { re: /^responsible for\s+/i, replacement: "", why: "“Responsible for” says the role existed, not what changed" },
  { re: /^worked on\s+/i, replacement: "Delivered ", why: "“Worked on” hides whether it shipped" },
  { re: /^worked (?:with|as)\s+/i, replacement: "Partnered with ", why: "Name the outcome, not the proximity" },
  { re: /^(?:helped|assisted)(?:\s+(?:with|to|in))?\s+/i, replacement: "Supported ", why: "“Helped” leaves your own contribution unclear" },
  { re: /^involved in\s+/i, replacement: "Contributed to ", why: "Say what you contributed" },
  { re: /^tasked with\s+/i, replacement: "Owned ", why: "Ownership reads stronger than assignment" },
  { re: /^duties included\s+/i, replacement: "Owned ", why: "A duty list is not an achievement" },
  { re: /^participated in\s+/i, replacement: "Contributed to ", why: "Participation is not impact" },
  { re: /^was responsible for\s+/i, replacement: "Owned ", why: "Passive framing of an active job" },
  { re: /^proven ability to\s+/i, replacement: "", why: "A claim about yourself, not evidence" },
  { re: /^experience (?:in|with)\s+/i, replacement: "", why: "Show the experience instead of naming it" },
];

/** -ing → past tense, for the verb left behind once a weak opener is removed. */
const GERUND: Record<string, string> = {
  managing: "Managed",
  building: "Built",
  leading: "Led",
  developing: "Developed",
  designing: "Designed",
  maintaining: "Maintained",
  creating: "Created",
  implementing: "Implemented",
  running: "Ran",
  writing: "Wrote",
  testing: "Tested",
  deploying: "Deployed",
  supporting: "Supported",
  mentoring: "Mentored",
  reviewing: "Reviewed",
  coordinating: "Coordinated",
  delivering: "Delivered",
  improving: "Improved",
  automating: "Automated",
  migrating: "Migrated",
  teaching: "Taught",
  analyzing: "Analyzed",
  analysing: "Analysed",
  training: "Trained",
  hiring: "Hired",
  owning: "Owned",
  driving: "Led",
  overseeing: "Oversaw",
  establishing: "Established",
  launching: "Launched",
  scaling: "Scaled",
  reducing: "Reduced",
  increasing: "Increased",
  processing: "Processed",
  handling: "Handled",
  organizing: "Organized",
  organising: "Organised",
  scheduling: "Scheduled",
  reporting: "Reported",
  presenting: "Presented",
  negotiating: "Negotiated",
  onboarding: "Onboarded",
};

/** Word-level corrections, applied inside a line rather than as a rewrite. */
const WORD_FIXES: { re: RegExp; to: string; why: string }[] = [
  { re: /\bin order to\b/gi, to: "to", why: "“in order to” → “to”" },
  { re: /\butili[sz]e\b/gi, to: "use", why: "“utilize” → “use”" },
  { re: /\butili[sz]ed\b/gi, to: "used", why: "“utilized” → “used”" },
  { re: /\butili[sz]ing\b/gi, to: "using", why: "“utilizing” → “using”" },
  { re: /\bleverag(?:e|es)\b/gi, to: "use", why: "“leverage” → “use”" },
  { re: /\bleveraged\b/gi, to: "used", why: "“leveraged” → “used”" },
  { re: /\bleveraging\b/gi, to: "using", why: "“leveraging” → “using”" },
  { re: /\bspearhead(?:ed|ing|s)?\b/gi, to: "led", why: "“spearheaded” → “led”" },
  { re: /\ba total of\b/gi, to: "", why: "“a total of” adds nothing" },
  { re: /\bvarious\b\s*/gi, to: "", why: "“various” is not a quantity" },
  { re: /\bsuccessfully\b\s*/gi, to: "", why: "“successfully” is assumed" },
  { re: /\b(?:very|really|basically|actually|simply)\b\s*/gi, to: "", why: "Intensifiers weaken a line" },
  { re: /\bresponsible for\b/gi, to: "owned", why: "Mid-sentence “responsible for” → “owned”" },
  { re: /\bassisted with\b/gi, to: "supported", why: "“assisted with” → “supported”" },
  { re: /\bworked closely with\b/gi, to: "partnered with", why: "Tighter phrasing" },
  { re: /\bon a daily basis\b/gi, to: "daily", why: "Three words for one" },
  { re: /\bdue to the fact that\b/gi, to: "because", why: "Five words for “because”" },
  { re: /\bat this point in time\b/gi, to: "now", why: "Four words for “now”" },
  { re: /\bteam player\b/gi, to: "collaborator", why: "Show collaboration, don't claim it" },
];

const SPELLING: Record<string, string> = {
  recieve: "receive",
  recieved: "received",
  seperate: "separate",
  seperated: "separated",
  definately: "definitely",
  occured: "occurred",
  succesful: "successful",
  sucessful: "successful",
  managment: "management",
  acheive: "achieve",
  acheived: "achieved",
  responsibilty: "responsibility",
  enviroment: "environment",
  goverment: "government",
  buisness: "business",
  perfomance: "performance",
  colaborate: "collaborate",
  colaboration: "collaboration",
  comunication: "communication",
  implementaion: "implementation",
  maintainance: "maintenance",
  dependant: "dependent",
  liason: "liaison",
  publically: "publicly",
  arguement: "argument",
  experiance: "experience",
  knowlege: "knowledge",
  sucess: "success",
};

const FIGURE = /(\d|%|\bper cent\b|[$€£₦])/;
const PASSIVE = /^(?:was|were|been|is|are|being)\s+([a-z]+(?:ed|en|wn|ne|lt|ght))\b/i;
const FIRST_PERSON = /^(?:i|we)\s+/i;
const LONG_LINE = 210;

const capitalise = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const cleanup = (s: string) => s.replace(/\s{2,}/g, " ").replace(/\s+([,.;:])/g, "$1").trim();

/** Apply the word-level fixes and the small grammar rules; returns the rewrite and its reasons. */
export function polish(line: string): { text: string; reasons: { rule: RedlineRule; why: string }[] } {
  const reasons: { rule: RedlineRule; why: string }[] = [];
  let text = String(line ?? "").replace(/\s+/g, " ").trim();
  if (!text) return { text, reasons };

  // spelling first: later rules match on the corrected words
  const misspelled = text.replace(/\b([a-zA-Z]+)\b/g, (w) => SPELLING[w.toLowerCase()] ?? w);
  if (misspelled !== text) {
    reasons.push({ rule: "grammar", why: "Spelling: " + [...text.matchAll(/\b([a-zA-Z]+)\b/g)].map((m) => m[1]).filter((w) => SPELLING[w.toLowerCase()]).slice(0, 2).join(", ") });
    text = misspelled;
  }

  // first person at the start: "I built X" → "Built X"
  if (FIRST_PERSON.test(text)) {
    text = capitalise(text.replace(FIRST_PERSON, ""));
    reasons.push({ rule: "first-person", why: "A CV is already about you — drop “I/we”" });
  }

  // repeated word: "the the"
  const dup = text.match(/\b(\w+)\s+\1\b/i);
  if (dup) {
    text = text.replace(/\b(\w+)\s+\1\b/gi, "$1");
    reasons.push({ rule: "duplicate", why: `Repeated word: “${dup[1]}”` });
  }

  // weak opener, including the leftover verb
  for (const w of WEAK_OPENERS) {
    if (!w.re.test(text)) continue;
    const rest = text.replace(w.re, "");
    const [first, ...tail] = rest.split(" ");
    const verb = GERUND[first?.toLowerCase() ?? ""] ?? "";
    // With a replacement prefix the rest stays a phrase ("Delivered the
    // checkout rewrite"); without one, the leftover gerund becomes the verb.
    text = cleanup(w.replacement ? `${w.replacement}${rest}` : `${verb || capitalise(first ?? "")} ${tail.join(" ")}`);
    reasons.push({ rule: "weak-verb", why: w.why });
    break;
  }

  // passive voice at the start of the bullet
  const passive = text.match(PASSIVE);
  if (passive) {
    text = cleanup(capitalise(text.replace(PASSIVE, (_m, verb: string) => verb)));
    reasons.push({ rule: "passive", why: `“was/were ${passive[1]}” → “${passive[1]}”` });
  }

  // filler and wordy phrases
  const fillerHits: string[] = [];
  for (const f of WORD_FIXES) {
    if (!f.re.test(text)) continue;
    f.re.lastIndex = 0;
    text = text.replace(f.re, f.to);
    fillerHits.push(f.why);
    f.re.lastIndex = 0;
  }
  if (fillerHits.length) reasons.push({ rule: "filler", why: fillerHits.slice(0, 2).join("; ") });

  // a/an agreement, avoiding the words that only look like vowels
  const vowelExceptions = /^(university|universities|user|users|unique|unit|one|once|european|ubiquitous)/i;
  text = text.replace(/\ba\s+([\w'-]+)/gi, (m, word: string) => (/^[aeiou]/i.test(word) && !vowelExceptions.test(word) ? `an ${word}` : m));
  text = text.replace(/\ban\s+([\w'-]+)/gi, (m, word: string) => (/^[bcdfgjklmnpqrstvwxyz]/i.test(word) && !/^hour|^honest|^honour|^honor/i.test(word) ? `a ${word}` : m));

  // spacing, duplicated punctuation, capital after a full stop
  const before = text;
  text = cleanup(text)
    .replace(/\.{2,}/g, ".")
    .replace(/,\s*,/g, ",")
    .replace(/([.!?])\s+([a-z])/g, (_m, p: string, c: string) => `${p} ${c.toUpperCase()}`);
  if (text !== before && !reasons.some((r) => r.rule === "grammar")) {
    reasons.push({ rule: "grammar", why: "Tidied spacing and punctuation" });
  }

  if (text && text !== line.trim()) text = capitalise(text);
  return { text, reasons };
}

/** Bullets that are already strong get no edit; short labels like “BSc, CS” are left alone. */
function worthRewriting(text: string) {
  const t = text.trim();
  if (t.length < 24) return false;
  // a line that is only a list of technologies is a skills row, not prose
  return t.split(/\s+/).length >= 4;
}

export type RedlineInput = {
  doc: CvDoc;
  missingKeywords?: string[];
  max?: number;
};

/**
 * Scan the printed document. `markup` is keyed by the exact printed line so the
 * renderer can find it without a second copy of the rules.
 */
export function buildRedline({ doc, missingKeywords = [], max = 14 }: RedlineInput): RedlineReport {
  const edits: RedlineEdit[] = [];
  const markup: Record<string, RedlineMark> = {};
  let n = 0;
  const push = (e: Omit<RedlineEdit, "id">) => {
    if (edits.length >= max) return;
    const id = `rl-${++n}`;
    edits.push({ ...e, id });
    if (e.kind === "replace") markup[e.before] = { after: e.after, rule: e.rule };
    else markup[e.before] = { after: "", rule: e.rule, note: e.after };
  };

  let firstProse: string | null = null;
  let firstBody: { section: string; line: string } | null = null;

  for (const section of doc.sections) {
    for (const line of section.lines) {
      const texts: { text: string; isShown: boolean }[] =
        line.k === "prose"
          ? [{ text: line.text, isShown: true }]
          : line.k === "entry"
            ? line.body.map((t) => ({ text: t, isShown: false }))
            : [];
      for (const { text, isShown } of texts) {
        if (!firstProse && line.k === "prose") firstProse = text;
        if (!firstBody && line.k === "entry" && text) firstBody = { section: section.head, line: text };

        if (!worthRewriting(text)) continue;

        // A weak/wordy line is rewritten; if nothing changed it only needs a figure.
        const { text: after, reasons } = polish(text);
        if (after !== text && reasons.length) {
          const rule = reasons[0].rule;
          push({
            section: section.head,
            kind: "replace",
            before: text,
            after,
            reason: reasons.map((r) => r.why).join("; "),
            rule,
            severity: "important",
          });
          // one edit per printed line: the rewrite is the actionable part
          continue;
        }
        if (isShown) continue;
        if (reasons.length) {
          push({
            section: section.head,
            kind: "replace",
            before: text,
            after,
            reason: reasons[0].why,
            rule: reasons[0].rule,
            severity: "polish",
          });
          continue;
        }
        if (!FIGURE.test(text)) {
          push({
            section: section.head,
            kind: "add",
            before: text,
            after: "add a figure: % · users · hours or money saved",
            reason: "A line without a number is a claim a recruiter cannot check",
            rule: "no-figure",
            severity: "polish",
          });
        } else if (text.length > LONG_LINE) {
          push({
            section: section.head,
            kind: "add",
            before: text,
            after: "split at the second clause — two bullets scan faster than one",
            reason: "Over 210 characters; recruiters scan, they do not read",
            rule: "too-long",
            severity: "polish",
          });
        }
      }
    }
  }

  // Missing JD keywords are the only insertion that is about the target, not the prose.
  const anchor = firstProse ?? firstBody?.line ?? null;
  const anchorSection = firstProse ? (doc.sections.find((s) => s.lines.some((l) => l.k === "prose" && l.text === firstProse))?.head ?? "Summary") : (firstBody?.section ?? "Experience");
  for (const kw of missingKeywords.slice(0, 3)) {
    if (edits.length >= max) break;
    const text = `add “${kw}” if it is genuinely true of your work`;
    const id = `rl-${++n}`;
    edits.push({
      id,
      section: "Skills",
      kind: "add",
      before: anchor ?? "",
      after: text,
      reason: "Asked for by the job description and not printed anywhere",
      rule: "keyword",
      severity: "important",
    });
    if (anchor && !markup[anchor]) markup[anchor] = { after: "", rule: "keyword", note: text };
    else if (anchor && markup[anchor]) markup[anchor] = { ...markup[anchor], note: `${markup[anchor].note ? `${markup[anchor].note} · ` : ""}${text}` };
  }

  const important = edits.filter((e) => e.severity === "important").length;
  const polishCount = edits.length - important;
  const hygiene = Math.max(0, Math.round(100 - important * 9 - polishCount * 3));
  const rules = [...new Set(edits.map((e) => e.rule))];
  const by_rule = rules.map((rule) => ({ rule, count: edits.filter((e) => e.rule === rule).length, label: RULE_LABEL[rule] })).sort((a, b) => b.count - a.count);

  return {
    edits,
    markup,
    counts: {
      replace: edits.filter((e) => e.kind === "replace").length,
      add: edits.filter((e) => e.kind === "add").length,
      important,
      polish: polishCount,
    },
    hygiene,
    summary: edits.length
      ? `${edits.length} line${edits.length === 1 ? "" : "s"} to tighten — ${important} change${important === 1 ? "" : "s"} the wording, ${polishCount} add a figure or split a run-on.`
      : "Nothing mechanical to strike: the wording is already tight.",
    by_rule,
  };
}

/** Flatten a doc's printable lines — used by the editor's outline and by tests. */
export function docLines(doc: CvDoc): string[] {
  return doc.sections.flatMap((s) =>
    s.lines.flatMap((l: CvLine) => (l.k === "prose" ? [l.text] : l.k === "entry" ? l.body : l.items))
  );
}
