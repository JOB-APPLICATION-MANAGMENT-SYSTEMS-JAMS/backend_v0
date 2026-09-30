import { all, get, run, parseJson } from "../core/db";
import { AppError, notFound, validation } from "../core/errors";
import { newId, nowIso } from "../util/id";
import { config, smtpReady } from "../core/config";
import nodemailer from "nodemailer";
import { mergeTemplate } from "./cv.service";
import { writeEvent, changeStatus } from "./application.service";
import { recordEffort } from "./streak.service";
import { classify, correctionEffect, type Classification } from "./classify.service";
import { localDayIso } from "../util/date";

export async function listOutreach(userId: string, filter: { state?: string; app_id?: string } = {}) {
  const where = ["user_id = ?"];
  const args: any[] = [userId];
  if (filter.state) {
    where.push("state = ?");
    args.push(filter.state);
  }
  if (filter.app_id) {
    where.push("app_id = ?");
    args.push(filter.app_id);
  }
  return all(`SELECT * FROM outreach_messages WHERE ${where.join(" AND ")} ORDER BY created_at DESC`, ...args);
}

export async function getOutreach(userId: string, id: string): Promise<any> {
  const r = await get("SELECT * FROM outreach_messages WHERE id = ? AND user_id = ?", id, userId);
  if (!r) throw notFound("Outreach message");
  const threads = await all("SELECT * FROM threads WHERE outreach_id = ?", id);
  const messages = await all("SELECT * FROM email_messages WHERE outreach_id = ? ORDER BY received_at ASC", id);
  return { ...r, threads, messages };
}

export interface CreateOutreachInput {
  app_id?: string | null;
  contact_id?: string | null;
  template_id?: string | null;
  subject: string;
  body: string;
  step_no?: number;
}

/** Build the merge context from profile + company + application (§24.2 variables). */
async function mergeContext(userId: string, appId?: string | null, contactId?: string | null) {
  const p = await get<any>("SELECT * FROM profiles WHERE user_id = ?", userId);
  const identity = p ? parseJson(p.identity, {}) : {};
  const app = appId ? await get<any>("SELECT * FROM applications WHERE id = ? AND user_id = ?", appId, userId) : null;
  const contact = contactId ? await get<any>("SELECT * FROM contacts WHERE id = ? AND user_id = ?", contactId, userId) : null;
  const company = app?.company_id ? await get<any>("SELECT * FROM companies WHERE id = ?", app.company_id) : null;
  return {
    profile: identity,
    contact: contact ? { ...contact, first_name: (contact.name ?? "").split(" ")[0] } : {},
    company: company ?? { name: app?.company_name ?? "" },
    posting: app ? { role: app.role_title, url: app.url } : {},
    application: app ?? {},
  };
}

