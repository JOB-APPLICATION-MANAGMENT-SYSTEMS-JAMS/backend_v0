import { Router } from "express";
import { z } from "zod";
import { ok } from "../core/envelope";
import { get, run } from "../core/db";
import { nowIso } from "../util/id";
import { validation } from "../core/errors";
import { requireAuth, type AuthedRequest } from "../core/security";
import * as pitch from "../services/pitch.service";
import { composePitch } from "../services/pitch-rewrite";
import { startRescan, rescanProgress, discoverListPages, enrichEmails, LIST_SECTORS, type ListSector } from "../services/logcluster";
import { saveAttachment, saveCvAttachment } from "../services/attachments";

export const pitchRouter = Router();
pitchRouter.use(requireAuth);

/** GET /pitch-targets?sector=supermarket&city=lagos&q=… — live Nigerian company search for pitching. */
pitchRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const q = req.query as any;
    const result = await pitch.searchPitchTargets({
      sector: (q.sector as pitch.Sector) || undefined,
      city: (q.city as pitch.CityKey | "all") || undefined,
      q: q.q,
      refresh: q.refresh === "1" || q.refresh === "true",
      page: q.page ? Number(q.page) : 1,
      page_size: q.page_size ? Number(q.page_size) : 50,
    });
    ok(res, `${result.pagination.total_count} companies to pitch`, result);
  } catch (e) {
    next(e);
  }
});

