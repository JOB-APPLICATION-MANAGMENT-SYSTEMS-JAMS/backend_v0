/**
 * Reply classification (§36.2) — deterministic rules first, user-correctable, no LLM in v0.
 * Order: headers → lexicon/regex → fallback neutral.
 */
export type Classification = "auto_reply" | "ooo" | "bounce" | "rejected" | "interview_invite" | "interested" | "neutral";

export interface IncomingMessage {
  headers?: Record<string, string>;
  subject?: string;
  body?: string;
  from?: string;
}

const PATTERNS: { cls: Classification; re: RegExp }[] = [
  { cls: "bounce", re: /\b(mailbox full|undeliverable|delivery status notification|delivery has failed|address rejected|user not found)\b/i },
  { cls: "rejected", re: /\b(unfortunately|not moving forward|other candidates|decided not to|will not be moving|regret to inform|pursuing other|not a fit|no openings at this time|we have decided)\b/i },
  { cls: "interview_invite", re: /\b(interview|let'?s (?:chat|talk|call)|call with|available (?:for|on)|calendly|schedule a|next steps|phone screen|recruiter screen|assessment)\b/i },
  { cls: "interested", re: /\b(interested|resume received|cv received|team will review|we.?d like to|take you forward|folks here|role looks|excited about your)\b/i },
  { cls: "ooo", re: /\b(out of office|away until|on leave until|automatic reply|back on)\b/i },
];

export function classify(msg: IncomingMessage): { classification: Classification; reason: string } {
  const headers = lowercaseKeys(msg.headers ?? {});
  if (headers["auto-submitted"] || headers["auto-replied"] || headers["x-autoreply"] || headers["x-autorespond"] || headers["precedence"] === "auto_reply") {
    return { classification: "auto_reply", reason: "auto-submission header present" };
  }
  if (headers["x-failed-recipients"] || headers["content-type"]?.includes("delivery-status")) {
    return { classification: "bounce", reason: "bounce headers present" };
  }
  const text = `${msg.subject ?? ""}\n${(msg.body ?? "").slice(0, 4000)}`;
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) return { classification: p.cls, reason: `matched “${m[0]}”` };
  }
  return { classification: "neutral", reason: "no rule matched" };
}

const lowercaseKeys = (o: Record<string, string>) => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(o)) out[k.toLowerCase()] = String(v);
  return out;
};

/** User correction → persists into a local phrase list (feeds back via lexicon table in v1). */
export function correctionEffect(cls: Classification): { statusBump: "replied" | "interview" | "rejected" | null; pauseSequence: boolean } {
  switch (cls) {
    case "interested":
      return { statusBump: "replied", pauseSequence: true };
    case "interview_invite":
      return { statusBump: "interview", pauseSequence: true };
    case "rejected":
      return { statusBump: "rejected", pauseSequence: true };
    case "bounce":
      return { statusBump: null, pauseSequence: true };
    default:
      return { statusBump: null, pauseSequence: false };
  }
}
