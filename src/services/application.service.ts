import { all, get, run, parseJson, tx } from "../core/db";
import { AppError, conflict, notFound, validation } from "../core/errors";
import { newId, nowIso } from "../util/id";
import { config } from "../core/config";
import { recordEffort } from "./streak.service";
import { localDayIso } from "../util/date";

export const STATUSES = ["saved", "applied", "viewed", "screen", "interview", "offer", "rejected", "ghosted", "withdrawn"] as const;
export type Status = (typeof STATUSES)[number];

/** Server-side transition map (§32.2) — every transition writes an application_events row. */
export const TRANSITIONS: Record<Status, Status[]> = {
  saved: ["applied", "withdrawn"],
  applied: ["viewed", "screen", "interview", "offer", "rejected", "ghosted", "withdrawn"],
  viewed: ["screen", "interview", "offer", "rejected", "ghosted", "withdrawn"],
  screen: ["interview", "offer", "rejected", "ghosted", "withdrawn"],
  interview: ["offer", "rejected", "ghosted", "withdrawn"],
  offer: ["rejected", "withdrawn"],
  rejected: [],
  ghosted: ["applied", "viewed", "screen", "interview", "rejected", "withdrawn"],
  withdrawn: [],
};

export function canTransition(from: Status, to: Status) {
  return from === to || TRANSITIONS[from]?.includes(to);
}

export function writeEvent(appId: string, type: string, opts: { actor?: string; payload?: any; at?: string } = {}) {
  run(
    "INSERT INTO application_events (app_id, type, at, actor, payload) VALUES (?, ?, ?, ?, ?)",
    appId,
    type,
    opts.at ?? nowIso(),
    opts.actor ?? "user",
    opts.payload ? JSON.stringify(opts.payload) : null
  );
}

