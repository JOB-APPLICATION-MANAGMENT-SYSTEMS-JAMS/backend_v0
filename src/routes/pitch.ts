import { Router } from "express";
import { z } from "zod";
import { ok } from "../core/envelope";
import { requireAuth, type AuthedRequest } from "../core/security";
import * as pitch from "../services/pitch.service";

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
