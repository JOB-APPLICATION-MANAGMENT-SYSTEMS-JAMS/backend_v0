/**
 * Demo seed (§30 data/seeds): one user, a filled profile, CVs, templates, companies,
 * ~90 days of applications/events/streak history and offline demo job postings —
 * so every screen (KPI wall, funnel, heatmap, tracker, discover) has honest data
 * without needing network or a mailbox.
 *
 * Run: pnpm seed
 */
import { all, get, run, tx } from "../src/core/db";
import { newId, nowIso } from "../src/util/id";
import { hashPassword } from "../src/core/security";
import { dedupeKey, inferSeniority } from "../src/ingestion/base";

const DEMO_EMAIL = "demo@jams.local";
const TZ = "Africa/Lagos";
const GOAL = 20;

const COMPANIES: [string, string, string | null][] = [
  ["Northwind Pay", "dream", "https://boards.greenhouse.io/northwind"],
  ["Lumen Analytics", "reach", "https://jobs.lever.co/lumen"],
  ["Kestrel Labs", "safety", "https://kestrellabs.com/careers"],
  ["Orbital Freight", "reach", null],
  ["Verdant Health", "dream", null],
  ["Copperline Bank", "safety", null],
  ["Halcyon Studio", "reach", null],
  ["Ridgeway Robotics", "safety", null],
  ["Sable Cloud", "reach", null],
  ["Fernpath AI", "dream", null],
];

const SKILLS = [
  ["TypeScript", 1, 5], ["React", 1, 5], ["Node.js", 1, 4], ["Next.js", 1, 3], ["PostgreSQL", 1, 4],
  ["Python", 1, 3], ["GraphQL", 0, 2], ["Docker", 0, 3], ["AWS", 0, 3], ["Redis", 0, 2],
  ["Tailwind CSS", 0, 3], ["Kafka", 0, 1],
] as [string, number, number][];

const TITLES = [
  "Senior Frontend Engineer", "Full-Stack Engineer", "Backend Engineer (Payments)", "Platform Engineer",
  "Product Engineer", "Software Engineer II", "React Developer", "Node.js Engineer", "Infrastructure Engineer",
  "Software Engineer, Growth", "Staff Software Engineer", "Developer Experience Engineer",
];

const SOURCES = ["greenhouse", "lever", "arbeitnow", "remotive", "remoteok", "hn", "ashby", "manual"];