/** Metadata for the UI: sectors, cities, and how the search works. */
pitchRouter.get("/meta", async (_req, res, next) => {
  try {
    ok(res, "Pitch search metadata", {
      sectors: pitch.SECTORS.map((s) => ({
        key: s,
        label: pitch.SECTOR_LABELS[s],
        // list sectors are nationwide curated tables: the UI hides the city picker for them
        source: pitch.isListSector(s) ? "curated list" : "OpenStreetMap",
        nationwide: pitch.isListSector(s),
      })),
      cities: pitch.CITY_KEYS.map((k) => ({ key: k, label: pitch.CITIES[k].label })),
      source: "OpenStreetMap Overpass + curated contact lists (lca.logcluster.org), refreshed every 24h",
      note: "Emails are published contact addresses when available, otherwise derived as info@<website domain> and flagged derived.",
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /pitch-targets/prepare {external_id} — company + contact + pitch application +
 * outreach draft in one step, returning the merged subject/body for preview/edit.
 * The body carries the id because ids contain a slash (node/123) and the Next.js
 * proxy splits decoded %2F into two path segments, breaking path params.
 * The message stays a draft until /applications/:id/auto-apply or /outreach/:id/send.
 */
pitchRouter.post("/prepare", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ external_id: z.string().min(1) }).parse(req.body ?? {});
    ok(res, "Pitch prepared (draft)", await pitch.preparePitch(req.userId!, body.external_id), 201);
  } catch (e) {
    next(e);
  }
});

/** Legacy path-param variant kept for older clients; body form above is canonical. */
pitchRouter.post("/:externalId/prepare", async (req: AuthedRequest, res, next) => {
  try {
    const externalId = decodeURIComponent(String(req.params.externalId));
    ok(res, "Pitch prepared (draft)", await pitch.preparePitch(req.userId!, externalId), 201);
  } catch (e) {
    next(e);
  }
});

/**
 * POST /pitch-targets/rewrite {external_id | company, seed} — regenerate the wording.
 * Same pipeline as prepare (category hooks + seeded selection + grammar passes), a
 * different seed: this is the Refresh button. Text is returned, not saved, so the
 * preview can be cycled without touching the stored draft until the user keeps it.
 */
pitchRouter.post("/rewrite", async (req: AuthedRequest, res, next) => {
  try {
    const body = z
      .object({
        external_id: z.string().optional(),
        company: z.string().optional(),
        role: z.string().optional(),
        kind: z.enum(["pitch", "application"]).optional(),
        seed: z.union([z.string(), z.number()]).optional(),
      })
      .parse(req.body ?? {});
    let company = body.company;
    let category: string | null | undefined;
    let city: string | null | undefined;
    if (body.external_id) {
      const t = await pitch.targetByExternalId(body.external_id);
      company = company ?? t.name;
      category = t.sector;
      city = t.city;
    }
    if (!company) throw validation("external_id or company is required");
    const composed = await composePitch({
      kind: body.kind ?? "pitch",
      category,
      company,
      role: body.role,
      city,
      seed: body.seed ?? `${Date.now()}`,
    });
    ok(res, "Wording regenerated", composed);
  } catch (e) {
    next(e);
  }
});

/**
 * POST /pitch-targets/rescan {scope, categories?, limit?, force?, enrich?} — walk the
 * worldwide contact-list catalog (or just Nigeria) in the background; poll
 * GET /pitch-targets/rescan for progress. This is where the ~10,000 companies come from.
 */
pitchRouter.post("/rescan", async (req: AuthedRequest, res, next) => {
  try {
    const body = z
      .object({
        scope: z.enum(["all", "nigeria"]).optional(),
        categories: z.array(z.string()).optional(),
        limit: z.number().int().positive().max(2000).optional(),
        force: z.boolean().optional(),
        enrich: z.boolean().optional(),
      })
      .default({})
      .parse(req.body ?? {});
    const state = startRescan({ ...body, categories: body.categories as ListSector[] | undefined });
    ok(res, state.status === "running" ? "Rescan already running" : "Rescan enqueued", state, 202);
  } catch (e) {
    next(e);
  }
});

/** Live progress of the catalog walk: pages, rows, emails, errors. */
pitchRouter.get("/rescan", async (_req, res, next) => {
  try {
    const pages = await discoverListPages().catch(() => []);
    ok(res, "Rescan progress", {
      progress: rescanProgress(),
      catalog: {
        lists_available: pages.length,
        countries: new Set(pages.map((p) => p.country)).size,
        by_sector: pages.reduce<Record<string, number>>((acc, p) => ((acc[p.sector!] = (acc[p.sector!] ?? 0) + 1), acc), {}),
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /pitch-targets/catalog {pages} — push a discovered catalog. The sitemap is
 * not reachable from every network (serverless egress included), so the catalog can
 * also be seeded from a machine that can read it; later runs load it from the table.
 */
pitchRouter.post("/catalog", async (req: AuthedRequest, res, next) => {
  try {
    const body = z
      .object({
        pages: z
          .array(z.object({ slug: z.string().min(3).max(160), country: z.string().min(2).max(80), sector: z.string().min(2).max(40) }))
          .min(1)
          .max(3000),
      })
      .parse(req.body ?? {});
    const now = nowIso();
    let stored = 0;
    for (const p of body.pages) {
      if (!LIST_SECTORS.includes(p.sector as ListSector)) continue;
      await run(
        `INSERT INTO logcluster_pages (slug, country, sector, discovered_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET country = excluded.country, sector = excluded.sector, discovered_at = excluded.discovered_at`,
        p.slug, p.country, p.sector, now
      );
      stored++;
    }
    ok(res, `${stored} catalog pages stored`, { stored, total: (await get<{ n: number }>(`SELECT count(*) AS n FROM logcluster_pages`))?.n ?? stored });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /pitch-targets/import {rows} — bulk upsert of crawled contact-list rows.
 * Mirrors refreshContactList's shape, so a machine with a friendlier network can do
 * the walking (696 pages) and push the companies here in chunks.
 */
pitchRouter.post("/import", async (req: AuthedRequest, res, next) => {
  try {
    const body = z
      .object({
        rows: z
          .array(
            z.object({
              external_id: z.string().min(3).max(512),
              name: z.string().min(1).max(200),
              sector: z.string().min(2).max(40),
              city: z.string().max(80).nullish(),
              country: z.string().max(80).nullish(),
              website: z.string().max(300).nullish(),
              email: z.string().max(200).nullish(),
              email_derived: z.number().int().min(0).max(1).optional(),
              phone: z.string().max(200).nullish(),
            })
          )
          .min(1)
          .max(2000),
      })
      .parse(req.body ?? {});
    const now = nowIso();
    let stored = 0;
    for (const r of body.rows) {
      if (!LIST_SECTORS.includes(r.sector as ListSector)) continue;
      await run(
        `INSERT INTO pitch_targets (external_id, name, sector, city, country, website, email, email_derived, phone, lat, lon, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
         ON CONFLICT(external_id) DO UPDATE SET name = excluded.name, sector = excluded.sector, city = excluded.city,
           country = excluded.country, website = excluded.website,
           email = CASE WHEN pitch_targets.email_derived = 0 THEN pitch_targets.email ELSE excluded.email END,
           email_derived = CASE WHEN pitch_targets.email_derived = 0 THEN 1 ELSE excluded.email_derived END,
           phone = excluded.phone, fetched_at = excluded.fetched_at`,
        r.external_id, r.name, r.sector, r.city ?? null, r.country ?? null, r.website ?? null,
        r.email ?? null, r.email_derived ?? (r.email ? 0 : 1), r.phone ?? null, now
      );
      stored++;
    }
    const total = (await get<{ n: number }>(`SELECT count(*) AS n FROM pitch_targets`))?.n ?? stored;
    ok(res, `${stored} rows imported, ${total} companies on file`, { stored, total });
  } catch (e) {
    next(e);
  }
});

/** POST /pitch-targets/enrich {limit} — visit company sites and pick up published inboxes. */
pitchRouter.post("/enrich", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ limit: z.number().int().positive().max(5000).optional() }).default({}).parse(req.body ?? {});
    const updated = await enrichEmails({ limit: body.limit ?? 500 });
    ok(res, `${updated} emails discovered from company websites`, { updated });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /pitch-targets/attach — either a file (base64) or a CV Studio document
 * (`cv_id`), which is rendered to a self-contained HTML file. The answer's `url` is
 * the public link that goes into the email body.
 */
pitchRouter.post("/attach", async (req: AuthedRequest, res, next) => {
  try {
    const body = z
      .object({
        filename: z.string().min(1).max(200),
        content_type: z.string().max(120).optional(),
        content_b64: z.string().optional(),
        cv_id: z.string().optional(),
      })
      .parse(req.body ?? {});
    const saved = body.cv_id
      ? await saveCvAttachment(req.userId!, body.cv_id)
      : await saveAttachment(req.userId!, {
          filename: body.filename,
          content_type: body.content_type ?? "application/octet-stream",
          content_b64: body.content_b64 ?? "",
        });
    ok(res, "Attachment stored", saved, 201);
  } catch (e) {
    next(e);
  }
});
