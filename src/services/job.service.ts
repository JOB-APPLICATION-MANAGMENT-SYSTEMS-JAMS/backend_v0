import { all, get, run, parseJson } from "../core/db";
import { notFound, validation } from "../core/errors";
import { newId, nowIso } from "../util/id";
import { scorePosting, extractKeywords, type ProfileSignals } from "./scoring.service";
import { profileSignals } from "./profile-signals";

export interface SearchParams {
  q?: string;
  location?: string;
  remote?: "true" | "false" | boolean;
  salary_min?: number;
  seniority?: string;
  source?: string[];
  category?: string;
  posted_within?: number;
  sort?: "score" | "recent";
  page?: number;
  page_size?: number;
  exclude?: string[]; // applied | ignored | seen
}

/** Search: pre-filter in SQL → score+explain in Python-space → facets → paginate (§34.2). */
export async function searchJobs(userId: string, p: SearchParams) {
  const t0 = Date.now();
  const page = Math.max(1, Number(p.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Number(p.page_size ?? 20)));
  const signals = await profileSignals(userId);

  const where: string[] = ["user_id = ?"];
  const args: any[] = [userId];
  where.push("status = 'open'");
  if (p.category) {
    where.push("career_category = ?");
    args.push(p.category);
  }
  if (p.remote === true || p.remote === "true") where.push("remote = 1");
  if (p.seniority) {
    where.push("seniority = ?");
    args.push(p.seniority);
  }
  if (p.source?.length) {
    where.push(`source IN (${p.source.map(() => "?").join(",")})`);
    args.push(...p.source);
  }
  if (p.salary_min) {
    where.push("(salary_max IS NULL OR salary_max >= ?)");
    args.push(Number(p.salary_min));
  }
  if (p.location) {
    where.push("(location IS NULL OR lower(location) LIKE ?)");
    args.push(`%${p.location.toLowerCase()}%`);
  }
  if (p.posted_within) {
    where.push("posted_at >= ?");
    args.push(new Date(Date.now() - Number(p.posted_within) * 86_400_000).toISOString());
  }
  if (p.q) {
    where.push("(lower(title) LIKE ? OR lower(description) LIKE ? OR lower(company_name) LIKE ? OR lower(jd_keywords) LIKE ?)");
    const like = `%${p.q.toLowerCase()}%`;
    args.push(like, like, like, like);
  }

  const exclude = p.exclude ?? ["applied", "ignored"];
  const excludeClauses: string[] = [];
  if (exclude.includes("applied") || exclude.includes("ignored")) {
    excludeClauses.push("id NOT IN (SELECT posting_id FROM job_votes WHERE user_id = ? AND vote IN ('applied','ignore'))");
    args.push(userId);
  }
  if (exclude.includes("seen")) {
    excludeClauses.push("id NOT IN (SELECT posting_id FROM job_votes WHERE user_id = ? AND vote = 'seen')");
    args.push(userId);
  }

  const baseWhere = [...where, ...excludeClauses].join(" AND ");
  const total = (await get<{ n: number }>(`SELECT count(*) AS n FROM job_postings WHERE ${baseWhere}`, ...args))!.n;

  /**
   * Ranking: stored profile score, plus a Nigeria boost (Lagos/Abuja/Ogun/national
   * postings surface first, the product's search scope), plus a title-match bump
   * when a free-text query is present. `score` and the boosts share the 0..100 scale.
   */
  const nigeriaMatch =
    "(lower(COALESCE(location, '')) LIKE '%nigeria%' OR lower(COALESCE(location, '')) LIKE '%lagos%' OR lower(COALESCE(location, '')) LIKE '%abuja%' OR lower(COALESCE(location, '')) LIKE '%ogun%' OR lower(COALESCE(location, '')) LIKE '%ng%')";
  const orderByArgs: any[] = [];
  let orderBy: string;
  if (p.sort === "recent") {
    orderBy = "posted_at DESC, created_at DESC";
  } else {
    let expr = `(COALESCE(score, 0) + CASE WHEN ${nigeriaMatch} THEN 8 ELSE 0 END)`;
    if (p.q) {
      expr += ` + CASE WHEN lower(title) LIKE ? THEN 5 ELSE 0 END`;
      orderByArgs.push(`%${p.q.toLowerCase()}%`);
    }
    orderBy = `${expr} DESC NULLS LAST, posted_at DESC`;
  }
  const rows = await all<any>(
    `SELECT * FROM job_postings WHERE ${baseWhere} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    ...args,
    ...orderByArgs,
    pageSize,
    (page - 1) * pageSize
  );

  const votes = new Map((await all<any>("SELECT posting_id, vote FROM job_votes WHERE user_id = ?", userId)).map((r) => [r.posting_id, r.vote]));

  const items = rows.map((r) => {
    const appliedOrIgnored = ["applied", "ignore"].includes(votes.get(r.id) ?? "");
    const fresh = scorePosting(
      signals,
      {
        title: r.title,
        description: r.description,
        companyName: r.company_name,
        seniority: r.seniority,
        remote: !!r.remote,
        location: r.location,
        salaryMin: r.salary_min,
        salaryMax: r.salary_max,
        postedAt: r.posted_at,
      },
      { appliedOrIgnored, feedbackVote: votes.get(r.id) === "up" ? "up" : votes.get(r.id) === "down" ? "down" : null }
    );
    return {
      id: r.id,
      title: r.title,
      company: { name: r.company_name, id: r.company_id, tier: signals.companyTiers?.[r.company_name.toLowerCase()] ?? null },
      location: r.location,
      remote: !!r.remote,
      salary: r.salary_min || r.salary_max ? { min: r.salary_min, max: r.salary_max, currency: r.currency ?? "USD" } : null,
      seniority: r.seniority,
      source: r.source,
      category: r.career_category,
      url: r.url,
      posted_at: r.posted_at,
      score: fresh.score,
      explain: fresh.explain,
      applied: votes.get(r.id) === "applied",
      ignored: votes.get(r.id) === "ignore",
      keywords: parseJson<string[]>(r.jd_keywords, []),
      description_snippet: (r.description ?? "").slice(0, 320),
    };
  });

  // facets computed on the filtered set (before pagination)
  const facetRows = await all<any>(`SELECT source, remote, seniority, career_category FROM job_postings WHERE ${baseWhere}`, ...args);
  const facets = { source: {} as Record<string, number>, remote: {} as Record<string, number>, seniority: {} as Record<string, number>, category: {} as Record<string, number> };
  for (const r of facetRows) {
    facets.source[r.source] = (facets.source[r.source] ?? 0) + 1;
    facets.remote[String(!!r.remote)] = (facets.remote[String(!!r.remote)] ?? 0) + 1;
    if (r.seniority) facets.seniority[r.seniority] = (facets.seniority[r.seniority] ?? 0) + 1;
    facets.category[r.career_category] = (facets.category[r.career_category] ?? 0) + 1;
  }

  return {
    items,
    facets,
    pagination: { page, page_size: pageSize, total_count: total, total_pages: Math.max(1, Math.ceil(total / pageSize)) },
    took_ms: Date.now() - t0,
    sources_ok: [...new Set(facetRows.map((r) => r.source))],
    sources_failed: [] as string[],
  };
}

export async function getJob(userId: string, id: string) {
  const r = await get("SELECT * FROM job_postings WHERE id = ? AND user_id = ?", id, userId);
  if (!r) throw notFound("Posting");
  const signals = await profileSignals(userId);
  const fresh = scorePosting(signals, {
    title: r.title,
    description: r.description,
    companyName: r.company_name,
    seniority: r.seniority,
    remote: !!r.remote,
    location: r.location,
    salaryMin: r.salary_min,
    salaryMax: r.salary_max,
    postedAt: r.posted_at,
  });
  const vote = await get("SELECT vote FROM job_votes WHERE user_id = ? AND posting_id = ?", userId, id);
  return { ...r, explain: fresh.explain, score: fresh.score, vote: vote?.vote ?? null, keywords: parseJson(r.jd_keywords, []) };
}

export async function voteJob(userId: string, id: string, vote: "up" | "down" | "ignore") {
  const job = await get("SELECT id FROM job_postings WHERE id = ? AND user_id = ?", id, userId);
  if (!job) throw notFound("Posting");
  if (vote === "up" || vote === "down") {
    await run(
      `INSERT INTO job_votes (id, user_id, posting_id, vote, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, posting_id) DO UPDATE SET vote = excluded.vote, created_at = excluded.created_at`,
      newId(),
      userId,
      id,
      vote,
      nowIso()
    );
  } else {
    await run("DELETE FROM job_votes WHERE user_id = ? AND posting_id = ?", userId, id);
    await run(
      `INSERT INTO job_votes (id, user_id, posting_id, vote, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, posting_id) DO UPDATE SET vote = excluded.vote`,
      newId(),
      userId,
      id,
      vote,
      nowIso()
    );
  }
  return { ok: true, vote };
}

export async function listSavedSearches(userId: string) {
  return all("SELECT * FROM saved_searches WHERE user_id = ? ORDER BY created_at DESC", userId);
}
export async function saveSearch(userId: string, name: string, params: any) {
  const id = newId();
  await run("INSERT INTO saved_searches (id, user_id, name, params, created_at) VALUES (?, ?, ?, ?, ?)", id, userId, name, JSON.stringify(params), nowIso());
  return get("SELECT * FROM saved_searches WHERE id = ?", id);
}
export async function deleteSavedSearch(userId: string, id: string) {
  const n = await run("DELETE FROM saved_searches WHERE id = ? AND user_id = ?", id, userId);
  if (!n) throw notFound("Saved search");
  return { deleted: true };
}

export { extractKeywords };
