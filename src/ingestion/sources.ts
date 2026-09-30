import type { JobSource, RawPosting } from "./base";

const UA = { "User-Agent": "JAMS-Ingest/0.1 (personal job tracker)", Accept: "application/json" };
const BROWSER_UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", Accept: "*/*" };

async function getJson(url: string, timeout = 9000, headers: Record<string, string> = UA): Promise<any> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

const stripTags = (s: string): string => (s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;?/gi, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/* ------------------------- Arbeitnow (free, no key) ------------------------- */
const arbeitnow: JobSource = {
  name: "arbeitnow",
  fetch: async () => {
    // the board paginates (100/page, hourly updates): three pages per run keeps the
    // index fresh without re-reading the whole archive every refresh
    const out: RawPosting[] = [];
    for (let page = 1; page <= 3; page++) {
      const data = await getJson(`https://www.arbeitnow.com/api/job-board-api?page=${page}`);
      const rows = data.data ?? [];
      for (const j of rows) {
        out.push({
          source: "arbeitnow",
          external_id: String(j.slug),
          title: j.title,
          company: j.company_name,
          location: j.location,
          remote: !!j.remote,
          employment_type: (j.job_types ?? []).join(", ") || null,
          description: stripTags(j.description ?? "").slice(0, 8000),
          keywords: (j.tags ?? []).slice(0, 12),
          url: j.url,
          posted_at: j.created_at ? new Date(Number(j.created_at) * 1000).toISOString() : null,
        });
      }
      if (rows.length < 100) break;
      if (page < 3) await new Promise((r) => setTimeout(r, 400));
    }
    if (!out.length) throw new Error("arbeitnow: empty response");
    return out;
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

/* --------------- Hacker News “Who is hiring” thread (free, emails in text) ------ */
/** Latest monthly “Ask HN: Who is hiring?” thread, else the freshest hiring thread. */
async function whoIsHiringStoryId(): Promise<string | null> {
  const data = await getJson(
    "https://hn.algolia.com/api/v1/search_by_date?query=%22Ask%20HN%3A%20Who%20is%20hiring%3F%22&tags=story&hitsPerPage=20"
  );
  const hits = (data.hits ?? []).filter((h: any) => /^Ask HN:\s*Who is hiring/i.test(h.title ?? ""));
  const fresh = hits.find((h: any) => Date.now() - Date.parse(h.created_at) < 60 * 86_400_000) ?? hits[0];
  return fresh ? String(fresh.objectID) : null;
}

const hnComments: JobSource = {
  name: "hn",
  fetch: async () => {
    const storyId = await whoIsHiringStoryId();
    if (!storyId) throw new Error("hn: no hiring thread found");
    const out: RawPosting[] = [];
    // comment blocks are `Company | Role | Location | …`; many publish an inbox
    for (let page = 0; page < 3; page++) {
      const data = await getJson(`https://hn.algolia.com/api/v1/search?tags=comment,story_${storyId}&hitsPerPage=100&page=${page}`);
      const hits = data.hits ?? [];
      for (const h of hits) {
        const text = stripTags(h.comment_text ?? "");
        if (text.length < 80) continue; // replies and “interested” one-liners
        const line = (h.comment_text ?? "").replace(/<[^>]+>/g, "").split("\n")[0].trim();
        const parts = line.split("|").map((s: string) => s.trim()).filter(Boolean);
        const company = (parts[0] ?? "Unknown").slice(0, 80);
        // the location column is the 3rd pipe field; ads that put prose there would
        // otherwise render a whole paragraph where a city belongs
        const rawLocation = parts[2] ?? null;
        const location = rawLocation && rawLocation.length <= 60 && !/[.;:]/.test(rawLocation) ? rawLocation : null;
        out.push({
          source: "hn",
          external_id: String(h.objectID),
          title: (parts[1] ? `${parts[1]} — ${company}` : line.slice(0, 120)).slice(0, 140),
          company,
          location,
          remote: /remote/i.test(location ?? "") || /remote/i.test(text.slice(0, 300)),
          description: text.slice(0, 8000),
          url: `https://news.ycombinator.com/item?id=${h.objectID}`,
          posted_at: h.created_at ?? null,
        });
      }
      if (hits.length < 100) break;
      await new Promise((r) => setTimeout(r, 350));
    }
    if (!out.length) throw new Error("hn: thread had no parseable comments");
    return out;
  },
};

/* ------------------ Working Nomads RSS (free, no key) ---------------------- */
const wwr: JobSource = {
  name: "wwr",
  fetch: async () => {
    const res = await fetch("https://weworkremotely.com/categories/remote-programming-jobs.rss", {
      headers: BROWSER_UA,
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for working nomads rss`);
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
    return items.map((block, i): RawPosting => {
      const tag = (name: string) => (block.match(new RegExp(`<${name}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${name}>`)) ?? [])[1]?.trim() ?? "";
      const title = stripTags(tag("title"));
      const link = tag("link");
      const company = title.split(/\s+[–—|]\s+/).slice(-1)[0]?.trim() || "Unknown";
      return {
        source: "wwr",
        external_id: link || `wwr-${i}`,
        title: title.slice(0, 140),
        company: company.slice(0, 80),
        location: "Remote",
        remote: true,
        description: stripTags(tag("description")).slice(0, 6000),
        url: link,
        posted_at: tag("pubDate") ? new Date(tag("pubDate")).toISOString() : null,
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

/* ------------------------------ Jobicy (free, no key) ---------------------------- */
const jobicy: JobSource = {
  name: "jobicy",
  fetch: async () => {
    // the `tag=software-dev` filter now returns zero rows; the unfiltered feed is
    // still the remote-tech board it always was (and jobicy asks for attribution)
    const data = await getJson("https://jobicy.com/api/v2/remote-jobs?count=50");
    return (data.jobs ?? []).map((j: any): RawPosting => ({
      source: "jobicy",
      external_id: String(j.id),
      title: j.jobTitle,
      company: j.companyName,
      location: j.jobGeo || j.jobRegion || "Remote",
      remote: true,
      salary_min: j.salaryMin ?? null,
      salary_max: j.salaryMax ?? null,
      currency: j.salaryCurrency ?? null,
      employment_type: j.jobType ?? null,
      description: `${j.intro ?? ""}\n${(j.description ?? "").replace(/<[^>]+>/g, " ")}`.trim().slice(0, 8000),
      keywords: (j.tags ?? []).slice(0, 12),
      url: j.url,
      posted_at: j.pubDate ?? null,
    }));
  },
};

export const SOURCES: JobSource[] = [arbeitnow, remotive, remoteok, jobicy, hnComments, wwr, greenhouse, lever, ashby];