export async function createOutreach(userId: string, input: CreateOutreachInput) {
  const ctx = await mergeContext(userId, input.app_id, input.contact_id);
  const id = newId();
  const now = nowIso();
  await run(
    `INSERT INTO outreach_messages (id, user_id, app_id, contact_id, template_id, step_no, subject, body, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
    id,
    userId,
    input.app_id ?? null,
    input.contact_id ?? null,
    input.template_id ?? null,
    input.step_no ?? 0,
    mergeTemplate(input.subject, ctx),
    mergeTemplate(input.body, ctx),
    now,
    now
  );
  if (input.app_id) await writeEvent(input.app_id, "note", { payload: { outreach_created: id } });
  return get("SELECT * FROM outreach_messages WHERE id = ?", id);
}

export async function updateOutreach(userId: string, id: string, patch: { subject?: string; body?: string; scheduled_at?: string; state?: string }) {
  const r = await get("SELECT * FROM outreach_messages WHERE id = ? AND user_id = ?", id, userId);
  if (!r) throw notFound("Outreach message");
  const state = patch.state ?? r.state;
  if (state && !["draft", "scheduled", "sent_unverified", "sent", "paused", "replied", "bounced"].includes(state)) throw validation("Unknown state");
  await run(
    "UPDATE outreach_messages SET subject = ?, body = ?, scheduled_at = ?, state = ?, updated_at = ? WHERE id = ?",
    patch.subject ?? r.subject,
    patch.body ?? r.body,
    patch.scheduled_at ?? r.scheduled_at,
    state,
    nowIso(),
    id
  );
  return get("SELECT * FROM outreach_messages WHERE id = ?", id);
}

async function sentToday(userId: string): Promise<number> {
  const tz = (await get<{ timezone: string }>("SELECT timezone FROM users WHERE id = ?", userId))?.timezone ?? config.timezone;
  const day = localDayIso(new Date(), tz);
  const r = await get<{ n: number }>("SELECT count(*) AS n FROM outreach_messages WHERE user_id = ? AND state LIKE 'sent%' AND substr(sent_at, 1, 10) = ?", userId, day);
  return r?.n ?? 0;
}

/**
 * Send (§26.1 footer): confirm flag is mandatory, daily cap enforced, default path is
 * Gmail hand-off, the human literally presses Send (§36.1).
 */
export async function sendOutreach(userId: string, id: string, opts: { via?: "gmail_open" | "smtp"; confirm?: boolean }) {
  const r = await get<any>("SELECT * FROM outreach_messages WHERE id = ? AND user_id = ?", id, userId);
  if (!r) throw notFound("Outreach message");
  if (!opts.confirm) throw new AppError("CONFIRM_REQUIRED", 400, "Sending requires explicit confirmation", "pass confirm: true");
  const cap = config.dailySendCap;
  const used = await sentToday(userId);
  if (used >= cap) throw new AppError("QUOTA_EXCEEDED", 403, `Daily send cap reached (${cap})`, "wait until tomorrow or raise DAILY_SEND_CAP");
  if (used >= cap - 3) {
    // warn but allow, surfaced in the cadence health panel
    console.warn(`[outreach] ${used}/${cap} sends today, approaching cap`);
  }

  const ctx = await mergeContext(userId, r.app_id, r.contact_id);
  const to = r.contact_id ? (await get<any>("SELECT * FROM contacts WHERE id = ?", r.contact_id))?.email : "";

  let state: "sent" | "sent_unverified";
  let composeUrl: string | undefined;

  if (opts.via === "smtp") {
    // direct send: requires SMTP_* env; the human already confirmed via the flag (§26.1)
    if (!smtpReady()) {
      throw new AppError(
        "SMTP_NOT_CONFIGURED",
        403,
        "Direct sending is not configured on this deployment",
        "set SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS (and optionally SMTP_FROM), or send via gmail_open"
      );
    }
    if (!to) throw validation("No recipient email on this message; attach a contact with an email first");
    const transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
    await transport.sendMail({
      from: config.smtp.from || config.smtp.user,
      to,
      subject: mergeTemplate(r.subject, ctx),
      text: mergeTemplate(r.body, ctx),
    });
    state = "sent";
    await run("UPDATE outreach_messages SET state = 'sent', sent_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), id);
  } else {
    // Gmail hand-off: hand the user a compose tab, they press Send (state stays unverified)
    composeUrl = buildGmailComposeUrl({ to: to ?? "", subject: mergeTemplate(r.subject, ctx), body: mergeTemplate(r.body, ctx) });
    state = "sent_unverified";
    await run("UPDATE outreach_messages SET state = 'sent_unverified', sent_at = ?, updated_at = ? WHERE id = ?", nowIso(), nowIso(), id);
  }

  if (r.app_id) {
    await writeEvent(r.app_id, "emailed", { actor: "user", payload: { outreach_id: id, via: opts.via === "smtp" ? "smtp" : "gmail_open" } });
    const app = await get<any>("SELECT * FROM applications WHERE id = ?", r.app_id);
    if (app?.kind === "pitch") await recordEffort(userId, 1); // pitched counts as effort (§37.2)
    if (app && app.status === "saved") {
      await run("UPDATE applications SET status = 'applied', applied_at = COALESCE(applied_at, ?), updated_at = ? WHERE id = ?", nowIso(), nowIso(), app.id);
      await writeEvent(app.id, "applied", { actor: "user", payload: { via: app.kind === "pitch" ? "pitch" : "auto_apply" } });
    }
  }
  return { id, state, compose_url: composeUrl, via: opts.via === "smtp" ? "smtp" : "gmail_open", sent_today: used + 1, daily_cap: cap };
}

/** Pitch template: CV to a company with no open role (§19.1 mode 2). Shared with pitch.service. */
export const PITCH_SUBJECT = `{{company.name}} x software engineering`;
export const PITCH_BODY = `Hi {{company.name}} team,

I came across your work and wanted to introduce myself directly, since I did not see an open engineering role on your careers page.

I am a software engineer who builds typed, well-tested product surfaces end to end: web apps, APIs and the automation that saves teams manual work. A few things I could take off your plate:

- internal tools and dashboards for operations, stock or scheduling
- a proper website / booking flow that your team controls
- integrations (payments, email, WhatsApp) with monitoring so issues surface early

If useful, my CV and a couple of sample builds are one reply away. Happy to send a short proposal for one concrete improvement you could make this month.

Best regards,
{{profile.first_name}} {{profile.last_name}}`;

const AUTO_SUBJECT = `Application: {{posting.role}}`;
const AUTO_BODY = `Hello,

I applied for {{posting.role}} and wanted to make sure my application reached a human directly.

I am a software engineer focused on typed, well-tested product work: web apps, APIs and automation. My CV is attached; happy to walk through a relevant project on a short call.

Thank you for your time,
{{profile.first_name}} {{profile.last_name}}`;

/**
 * One-click auto-apply (§25.4): send the application email directly when SMTP is
 * configured, otherwise fall back to the Gmail hand-off compose tab. When no email
 * is known for the company, return the posting URL so the human can apply manually:
 * the open link is never removed, applications and pitches are tracked identically.
 */
export async function autoApply(userId: string, appId: string) {
  const app = await get<any>("SELECT * FROM applications WHERE id = ? AND user_id = ?", appId, userId);
  if (!app) throw notFound("Application");

  const contact = app.contact_id
    ? await get<any>("SELECT * FROM contacts WHERE id = ? AND user_id = ?", app.contact_id, userId)
    : await get<any>("SELECT * FROM contacts WHERE user_id = ? AND company_id IS NOT NULL AND company_id = ? AND email IS NOT NULL LIMIT 1", userId, app.company_id ?? "__none__");

  if (!contact?.email) {
    return {
      mode: "open" as const,
      url: app.url ?? null,
      reason: "No email found for this company, opened the posting so you can apply manually",
      tracked: true,
    };
  }

  let msg = await get<any>(
    "SELECT * FROM outreach_messages WHERE user_id = ? AND app_id = ? ORDER BY created_at DESC LIMIT 1",
    userId,
    appId
  );
  if (!msg) {
    msg = (await createOutreach(userId, {
      app_id: appId,
      contact_id: contact.id,
      subject: app.kind === "pitch" ? PITCH_SUBJECT : AUTO_SUBJECT,
      body: app.kind === "pitch" ? PITCH_BODY : AUTO_BODY,
    })) as any;
  }

  const direct = smtpReady();
  const res = await sendOutreach(userId, msg.id, { via: direct ? "smtp" : "gmail_open", confirm: true });
  return {
    mode: (direct ? "sent" : "compose") as "sent" | "compose",
    outreach_id: msg.id,
    email: contact.email,
    url: app.url ?? null,
    ...res,
  };
}

export function buildGmailComposeUrl(m: { to: string; cc?: string; subject: string; body: string }) {
  const params = new URLSearchParams();
  if (m.to) params.set("to", m.to);
  params.set("su", m.subject); // Gmail uses `su` in some legacy URLs; `subject` is canonical
  params.set("subject", m.subject);
  params.set("body", m.body);
  return `https://mail.google.com/mail/u/0/?view=cm&fs=1&tf=1&${params.toString()}`;
}

/** Cadence health (§26.2): today's queued/sent vs cap + due steps. */
export async function cadenceHealth(userId: string) {
  const cap = config.dailySendCap;
  const used = await sentToday(userId);
  const due = await all("SELECT id, subject, scheduled_at, step_no FROM outreach_messages WHERE user_id = ? AND state = 'scheduled' AND scheduled_at <= ?", userId, nowIso());
  const paused = (await all("SELECT count(*) AS n FROM outreach_messages WHERE user_id = ? AND state IN ('paused','replied')", userId)) as any;
  return { sent_today: used, daily_cap: cap, remaining: Math.max(0, cap - used), due_steps: due, paused_sequences: paused?.[0]?.n ?? 0 };
}

/**
 * Sequence (§26.2): steps stored as follow-up rows with delays; v0 notifies rather than
 * autonomously sending (§26.4 safety rails), pauses automatically on reply.
 */
export async function setSequence(userId: string, appId: string, steps: { delay_days: number; subject: string; body: string; enabled?: boolean }[]) {
  const app = await get("SELECT * FROM applications WHERE id = ? AND user_id = ?", appId, userId);
  if (!app) throw notFound("Application");
  await run("DELETE FROM outreach_messages WHERE user_id = ? AND app_id = ? AND step_no > 0 AND state IN ('draft','scheduled')", userId, appId);
  const created: any[] = [];
  const base = app.applied_at ? new Date(app.applied_at) : new Date();
  for (const [i, s] of steps.entries()) {
    const id = newId();
    const scheduled = new Date(base.getTime() + s.delay_days * 86_400_000).toISOString();
    await run(
      `INSERT INTO outreach_messages (id, user_id, app_id, template_id, step_no, subject, body, state, scheduled_at, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 'scheduled', ?, ?, ?)`,
      id,
      userId,
      appId,
      i + 1,
      s.subject,
      s.body,
      s.enabled === false ? null : scheduled,
      nowIso(),
      nowIso()
    );
    created.push({ id, scheduled_at: scheduled, delay_days: s.delay_days });
  }
  return { steps: created };
}

/* --------------------------- inbox sync (v0) --------------------------- */

/**
 * Ingest an inbound message (fixture/manual/IMAP worker all funnel here), thread matching
 * by message-id then normalized subject (§36.2), classification, status transition, events.
 */
export async function ingestInbound(
  userId: string,
  msg: { message_id?: string; in_reply_to?: string; subject?: string; from: string; to?: string; body?: string; headers?: Record<string, string>; mailbox_id?: string; received_at?: string }
) {
  const subjectNorm = (msg.subject ?? "").toLowerCase().replace(/\s+/g, " ").replace(/^(re:|fw:)\s*/, "").trim();
  let thread = msg.in_reply_to
    ? await get("SELECT * FROM threads WHERE id IN (SELECT thread_id FROM email_messages WHERE message_id = ?) AND user_id = ?", msg.in_reply_to, userId)
    : undefined;
  if (!thread && msg.subject) {
    thread = await get<any>(
      `SELECT t.* FROM threads t WHERE t.user_id = ? AND lower(replace(replace(t.subject,'Re:',''),'FW:','')) = ?`,
      userId,
      subjectNorm
    );
  }
  if (!thread && msg.subject) {
    thread = await get<any>(
      `SELECT t.* FROM threads t WHERE t.user_id = ? AND lower(t.subject) LIKE ?`,
      userId,
      `%${subjectNorm.slice(0, 40)}%`
    );
  }

  const result = classify({ headers: msg.headers, subject: msg.subject, body: msg.body, from: msg.from });
  const msgId = newId();
  await run(
    `INSERT INTO email_messages (id, user_id, mailbox_id, thread_id, outreach_id, message_id, in_reply_to, direction, subject, from_addr, to_addr, body, classification, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?)`,
    msgId,
    userId,
    msg.mailbox_id ?? null,
    thread?.id ?? null,
    thread?.outreach_id ?? null,
    msg.message_id ?? msgId,
    msg.in_reply_to ?? null,
    msg.subject ?? "(no subject)",
    msg.from,
    msg.to ?? null,
    msg.body ?? null,
    result.classification,
    msg.received_at ?? nowIso()
  );

  const effect = correctionEffect(result.classification);
  let statusBump = effect.statusBump;
  let app = null as any;
  if (thread?.outreach_id) {
    const outreach = await get<any>("SELECT * FROM outreach_messages WHERE id = ?", thread.outreach_id);
    if (outreach?.app_id) {
      app = await get<any>("SELECT * FROM applications WHERE id = ?", outreach.app_id);
      if (app) {
        if (result.classification === "bounce") await run("UPDATE outreach_messages SET bounced = 1, state = 'bounced' WHERE id = ?", outreach.id);
        else if (!app.replied_at && ["interested", "interview_invite", "rejected"].includes(result.classification)) {
          await run("UPDATE applications SET replied_at = ?, first_reply_days = ?, updated_at = ? WHERE id = ?", nowIso(), app.applied_at ? Number(((Date.now() - new Date(app.applied_at).getTime()) / 86_400_000).toFixed(1)) : null, nowIso(), app.id);
          await writeEvent(app.id, "reply", { actor: "system", payload: { classification: result.classification, reason: result.reason } });
          if (statusBump && statusBump !== app.status) {
            try {
              await changeStatus(userId, app.id, statusBump as any, undefined, "system");
            } catch (e: any) {
              console.warn("[inbox] status bump skipped:", e.message);
            }
          }
        }
        await run("UPDATE outreach_messages SET state = ? WHERE id = ?", effect.pauseSequence ? "paused" : "sent", outreach.id);
        if (effect.pauseSequence) await writeEvent(app.id, "status_changed", { actor: "system", payload: { sequence: "paused", reason: result.classification } });
      }
    }
  }

  return {
    message_id: msgId,
    thread_id: thread?.id ?? null,
    classification: result.classification,
    reason: result.reason,
    paused_sequence: effect.pauseSequence,
    application: app ? { id: app.id, status: app.status } : null,
  };
}

/** User correction → lexicon feedback (§36.2 step 3). */
export async function classifyMessage(userId: string, messageId: string, classification: Classification) {
  const m = await get("SELECT * FROM email_messages WHERE id = ? AND user_id = ?", messageId, userId);
  if (!m) throw notFound("Message");
  await run("UPDATE email_messages SET classification = ? WHERE id = ?", classification, messageId);
  const effect = correctionEffect(classification);
  return { message_id: messageId, classification, ...effect };
}

export async function listThreads(userId: string) {
  return all(
    `SELECT t.*, (SELECT count(*) FROM email_messages WHERE thread_id = t.id) AS messages
     FROM threads t WHERE t.user_id = ? ORDER BY t.created_at DESC`,
    userId
  );
}

export async function getThread(userId: string, id: string) {
  const t = await get("SELECT * FROM threads WHERE id = ? AND user_id = ?", id, userId);
  if (!t) throw notFound("Thread");
  return { ...t, messages: await all("SELECT * FROM email_messages WHERE thread_id = ? ORDER BY received_at ASC", id) };
}