/** Deterministic PRNG so reseeding gives stable-looking history. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

async function main() {
  const existing = get("SELECT id FROM users WHERE email = ?", DEMO_EMAIL);
  if (existing && process.argv.includes("--force")) {
    run("DELETE FROM users WHERE id = ?", existing.id);
  } else if (existing) {
    console.log(`Seed already present: ${DEMO_EMAIL} (use --force to reseed)`);
    return;
  }

  const rand = rng(20260927);
  const now = new Date();
  const userId = newId();
  const passwordHash = await hashPassword("demo1234");

  tx(() => {
    run(
      `INSERT INTO users (id, email, password_hash, provider, verified, goal_default, timezone, created_at, updated_at)
       VALUES (?, ?, ?, 'email', 1, ?, ?, ?, ?)`,
      userId,
      DEMO_EMAIL,
      passwordHash,
      GOAL,
      TZ,
      now.toISOString(),
      now.toISOString()
    );
    const profileId = newId();
    const identity = {
      name: "Israel Iraoya",
      first_name: "Israel",
      last_name: "Iraoya",
      headline: "Full-Stack Engineer — TypeScript, React, Node, PostgreSQL",
      email: DEMO_EMAIL,
      phone: "+234 800 000 0000",
      location: "Lagos, Nigeria",
      work_authorization: "Nigeria / remote-friendly",
      salary_expectation: 95000,
      links: { github: "https://github.com/example", linkedin: "https://linkedin.com/in/example", website: "https://israel.dev" },
      pitch: "I build typed, well-tested product surfaces end-to-end — six years shipping React/Node systems that hold up under real load.",
      pitch_variants: [
        "Full-stack engineer who likes the boring parts: schemas, migrations, observability.",
        "I turn ambiguous product asks into shipped software with tests and telemetry.",
      ],
      visibility: { "identity.salary_expectation": true },
    };
    const prefs = {
      seniority: "senior",
      remote: true,
      locations: ["Remote", "Lagos", "Europe"],
      salary_expectation: 95000,
      target_titles: ["Senior Frontend Engineer", "Full-Stack Engineer", "Product Engineer"],
      categories: ["software_engineering"],
    };
    run(
      "INSERT INTO profiles (id, user_id, identity, prefs, aliases, version, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?)",
      profileId,
      userId,
      JSON.stringify(identity),
      JSON.stringify(prefs),
      JSON.stringify({ "identity.headline": ["Current position", "About you"] }),
      now.toISOString()
    );
    SKILLS.forEach(([name, top, years], i) =>
      run("INSERT INTO profile_skills (id, profile_id, name, level, years, is_top5, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)", newId(), profileId, name, years >= 4 ? "advanced" : "intermediate", years, top, i)
    );
    run(
      `INSERT INTO profile_experiences (id, profile_id, company, title, start_date, end_date, location, bullets, sort_order)
       VALUES (?, ?, 'Fernpath AI', 'Senior Software Engineer', '2022-03', NULL, 'Remote', ?, 0)`,
      newId(),
      profileId,
      JSON.stringify([
        "Led migration of a 140-route React app to Next.js App Router — LCP down 42%",
        "Designed event-sourced billing pipeline (Postgres + Redis) handling 2.1M jobs/month",
        "Mentored 4 engineers; introduced contract tests that cut regressions by a third",
      ])
    );
    run(
      `INSERT INTO profile_experiences (id, profile_id, company, title, start_date, end_date, location, bullets, sort_order)
       VALUES (?, ?, 'Copperline Bank', 'Software Engineer', '2019-07', '2022-02', 'Lagos', ?, 1)`,
      newId(),
      profileId,
      JSON.stringify(["Built KYC onboarding flows used by 400k customers", "Shipped internal design system with 60+ components"])
    );
    run(
      `INSERT INTO profile_education (id, profile_id, school, degree, field, start_date, end_date, sort_order)
       VALUES (?, ?, 'University of Lagos', 'B.Sc', 'Computer Science', '2015', '2019', 0)`,
      newId(),
      profileId
    );

    /* companies + contacts */
    const companyIds: string[] = [];
    for (const [name, tier, careers] of COMPANIES) {
      const cid = newId();
      companyIds.push(cid);
      run(
        "INSERT INTO companies (id, user_id, name, domain, tier, careers_url, stack, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        cid,
        userId,
        name,
        String(name).toLowerCase().replace(/\s+/g, "") + ".com",
        tier,
        careers,
        JSON.stringify(["TypeScript", "PostgreSQL", "AWS"]),
        tier === "dream" ? "Follow up via engineering blog" : null,
        now.toISOString(),
        now.toISOString()
      );
      run(
        "INSERT INTO contacts (id, user_id, company_id, name, role, email, source_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        newId(),
        userId,
        cid,
        `Recruiter at ${name}`,
        "Talent Partner",
        `talent@${String(name).toLowerCase().replace(/\s+/g, "")}.com`,
        "careers page",
        now.toISOString()
      );
    }

    /* templates (archetypes A/B, §20.2) */
    const tplOpening = newId();
    run(
      `INSERT INTO templates (id, user_id, kind, archetype, name, subject, body, variables, created_at, updated_at)
       VALUES (?, ?, 'email', 'opening', 'Opening — evidence first', ?, ?, ?, ?, ?)`,
      tplOpening,
      userId,
      "{{role}} at {{company}} — {{profile.headline}}",
      `Hi {{contact.first_name | default: "hiring team"}},\n\nI applied for {{role}} at {{company}}. My {{profile.years | default: "6"}} years building TypeScript/React/Node systems maps directly to your need for {{jd_keywords}}.\n\nCV attached — happy to walk through any of it.\n\nBest,\n{{profile.name}}`,
      JSON.stringify(["role", "company", "contact.first_name", "jd_keywords"]),
      now.toISOString(),
      now.toISOString()
    );
    const tplPitch = newId();
    run(
      `INSERT INTO templates (id, user_id, kind, archetype, name, subject, body, variables, created_at, updated_at)
       VALUES (?, ?, 'email', 'pitch', 'Pitch — no opening', ?, ?, ?, ?, ?)`,
      tplPitch,
      userId,
      "Ideas for {{company}} — {{profile.headline}}",
      `Hi {{contact.first_name | default: "hiring team"}},\n\nNoticed {{company_initiative | default: "your recent work"}} — the problem I'd love to help with is {{pain_point | default: "scaling the platform without slowing the team"}}. One proof point: {{proof_link | default: "my open-source work"}}.\n\nWorth a 15-minute chat?\n\n{{profile.name}}`,
      JSON.stringify(["company", "company_initiative", "pain_point", "proof_link"]),
      now.toISOString(),
      now.toISOString()
    );
    run(
      `INSERT INTO templates (id, user_id, kind, archetype, name, subject, body, variables, created_at, updated_at)
       VALUES (?, ?, 'cv', 'opening', 'Compact single column', NULL, 'single-column compact layout', '[]', ?, ?)`,
      newId(),
      userId,
      now.toISOString(),
      nowIso()
    );

    /* CVs */
    const cv1 = newId();
    run(
      `INSERT INTO cvs (id, user_id, profile_id, name, archetype, career_category, targeting, blocks, template_id, lineage, created_at, updated_at)
       VALUES (?, ?, ?, 'Full-Stack — general (opening)', 'opening', 'software_engineering', ?, ?, NULL, '{}', ?, ?)`,
      cv1,
      userId,
      profileId,
      JSON.stringify({ seniority: ["mid", "senior"], keywords: ["typescript", "react", "node", "postgres"], suggested_when: "score ≥ 0.65" }),
      JSON.stringify([
        { type: "summary", source: "local", text: identity.pitch },
        { type: "experience", source: "profile" },
        { type: "skills", source: "profile" },
        { type: "education", source: "profile" },
      ]),
      now.toISOString(),
      now.toISOString()
    );
    const cv2 = newId();
    run(
      `INSERT INTO cvs (id, user_id, profile_id, name, archetype, career_category, targeting, blocks, template_id, lineage, created_at, updated_at)
       VALUES (?, ?, ?, 'Pitch — impact story', 'pitch', 'software_engineering', ?, ?, NULL, ?, ?, ?)`,
      cv2,
      userId,
      profileId,
      JSON.stringify({ seniority: ["senior", "staff"], keywords: ["platform", "infrastructure", "growth"], companies: ["Fernpath AI", "Verdant Health"] }),
      JSON.stringify([
        { type: "summary", source: "local", text: "Projects and wins over keyword matching — the story version." },
        { type: "experience", source: "profile" },
        { type: "skills", source: "profile" },
      ]),
      JSON.stringify({ forked_from: cv1, forked_at: now.toISOString() }),
      now.toISOString(),
      now.toISOString()
    );

    /* demo job postings (offline — discover works with zero network) */
    for (let i = 0; i < 64; i++) {
      const company = COMPANIES[Math.floor(rand() * COMPANIES.length)][0];
      const title = TITLES[Math.floor(rand() * TITLES.length)];
      const daysAgo = Math.floor(rand() * 13);
      const posted = new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
      const remote = rand() > 0.3;
      const salMin = 70000 + Math.floor(rand() * 6) * 10000;
      const source = SOURCES[Math.floor(rand() * SOURCES.length)];
      run(
        `INSERT INTO job_postings (id, user_id, company_name, source, external_id, title, location, remote, salary_min, salary_max, currency,
           seniority, career_category, description, jd_keywords, url, posted_at, first_seen_at, last_seen_at, score, explain, dedupe_key, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, 'software_engineering', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
        newId(),
        userId,
        company,
        source,
        `demo-${i}`,
        title,
        remote ? "Remote" : "Lagos / Hybrid",
        remote ? 1 : 0,
        salMin,
        salMin + 40000,
        inferSeniority(title),
        `We are looking for a ${title.toLowerCase()} with TypeScript, React, Node.js and PostgreSQL. You will own services end-to-end, ship with tests, and improve developer experience. Kubernetes and Redis a plus.`,
        JSON.stringify(["typescript", "react", "node", "postgres", "aws"]),
        `https://example.com/jobs/demo-${i}`,
        posted,
        posted,
        now.toISOString(),
        55 + Math.round(rand() * 40),
        JSON.stringify([
          { factor: "skills", weight: 0.35, points: 28.4, why: "typescript, react, node overlap" },
          { factor: "title", weight: 0.2, points: 15.2, why: "matches your target titles" },
          { factor: "freshness", weight: 0.1, points: 8.1, why: `posted ${daysAgo}d ago` },
        ]),
        dedupeKey(title, company, remote ? "Remote" : "Lagos"),
        now.toISOString()
      );
    }

    /* ~90 days of application history + events + streaks */
    let streak = 0;
    let anyStreak = 0;
    for (let d = 90; d >= 0; d--) {
      const dayDate = new Date(now.getTime() - d * 86_400_000);
      const day = dayDate.toISOString().slice(0, 10);
      const weekend = [0, 6].includes(dayDate.getUTCDay());
      const wave = Math.sin((90 - d) / 7) * 0.5 + 0.5;
      let count = Math.round(rand() * (weekend ? 12 : 26) * wave + rand() * 4);
      if (d < 7 && rand() > 0.25) count = Math.max(count, 20 + Math.floor(rand() * 6)); // recent hot streak
      if (rand() < 0.12) count = Math.min(count, 6); // a few bad days → honest dips
      let todayEffort = 0;
      let goalHit = false;

      for (let i = 0; i < count; i++) {
        const company = COMPANIES[Math.floor(rand() * COMPANIES.length)];
        const title = TITLES[Math.floor(rand() * TITLES.length)];
        const source = SOURCES[Math.floor(rand() * SOURCES.length)];
        const appId = newId();
        const appliedAt = new Date(dayDate.getTime() + Math.floor(rand() * 10) * 3600_000).toISOString();
        const roll = rand();
        let status = "applied";
        let repliedAt: string | null = null;
        let ghostedAt: string | null = null;
        let firstReplyDays: number | null = null;

        if (roll < 0.02) status = "offer";
        else if (roll < 0.09) status = "interview";
        else if (roll < 0.26) {
          status = "rejected";
          firstReplyDays = Number((1 + rand() * 10).toFixed(1));
          repliedAt = new Date(new Date(appliedAt).getTime() + firstReplyDays * 86_400_000).toISOString();
        } else if (roll < 0.36) {
          status = "viewed";
          repliedAt = null;
        } else if (d > 14 && rand() < 0.85) {
          status = "ghosted";
          ghostedAt = new Date(new Date(appliedAt).getTime() + 14 * 86_400_000).toISOString();
        }

        const kind = rand() < 0.15 ? "pitch" : "application";
        const cid = companyIds[COMPANIES.findIndex((c) => c[0] === company[0])];
        run(
          `INSERT INTO applications (id, user_id, company_id, posting_id, contact_id, kind, status, cv_id, template_id, role_title, company_name, source, url,
             applied_at, replied_at, first_reply_days, ghosted_at, capture, notes, tags, created_at, updated_at)
           VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, '[]', ?, ?)`,
          appId,
          userId,
          cid,
          kind,
          status,
          kind === "pitch" ? cv2 : cv1,
          kind === "pitch" ? tplPitch : tplOpening,
          title,
          company[0],
          source,
          `https://example.com/jobs/${appId.slice(0, 8)}`,
          appliedAt,
          repliedAt,
          firstReplyDays,
          ghostedAt,
          d % 5 === 0 ? "Tailored CV for fintech roles" : null,
          appliedAt,
          appliedAt
        );
        run("INSERT INTO application_events (app_id, type, at, actor, payload) VALUES (?, 'created', ?, 'user', ?)", appId, appliedAt, JSON.stringify({ status: "saved" }));
        run("INSERT INTO application_events (app_id, type, at, actor, payload) VALUES (?, 'applied', ?, 'user', null)", appId, appliedAt);
        if (repliedAt) run("INSERT INTO application_events (app_id, type, at, actor, payload) VALUES (?, 'reply', ?, 'system', ?)", appId, repliedAt, JSON.stringify({ classification: status === "rejected" ? "rejected" : "interested" }));
        if (status === "rejected") run("INSERT INTO application_events (app_id, type, at, actor, payload) VALUES (?, 'status_changed', ?, 'system', ?)", appId, repliedAt, JSON.stringify({ from: "applied", to: "rejected" }));
        if (status === "interview" || status === "offer") {
          run("INSERT INTO application_events (app_id, type, at, actor, payload) VALUES (?, 'status_changed', ?, 'user', ?)", appId, appliedAt, JSON.stringify({ from: "applied", to: status }));
        }
        if (status === "ghosted") run("INSERT INTO application_events (app_id, type, at, actor, payload) VALUES (?, 'ghosted', ?, 'system', null)", appId, ghostedAt);

        todayEffort += 1;
        if (todayEffort >= GOAL) goalHit = true;
      }

      if (count > 0) anyStreak = anyStreak + 1;
      else anyStreak = 0;
      if (goalHit) streak = streak + 1;
      else streak = 0;
      run(
        `INSERT INTO streak_events (day, user_id, applications, goal, hit, streak_value, any_streak, frozen)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(user_id, day) DO UPDATE SET applications = excluded.applications`,
        day,
        userId,
        Math.min(todayEffort, count),
        GOAL,
        goalHit ? 1 : 0,
        streak,
        anyStreak
      );
      run(
        `INSERT INTO daily_rollups (day, user_id, metrics) VALUES (?, ?, '{}')
         ON CONFLICT(user_id, day) DO NOTHING`,
        day,
        userId
      );
    }

    /* outreach + threads + inbound messages for a few applications */
    const apps = all<any>("SELECT id, company_name, role_title, replied_at FROM applications WHERE user_id = ? AND replied_at IS NOT NULL LIMIT 8", userId);
    for (const app of apps) {
      const oid = newId();
      const sentAt = app.replied_at;
      run(
        `INSERT INTO outreach_messages (id, user_id, app_id, template_id, step_no, subject, body, state, sent_at, tracking_token, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?, 'sent', ?, ?, ?, ?)`,
        oid,
        userId,
        app.id,
        tplPitch,
        `${app.role_title} at ${app.company_name} — quick note`,
        `Hi there,\n\nRe: ${app.role_title}. Happy to share more context.\n\nBest,\nIsrael`,
        sentAt,
        newId().slice(0, 24),
        sentAt,
        sentAt
      );
      const tid = newId();
      run("INSERT INTO threads (id, user_id, outreach_id, subject, status, created_at) VALUES (?, ?, ?, ?, 'replied', ?)", tid, userId, oid, `Re: ${app.role_title} at ${app.company_name}`, sentAt);
      run("INSERT INTO application_events (app_id, type, at, actor, payload) VALUES (?, 'emailed', ?, 'user', null)", app.id, sentAt);
      run(
        `INSERT INTO email_messages (id, user_id, thread_id, outreach_id, message_id, direction, subject, from_addr, to_addr, body, classification, received_at)
         VALUES (?, ?, ?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?)`,
        newId(),
        userId,
        tid,
        oid,
        newId(),
        `Re: ${app.role_title} at ${app.company_name}`,
        `recruiter@${app.company_name.toLowerCase().replace(/\s+/g, "")}.com`,
        DEMO_EMAIL,
        "Thanks for reaching out — the team had a look and we'd like to schedule a conversation next week. Are you free Tuesday or Wednesday?",
        "interview_invite",
        sentAt
      );
    }

    /* mailboxes (local mode: none connected — MailPit-equivalent) */
    run(
      `INSERT INTO mailboxes (id, user_id, kind, address, config, open_tracking, created_at) VALUES (?, ?, 'imap', ?, '{}', 0, ?)`,
      newId(),
      userId,
      DEMO_EMAIL,
      now.toISOString()
    );

    /* source registry */
    for (const s of ["arbeitnow", "remotive", "remoteok", "hn", "greenhouse", "lever", "ashby"]) {
      run(
        `INSERT INTO sources (name, enabled, last_run_at, items_found, error_streak, last_error) VALUES (?, 1, NULL, 0, 0, NULL)
         ON CONFLICT(name) DO NOTHING`,
        s
      );
    }
  });

  const counts = {
    applications: get<{ n: number }>("SELECT count(*) AS n FROM applications WHERE user_id = ?", userId)!.n,
    postings: get<{ n: number }>("SELECT count(*) AS n FROM job_postings WHERE user_id = ?", userId)!.n,
    streak_days: get<{ n: number }>("SELECT count(*) AS n FROM streak_events WHERE user_id = ?", userId)!.n,
  };
  console.log("Seed complete ✔");
  console.log(`  demo login : ${DEMO_EMAIL} / demo1234`);
  console.log(`  applications: ${counts.applications} · postings: ${counts.postings} · streak days: ${counts.streak_days}`);
}

main().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});
