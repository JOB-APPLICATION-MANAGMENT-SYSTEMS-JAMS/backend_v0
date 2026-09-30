/**
 * Social platform search recipes (§25.4).
 *
 * Social feeds have no public API, so instead of scraping we hand the user
 * ready-to-run searches: a tuned query string per platform plus the exact URL
 * to open. The default focus is software engineering roles in Nigeria
 * (Lagos, Abuja, Ogun + nationwide), matching the product's search scope.
 */

export type SocialPlatform = "x" | "linkedin" | "facebook" | "instagram" | "tiktok" | "snapchat" | "telegram" | "whatsapp";

export const SOCIAL_PLATFORMS: SocialPlatform[] = ["x", "linkedin", "facebook", "instagram", "tiktok", "snapchat", "telegram", "whatsapp"];

export const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  x: "X (Twitter)",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
  snapchat: "Snapchat",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
};

/** Role terms for the default query; kept software-engineering only (§1 scope). */
const ROLES = "software engineer OR frontend OR backend OR \"full stack\" OR devops OR \"mobile developer\"";
const LOCS = "Lagos OR Abuja OR Ogun OR Nigeria";
const INTENT = "hiring OR job OR vacancy OR \"apply\"";

/** Base keyword string a human can paste anywhere. */
export function baseQuery(q?: string): string {
  const term = (q ?? "").trim();
  return term ? `${term} ${LOCS}` : `${ROLES} ${INTENT} ${LOCS}`;
}

const enc = encodeURIComponent;

/** Google site: search — the reliable fallback for platforms without public search. */
const siteSearch = (site: string, query: string) => `https://www.google.com/search?q=${enc(`site:${site} ${query}`)}`;

/** Per-platform prepared searches for a given free-text query. */
export function platformSearches(q?: string): { platform: SocialPlatform; label: string; query: string; url: string; note: string }[] {
  const base = baseQuery(q);
  const recent = `${base} hiring 2026`;
  return [
    {
      platform: "x",
      label: PLATFORM_LABELS.x,
      query: `${base} since:30d`,
      url: `https://x.com/search?f=live&q=${enc(`${base} since:30d`)}`,
      note: "Live tab surfaces recruiters posting today; founders in Nigeria often tweet openings first.",
    },
    {
      platform: "linkedin",
      label: PLATFORM_LABELS.linkedin,
      query: base,
      url: `https://www.linkedin.com/jobs/search?keywords=${enc(q?.trim() || "software engineer")}&location=${enc("Nigeria")}&f_TPR=r604800`,
      note: "Jobs posted in the last 7 days, Nigeria; the strongest source of formal openings.",
    },
    {
      platform: "facebook",
      label: PLATFORM_LABELS.facebook,
      query: base,
      url: `https://www.facebook.com/jobs/search/?q=${enc(q?.trim() || "software engineer")}&location=${enc("Nigeria")}`,
      note: "Facebook Jobs plus hiring groups; strong for SME and local company roles.",
    },
    {
      platform: "instagram",
      label: PLATFORM_LABELS.instagram,
      query: recent,
      url: siteSearch("instagram.com", recent),
      note: "Agencies and studios post carousels with hiring slides; site: search beats the in-app tag feed.",
    },
    {
      platform: "tiktok",
      label: PLATFORM_LABELS.tiktok,
      query: `${base} hiring`,
      url: `https://www.tiktok.com/search?q=${enc(`${q?.trim() || "software engineer"} hiring nigeria`)}`,
      note: "Rising channel for recruiter content; search the spoken form: 'tech jobs in Lagos'.",
    },
    {
      platform: "snapchat",
      label: PLATFORM_LABELS.snapchat,
      query: recent,
      url: siteSearch("snapchat.com", recent),
      note: "No open web search, so a Google site: query is the workable path.",
    },
    {
      platform: "telegram",
      label: PLATFORM_LABELS.telegram,
      query: `${base} channel`,
      url: siteSearch("t.me", `${LOCS} jobs software`),
      note: "Job channels repost daily; once you find one, subscribe and let it come to you.",
    },
    {
      platform: "whatsapp",
      label: PLATFORM_LABELS.whatsapp,
      query: `${base} group`,
      url: siteSearch("chat.whatsapp.com", `nigeria software jobs`),
      note: "Invite-only groups; find the public invite link via Google, then join once.",
    },
  ];
}

/** A shortlist of suggested free-text searches for the query bar. */
export function suggestedQueries(q?: string): string[] {
  const term = (q ?? "").trim();
  if (term) return [`${term} Lagos`, `${term} Abuja`, `${term} Nigeria remote`, `${term} Ogun`];
  return [
    "software engineer Lagos",
    "frontend developer Abuja",
    "backend engineer Nigeria remote",
    "full stack developer Ogun",
    "devops engineer Nigeria",
    "mobile developer Lagos hiring",
  ];
}
