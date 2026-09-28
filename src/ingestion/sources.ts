import type { JobSource, RawPosting } from "./base";

const UA = { "User-Agent": "JAMS-Ingest/0.1 (personal job tracker)", Accept: "application/json" };

async function getJson(url: string, timeout = 9000): Promise<any> {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

/* ------------------------- Arbeitnow (free, no key) ------------------------- */
const arbeitnow: JobSource = {
  name: "arbeitnow",
  fetch: async () => {
    const data = await getJson("https://www.arbeitnow.com/api/job-board-api");
    return (data.data ?? []).map((j: any): RawPosting => ({
      source: "arbeitnow",
      external_id: String(j.slug),
      title: j.title,
      company: j.company_name,
      location: j.location,
      remote: !!j.remote,
      employment_type: (j.job_types ?? []).join(", ") || null,
      description: j.description ?? "",
      url: j.url,
      posted_at: j.created_at ? new Date(Number(j.created_at) * 1000).toISOString() : null,
    }));
  },
};

/* --------------------------- Remotive (free, no key) -------------------------- */
const remotive: JobSource = {
  name: "remotive",
  fetch: async () => {
    const data = await getJson("https://remotive.com/api/remote-jobs?limit=100");
    return (data.jobs ?? []).map((j: any): RawPosting => ({
      source: "remotive",
      external_id: String(j.id),
      title: j.title,
      company: j.company_name,
      location: j.candidate_required_location || "Remote",
      remote: true,
      category: j.category ?? undefined,
      employment_type: j.job_type ?? null,
      description: (j.description ?? "").replace(/<[^>]+>/g, " ").slice(0, 8000),
      keywords: (j.tags ?? []).slice(0, 12),
      url: j.url,
      posted_at: j.publication_date ?? null,
    }));
  },
};

/* ----------------------------- RemoteOK (free, no key) ----------------------- */
const remoteok: JobSource = {
  name: "remoteok",
  fetch: async () => {
    const data = await getJson("https://remoteok.com/api");
    const rows = Array.isArray(data) ? data.filter((j: any) => j && j.id && j.position) : [];
    return rows.map((j: any): RawPosting => ({
      source: "remoteok",
      external_id: String(j.id),
      title: j.position,
      company: j.company ?? "Unknown",
      location: j.location || "Remote",
      remote: true,
      salary_min: j.salary_min || null,
      salary_max: j.salary_max || null,
      currency: "USD",
      description: (j.description ?? "").replace(/<[^>]+>/g, " ").slice(0, 8000),
      keywords: (j.tags ?? []).slice(0, 12),
      url: j.url ?? j.apply_url ?? `https://remoteok.com/l/${j.id}`,
      posted_at: j.date ?? null,
    }));
  },
};

/* ------------------------ Hacker News “Who's hiring” (free) ------------------- */
const hackernews: JobSource = {
  name: "hn",
  fetch: async () => {
    const data = await getJson("https://hn.algolia.com/api/v1/search_by_date?query=%22is%20hiring%22&tags=story&hitsPerPage=40");
    return (data.hits ?? [])
      .filter((h: any) => h.title && /hiring/i.test(h.title) && h.url)
      .map((h: any): RawPosting => {
        const title = h.title.replace(/^(Ask HN|Show HN):\s*/i, "");
        const company = title.split(/\s+is hiring/i)[0]?.trim() || "Unknown";
        return {
          source: "hn",
          external_id: String(h.objectID),
          title: title.slice(0, 140),
          company: company.slice(0, 80),
          location: null,
          remote: null as any,
          description: h.story_text ?? "",
          url: h.url,
          posted_at: h.created_at ?? null,
        };
      });
  },
};

/* --------------- Greenhouse / Lever / Ashby public boards (free) -------------- */
const boardSlug = (envVar: string, fallback: string[]) => (process.env[envVar] ?? fallback.join(",")).split(",").map((s) => s.trim()).filter(Boolean);

const greenhouseBoards = boardSlug("GREENHOUSE_BOARDS", ["stripe", "airbnb", "datadog", "dropbox", "cloudflare"]);
const greenhouse: JobSource = {
  name: "greenhouse",
  fetch: async () => {
    const out: RawPosting[] = [];
    await Promise.all(
      greenhouseBoards.map(async (slug) => {
        try {
          const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=false`);
          for (const j of (data.jobs ?? []).slice(0, 60)) {
            out.push({
              source: "greenhouse",
              external_id: `${slug}-${j.id}`,
              title: j.title,
              company: slug,
              location: j.location?.name ?? null,
              remote: /remote/i.test(j.location?.name ?? ""),
              description: "",
              url: j.absolute_url ?? j.url,
              posted_at: j.updated_at ?? j.first_published ?? null,
            });
          }
        } catch {
          /* per-board failures don't sink the source */
        }
      })
    );
    if (!out.length) throw new Error("greenhouse: all boards failed");
    return out;
  },
};

const leverBoards = boardSlug("LEVER_BOARDS", ["netflix", "spotify", "figma", "palantir"]);
const lever: JobSource = {
  name: "lever",
  fetch: async () => {
    const out: RawPosting[] = [];
    await Promise.all(
      leverBoards.map(async (slug) => {
        try {
          const data = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
          for (const j of (Array.isArray(data) ? data : []).slice(0, 60)) {
            out.push({
              source: "lever",
              external_id: `${slug}-${j.id}`,
              title: j.text,
              company: slug,
              location: j.categories?.location ?? null,
              remote: /remote/i.test(j.categories?.location ?? ""),
              employment_type: j.categories?.commitment ?? null,
              description: (j.description ?? "").replace(/<[^>]+>/g, " ").slice(0, 6000),
              url: j.hostedUrl,
              posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
            });
          }
        } catch {
          /* ignore per-board failure */
        }
      })
    );
    if (!out.length) throw new Error("lever: all boards failed");
    return out;
  },
};

const ashbyBoards = boardSlug("ASHBY_BOARDS", ["linear", "notion", "ramp"]);
const ashby: JobSource = {
  name: "ashby",
  fetch: async () => {
    const out: RawPosting[] = [];
    await Promise.all(
      ashbyBoards.map(async (slug) => {
        try {
          const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
          for (const j of (data.jobs ?? []).slice(0, 60)) {
            out.push({
              source: "ashby",
              external_id: `${slug}-${j.id}`,
              title: j.title,
              company: slug,
              location: j.location ?? null,
              remote: !!j.isRemote,
              description: "",
              url: j.jobUrl ?? j.applyUrl,
              posted_at: j.publishedAt ?? null,
            });
          }
        } catch {
          /* ignore per-board failure */
        }
      })
    );
    if (!out.length) throw new Error("ashby: all boards failed");
    return out;
  },
};

export const SOURCES: JobSource[] = [arbeitnow, remotive, remoteok, hackernews, greenhouse, lever, ashby];