export function listApplications(
  userId: string,
  params: { status?: string[]; kind?: string; company_id?: string; from?: string; to?: string; sort?: string; page?: number; page_size?: number; q?: string }
) {
  const page = Math.max(1, Number(params.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(params.page_size ?? 50)));
  const where = ["user_id = ?"];
  const args: any[] = [userId];
  if (params.status?.length) {
    where.push(`status IN (${params.status.map(() => "?").join(",")})`);
    args.push(...params.status);
  }
  if (params.kind) {
    where.push("kind = ?");
    args.push(params.kind);
  }
  if (params.company_id) {
    where.push("company_id = ?");
    args.push(params.company_id);
  }
  if (params.from) {
    where.push("created_at >= ?");
    args.push(params.from);
  }
  if (params.to) {
    where.push("created_at <= ?");
    args.push(params.to);
  }
  if (params.q) {
    where.push("(lower(role_title) LIKE ? OR lower(company_name) LIKE ?)");
    args.push(`%${params.q.toLowerCase()}%`, `%${params.q.toLowerCase()}%`);
  }
  const w = where.join(" AND ");
  const total = get<{ n: number }>(`SELECT count(*) AS n FROM applications WHERE ${w}`, ...args)!.n;
  const order =
    params.sort === "recent"
      ? "created_at DESC"
      : params.sort === "company"
        ? "company_name ASC"
        : params.sort === "status"
          ? "status ASC, updated_at DESC"
          : "COALESCE(applied_at, created_at) DESC";
  const items = all<any>(`SELECT * FROM applications WHERE ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, pageSize, (page - 1) * pageSize);
  return { items: items.map(shapeApplication), pagination: { page, page_size: pageSize, total_count: total, total_pages: Math.max(1, Math.ceil(total / pageSize)) } };
}

function shapeApplication(r: any) {
  return {
    ...r,
    capture: parseJson(r.capture, null),
    tags: parseJson(r.tags, []),
    next_action: r.next_action_at,
  };
}

export function getApplication(userId: string, id: string) {
  const r = get("SELECT * FROM applications WHERE id = ? AND user_id = ?", id, userId);
  if (!r) throw notFound("Application");
  const events = all("SELECT * FROM application_events WHERE app_id = ? ORDER BY at ASC", id);
  const outreach = all("SELECT * FROM outreach_messages WHERE app_id = ? ORDER BY created_at ASC", id);
  const threads = all(
    `SELECT t.* FROM threads t WHERE t.outreach_id IN (SELECT id FROM outreach_messages WHERE app_id = ?) OR t.id IN (SELECT thread_id FROM email_messages WHERE outreach_id IN (SELECT id FROM outreach_messages WHERE app_id = ?))`,
    id,
    id
  );
  const messages = all("SELECT * FROM email_messages WHERE outreach_id IN (SELECT id FROM outreach_messages WHERE app_id = ?) ORDER BY received_at ASC", id);
  return { ...shapeApplication(r), events, outreach, threads, messages };
}

export interface CreateApplicationInput {
  company_name: string;
  company_id?: string | null;
  posting_id?: string | null;
  contact_id?: string | null;
  kind?: "application" | "pitch";
  status?: Status;
  role_title: string;
  cv_id?: string | null;
  template_id?: string | null;
  source?: string | null;
  url?: string | null;
  notes?: string | null;
  tags?: string[];
  capture?: any;
  applied_at?: string | null;
  next_action_at?: string | null;
}

export function createApplication(userId: string, input: CreateApplicationInput, actor = "user") {
  return tx(() => {
    let companyId = input.company_id ?? null;
    if (!companyId && input.company_name) {
      const existing = get("SELECT id FROM companies WHERE user_id = ? AND lower(name) = ?", userId, input.company_name.toLowerCase());
      if (existing) companyId = existing.id;
      else {
        companyId = newId();
        run(
          "INSERT INTO companies (id, user_id, name, tier, created_at, updated_at) VALUES (?, ?, ?, 'reach', ?, ?)",
          companyId,
          userId,
          input.company_name,
          nowIso(),
          nowIso()
        );
      }
    }
    const id = newId();
    const now = nowIso();
    const status = input.status ?? (input.applied_at ? "applied" : "saved");
    run(
      `INSERT INTO applications (id, user_id, company_id, posting_id, contact_id, kind, status, cv_id, template_id,
        role_title, company_name, source, url, applied_at, capture, notes, tags, next_action_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      companyId,
      input.posting_id ?? null,
      input.contact_id ?? null,
      input.kind ?? "application",
      status,
      input.cv_id ?? null,
      input.template_id ?? null,
      input.role_title,
      input.company_name,
      input.source ?? null,
      input.url ?? null,
      input.applied_at ?? null,
      input.capture ? JSON.stringify(input.capture) : null,
      input.notes ?? null,
      JSON.stringify(input.tags ?? []),
      input.next_action_at ?? null,
      now,
      now
    );
    writeEvent(id, "created", { actor, payload: { status, kind: input.kind ?? "application" } });
    if (input.applied_at) {
      writeEvent(id, "applied", { actor, at: input.applied_at, payload: { source: input.source } });
      if ((input.kind ?? "application") === "application") recordEffort(userId, 1, input.applied_at);
    }
    if (input.posting_id) {
      run(
        `INSERT INTO job_votes (id, user_id, posting_id, vote, created_at) VALUES (?, ?, ?, 'applied', ?)
         ON CONFLICT(user_id, posting_id) DO UPDATE SET vote = 'applied'`,
        newId(),
        userId,
        input.posting_id,
        now
      );
    }
    return getApplication(userId, id);
  });
}

