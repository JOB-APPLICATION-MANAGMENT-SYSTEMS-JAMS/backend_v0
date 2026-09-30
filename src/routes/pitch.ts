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
pitchRouter.get("/meta", (_req, res, next) => {
  try {
    ok(res, "Pitch search metadata", {
      sectors: pitch.SECTORS.map((s) => ({ key: s, label: pitch.SECTOR_LABELS[s] })),
      cities: pitch.CITY_KEYS.map((k) => ({ key: k, label: pitch.CITIES[k].label })),
      source: "OpenStreetMap Overpass API (live, refreshed every 24h)",
      note: "Emails are published contact addresses when available, otherwise derived as info@<website domain> and flagged derived.",
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /pitch-targets/:externalId/prepare — company + contact + pitch application +
 * outreach draft in one step. The message stays a draft until /outreach/:id/send.
 */
pitchRouter.post("/:externalId/prepare", async (req: AuthedRequest, res, next) => {
  try {
    const externalId = decodeURIComponent(String(req.params.externalId));
    ok(res, "Pitch prepared (draft)", await pitch.preparePitch(req.userId!, externalId), 201);
  } catch (e) {
    next(e);
  }
});
