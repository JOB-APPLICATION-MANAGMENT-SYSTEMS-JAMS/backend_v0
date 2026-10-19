/**
 * The three new network surfaces: /people, /hirers and /events.
 *
 * Each list endpoint returns its own match reasons alongside the rows, so the UI
 * can explain a ranking instead of asserting one. Query parsing lives here; the
 * ranking and the seeds live in `network.service`.
 */
import { Router } from "express";
import { z } from "zod";
import { ok } from "../core/envelope";
import { requireAuth, type AuthedRequest } from "../core/security";
import * as net from "../services/network.service";

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/* ─────────────────────────────── people ──────────────────────────────── */
export const peopleRouter = Router();
peopleRouter.use(requireAuth);

peopleRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const q = req.query as any;
    ok(
      res,
      "People retrieved",
      await net.listPeople(req.userId!, {
        q: str(q.q),
        profession: str(q.profession),
        location: str(q.location),
        open_to: str(q.open_to),
        sort: str(q.sort),
      })
    );
  } catch (e) {
    next(e);
  }
});

/** The guided interview. One source of truth: Discover renders exactly these. */
peopleRouter.get("/questions", (_req, res) => ok(res, "Profile questions", { items: net.PEOPLE_QUESTIONS }));

/** Public CVs on the network, for the review flow. */
peopleRouter.get("/public-cvs", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Public CVs", { items: await net.publicCvFeed(Number(req.query.limit) || 12) });
  } catch (e) {
    next(e);
  }
});

peopleRouter.get("/me", async (req: AuthedRequest, res, next) => {
  try {
    const list = await net.listPeople(req.userId!, {});
    ok(res, "Your public profile", { me: list.me, questions: list.questions });
  } catch (e) {
    next(e);
  }
});

const personSchema = z.object({
  name: z.string().max(120).optional(),
  headline: z.string().max(160).optional(),
  profession: z.string().max(80).optional(),
  seniority: z.string().max(40).optional(),
  location: z.string().max(120).optional(),
  bio: z.string().max(1200).optional(),
  links: z.record(z.string().max(300)).optional(),
  offers: z.array(z.string().max(160)).max(12).optional(),
  looking_for: z.string().max(300).optional(),
  answers: z.array(z.object({ q: z.string().max(200), a: z.string().max(1200) })).max(10).optional(),
  open_to: z.array(z.string().max(40)).max(10).optional(),
  visible: z.boolean().optional(),
});

peopleRouter.put("/me", async (req: AuthedRequest, res, next) => {
  try {
    const body = personSchema.parse(req.body ?? {});
    ok(res, "Public profile saved", await net.upsertMyPerson(req.userId!, body));
  } catch (e) {
    next(e);
  }
});

peopleRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    ok(res, "Person retrieved", await net.getPerson(req.userId!, String(req.params.id)));
  } catch (e) {
    next(e);
  }
});

/* ─────────────────────────────── hirers ──────────────────────────────── */
export const hirersRouter = Router();
hirersRouter.use(requireAuth);

hirersRouter.get("/jobs", async (req: AuthedRequest, res, next) => {
  try {
    const q = req.query as any;
    ok(
      res,
      "Platform jobs retrieved",
      await net.listPlatformJobs(req.userId!, {
        q: str(q.q),
        location: str(q.location),
        remote: str(q.remote),
        seniority: str(q.seniority),
        profession: str(q.profession),
      })
    );
  } catch (e) {
    next(e);
  }
});

hirersRouter.post("/profession", async (req: AuthedRequest, res, next) => {
  try {
    const body = z.object({ profession: z.string().min(1).max(80) }).parse(req.body);
    ok(res, "Profession saved", await net.setProfession(req.userId!, body.profession));
  } catch (e) {
    next(e);
  }
});

const jobPostSchema = z.object({
  company: z.string().min(1).max(120),
  title: z.string().min(1).max(160),
  profession: z.string().min(1).max(80),
  seniority: z.string().max(40).optional(),
  location: z.string().max(120).optional(),
  remote: z.boolean().optional(),
  employment_type: z.enum(["full-time", "part-time", "contract", "internship"]).optional(),
  salary_min: z.number().int().nonnegative().optional(),
  salary_max: z.number().int().nonnegative().optional(),
  currency: z.string().max(8).optional(),
  description: z.string().max(4000).optional(),
  tags: z.array(z.string().max(40)).max(12).optional(),
  contact_email: z.string().email().optional(),
});

hirersRouter.post("/jobs", async (req: AuthedRequest, res, next) => {
  try {
    const body = jobPostSchema.parse(req.body ?? {});
    ok(res, "Job posted", await net.createPlatformJob(req.userId!, body), 201);
  } catch (e) {
    next(e);
  }
});

/* ─────────────────────────────── events ──────────────────────────────── */
export const eventsRouter = Router();
eventsRouter.use(requireAuth);

eventsRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const q = req.query as any;
    ok(
      res,
      "Events retrieved",
      await net.listEvents(req.userId!, {
        q: str(q.q),
        kind: str(q.kind),
        city: str(q.city),
        format: str(q.format),
        when: str(q.when),
      })
    );
  } catch (e) {
    next(e);
  }
});