export function updateApplication(userId: string, id: string, patch: Partial<CreateApplicationInput> & { status?: Status; status_at?: string }) {
  const existing = get("SELECT * FROM applications WHERE id = ? AND user_id = ?", id, userId);
  if (!existing) throw notFound("Application");
  const sets: string[] = [];
  const args: any[] = [];
  const push = (col: string, v: any) => {
    sets.push(`${col} = ?`);
    args.push(v);
  };
  if (patch.role_title != null) push("role_title", patch.role_title);
  if (patch.company_name != null) push("company_name", patch.company_name);
  if (patch.cv_id !== undefined) push("cv_id", patch.cv_id);
  if (patch.template_id !== undefined) push("template_id", patch.template_id);
  if (patch.notes !== undefined) push("notes", patch.notes);
  if (patch.url !== undefined) push("url", patch.url);
  if (patch.source !== undefined) push("source", patch.source);
  if (patch.contact_id !== undefined) push("contact_id", patch.contact_id);
  if (patch.tags !== undefined) push("tags", JSON.stringify(patch.tags));
  if (patch.next_action_at !== undefined) push("next_action_at", patch.next_action_at);
  if (patch.applied_at !== undefined) push("applied_at", patch.applied_at);
  if (patch.capture !== undefined) push("capture", JSON.stringify(patch.capture));
  push("updated_at", nowIso());
  run(`UPDATE applications SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, ...args, id, userId);

  if (patch.status && patch.status !== existing.status) {
    changeStatus(userId, id, patch.status, patch.status_at, "user");
  }
  return getApplication(userId, id);
}

/** Validated status change + event write + derived timestamps + effort accounting. */
export function changeStatus(userId: string, id: string, to: Status, at?: string, actor = "user") {
  const existing = get("SELECT * FROM applications WHERE id = ? AND user_id = ?", id, userId);
  if (!existing) throw notFound("Application");
  const from = existing.status as Status;
  if (!STATUSES.includes(to)) throw validation(`Unknown status: ${to}`);
  if (!canTransition(from, to)) {
    throw new AppError(
      "INVALID_TRANSITION",
      409,
      `Cannot move from ${from} to ${to}`,
      `allowed: ${TRANSITIONS[from].join(", ") || "none"}`
    );
  }
  if (from === to) return getApplication(userId, id);
  const when = at ?? nowIso();
  const sets: string[] = ["status = ?", "updated_at = ?"];
  const args: any[] = [to, when];
  if (to === "applied" && !existing.applied_at) {
    sets.push("applied_at = ?");
    args.push(when);
  }
  if (to === "rejected" || to === "ghosted" || to === "offer" || to === "interview") {
    // replied_at inferred when first human outcome arrives
    if (!existing.replied_at && (to === "rejected" || to === "offer" || to === "interview")) {
      sets.push("replied_at = ?");
      args.push(when);
      if (existing.applied_at) {
        const days = (new Date(when).getTime() - new Date(existing.applied_at).getTime()) / 86_400_000;
        sets.push("first_reply_days = ?");
        args.push(Number(days.toFixed(1)));
      }
    }
  }
  if (to === "ghosted") {
    sets.push("ghosted_at = ?");
    args.push(when);
  }
  run(`UPDATE applications SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, ...args, id, userId);
  writeEvent(id, "status_changed", { actor, at: when, payload: { from, to } });
  if (to === "applied" && (existing.kind === "application")) {
    writeEvent(id, "applied", { actor, at: when });
    recordEffort(userId, 1, when);
  }
  if (to === "interview") writeEvent(id, "interview", { actor, at: when });
  if (to === "offer") writeEvent(id, "offer", { actor, at: when });
  if (to === "rejected") writeEvent(id, "rejected", { actor, at: when });
  if (to === "ghosted") writeEvent(id, "ghosted", { actor, at: when });
  return getApplication(userId, id);
}

export function deleteApplication(userId: string, id: string) {
  const n = run("DELETE FROM applications WHERE id = ? AND user_id = ?", id, userId);
  if (!n) throw notFound("Application");
  return { deleted: true };
}

export function addNote(userId: string, id: string, note: string) {
  const app = get("SELECT id FROM applications WHERE id = ? AND user_id = ?", id, userId);
  if (!app) throw notFound("Application");
  writeEvent(id, "note", { actor: "user", payload: { note } });
  run("UPDATE applications SET notes = COALESCE(notes || char(10), '') || ?, updated_at = ? WHERE id = ?", note, nowIso(), id);
  return getApplication(userId, id);
}

export function bulkStatus(userId: string, ids: string[], status: Status) {
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of ids) {
    try {
      changeStatus(userId, id, status);
      results.push({ id, ok: true });
    } catch (e: any) {
      results.push({ id, ok: false, error: e.message });
    }
  }
  return { results };
}

/**
 * Ghost sweep (§19.2 / §37.2): applied ≥ GHOST_AFTER_DAYS ago, no reply, not rejected/offer/interview → ghosted.
 * Runs from the scheduler; also callable directly (and from tests).
 */
export function ghostSweep(now = new Date()): { flipped: number } {
  const cutoff = new Date(now.getTime() - config.ghostAfterDays * 86_400_000).toISOString();
  const rows = all<any>(
    `SELECT id, user_id, applied_at FROM applications
     WHERE kind = 'application' AND status IN ('applied','viewed','screen')
       AND applied_at IS NOT NULL AND applied_at <= ?
       AND replied_at IS NULL AND (ghosted_at IS NULL OR ghosted_at = '')`,
    cutoff
  );
  let flipped = 0;
  for (const r of rows) {
    changeStatus(r.user_id, r.id, "ghosted", now.toISOString(), "system");
    flipped++;
  }
  return { flipped };
}

/** Follow-up reminders surfaced as chips (§19.2). */
export function followUpChips(userId: string) {
  const now = nowIso();
  return all(
    `SELECT id, role_title, company_name, next_action_at, follow_up_stage FROM applications
     WHERE user_id = ? AND next_action_at IS NOT NULL AND next_action_at <= ? AND status NOT IN ('rejected','withdrawn','offer')
     ORDER BY next_action_at ASC LIMIT 20`,
    userId,
    now
  );
}
