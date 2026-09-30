/**
 * DDL, SQLite dialect of the §32 data model.
 * Same table/column shapes as the Postgres blueprint so a future swap is mechanical:
 * UUID text ids, ISO-8601 timestamps, JSON stored as TEXT (parsed at the edges),
 * append-only application_events / streak_events as the analytics truth.
 *
 * SCHEMA_PG below is derived from this single source, the only dialect difference
 * in the whole file is the AUTOINCREMENT column (Postgres uses identity columns).
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  password_hash   TEXT,
  provider        TEXT NOT NULL DEFAULT 'email',
  verified        INTEGER NOT NULL DEFAULT 0,
  verification_token TEXT,
  suspended       INTEGER NOT NULL DEFAULT 0,
  goal_default    INTEGER NOT NULL DEFAULT 20,
  timezone        TEXT NOT NULL DEFAULT 'Africa/Lagos',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  identity     TEXT NOT NULL DEFAULT '{}',   -- JSON: name, headline, email, phone, location, work_auth, salary, links, pitch variants
  prefs        TEXT NOT NULL DEFAULT '{}',   -- JSON: seniority, remote, locations, salary_expectation, categories
  aliases      TEXT NOT NULL DEFAULT '{}',   -- JSON: profile_key -> alternate field names (autofill mapping, §19.3)
  version      INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_skills (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  level       TEXT,
  years       REAL,
  is_top5     INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS profile_experiences (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  company     TEXT NOT NULL,
  title       TEXT NOT NULL,
  start_date  TEXT,
  end_date    TEXT,
  location    TEXT,
  bullets     TEXT NOT NULL DEFAULT '[]',    -- JSON array
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS profile_education (
  id          TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  school      TEXT NOT NULL,
  degree      TEXT,
  field       TEXT,
  start_date  TEXT,
  end_date    TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cvs (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id      TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  archetype       TEXT NOT NULL DEFAULT 'opening',      -- opening | pitch
  career_category TEXT NOT NULL DEFAULT 'software_engineering',
  targeting       TEXT NOT NULL DEFAULT '{}',           -- JSON {seniority[], keywords[], companies[]}
  blocks          TEXT NOT NULL DEFAULT '[]',           -- JSON block array (§24.1)
  template_id     TEXT,
  lineage         TEXT NOT NULL DEFAULT '{}',           -- JSON {forked_from, forked_at}
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,             -- cv | email
  archetype  TEXT NOT NULL,             -- opening | pitch
  name       TEXT NOT NULL,
  subject    TEXT,
  body       TEXT NOT NULL DEFAULT '',
  variables  TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companies (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  domain       TEXT,
  tier         TEXT NOT NULL DEFAULT 'reach',   -- dream | reach | safety
  careers_url  TEXT,
  stack        TEXT NOT NULL DEFAULT '[]',
  notes        TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contacts (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id    TEXT REFERENCES companies(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  role          TEXT,
  email         TEXT,
  source_note   TEXT,
  never_contact INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_postings (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  company_id       TEXT REFERENCES companies(id) ON DELETE SET NULL,
  company_name     TEXT NOT NULL,
  source           TEXT NOT NULL,          -- arbeitnow|remotive|remoteok|hn|greenhouse|lever|manual|demo
  external_id      TEXT NOT NULL,
  title            TEXT NOT NULL,
  location         TEXT,
  remote           INTEGER NOT NULL DEFAULT 0,
  salary_min       INTEGER,
  salary_max       INTEGER,
  currency         TEXT,
  seniority        TEXT,
  employment_type  TEXT,
  career_category  TEXT NOT NULL DEFAULT 'software_engineering',
  description      TEXT,
  jd_keywords      TEXT NOT NULL DEFAULT '[]',
  url              TEXT NOT NULL,
  posted_at        TEXT,
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT,
  score            REAL,
  explain          TEXT,                    -- JSON array of {factor, weight, points, why}
  dedupe_key       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open',
  created_at       TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_postings_src_ext ON job_postings(source, external_id);
CREATE INDEX IF NOT EXISTS ix_postings_cat_seen ON job_postings(career_category, posted_at DESC);
CREATE INDEX IF NOT EXISTS ix_postings_dedupe ON job_postings(dedupe_key);
CREATE INDEX IF NOT EXISTS ix_postings_user ON job_postings(user_id);

CREATE TABLE IF NOT EXISTS job_votes (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  posting_id TEXT NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  vote       TEXT NOT NULL,                 -- up | down | ignore | applied
  created_at TEXT NOT NULL,
  UNIQUE (user_id, posting_id)
);

CREATE TABLE IF NOT EXISTS saved_searches (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  params     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applications (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id       TEXT REFERENCES companies(id) ON DELETE SET NULL,
  posting_id       TEXT REFERENCES job_postings(id) ON DELETE SET NULL,
  contact_id       TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  kind             TEXT NOT NULL DEFAULT 'application',   -- application | pitch
  status           TEXT NOT NULL DEFAULT 'saved',
  cv_id            TEXT,
  template_id      TEXT,
  role_title       TEXT NOT NULL,
  company_name     TEXT NOT NULL DEFAULT '',
  source           TEXT,
  url              TEXT,
  applied_at       TEXT,
  replied_at       TEXT,
  first_reply_days REAL,
  ghosted_at       TEXT,
  next_action_at   TEXT,
  follow_up_stage  INTEGER NOT NULL DEFAULT 0,
  capture          TEXT,                    -- JSON snapshot
  notes            TEXT,
  tags             TEXT NOT NULL DEFAULT '[]',
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_apps_user_status ON applications(user_id, status);
CREATE INDEX IF NOT EXISTS ix_apps_applied ON applications(user_id, applied_at);

CREATE TABLE IF NOT EXISTS application_events (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id   TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  type     TEXT NOT NULL,   -- created applied emailed opened replied classified status_changed ghosted interview offer rejected note
  at       TEXT NOT NULL,
  actor    TEXT NOT NULL DEFAULT 'user',    -- user | system | extension
  payload  TEXT
);
CREATE INDEX IF NOT EXISTS ix_events_app_at ON application_events(app_id, at);
CREATE INDEX IF NOT EXISTS ix_events_type_at ON application_events(type, at);

CREATE TABLE IF NOT EXISTS outreach_messages (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id        TEXT REFERENCES applications(id) ON DELETE CASCADE,
  contact_id    TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  template_id   TEXT,
  step_no       INTEGER NOT NULL DEFAULT 0,
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'draft',  -- draft|scheduled|sent_unverified|sent|paused|replied|bounced
  scheduled_at  TEXT,
  sent_at       TEXT,
  opens         INTEGER NOT NULL DEFAULT 0,
  clicks        INTEGER NOT NULL DEFAULT 0,
  bounced       INTEGER NOT NULL DEFAULT 0,
  tracking_token TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mailboxes (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT 'imap',   -- imap | gmail
  address        TEXT NOT NULL,
  config         TEXT NOT NULL DEFAULT '{}',     -- secrets encrypted at rest in a real deploy
  open_tracking  INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  outreach_id  TEXT REFERENCES outreach_messages(id) ON DELETE SET NULL,
  contact_id   TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  subject      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',     -- open | replied | paused | closed
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_messages (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mailbox_id     TEXT,
  thread_id      TEXT REFERENCES threads(id) ON DELETE CASCADE,
  outreach_id    TEXT,
  message_id     TEXT,
  in_reply_to    TEXT,
  direction      TEXT NOT NULL DEFAULT 'inbound', -- inbound | outbound
  subject        TEXT NOT NULL,
  from_addr      TEXT NOT NULL,
  to_addr        TEXT,
  body           TEXT,
  classification TEXT,                            -- interested | interview_invite | rejected | auto_reply | ooo | bounce | neutral
  received_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS streak_events (
  day          TEXT NOT NULL,             -- local day of owner, YYYY-MM-DD
  user_id      TEXT NOT NULL,
  applications INTEGER NOT NULL DEFAULT 0,
  goal         INTEGER NOT NULL,
  hit          INTEGER NOT NULL DEFAULT 0,
  streak_value INTEGER NOT NULL DEFAULT 0,
  any_streak   INTEGER NOT NULL DEFAULT 0,
  frozen       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS daily_rollups (
  day     TEXT NOT NULL,
  user_id TEXT NOT NULL,
  metrics TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, day)
);

CREATE TABLE IF NOT EXISTS badges (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_key   TEXT NOT NULL,
  unlocked_at TEXT NOT NULL,
  UNIQUE (user_id, badge_key)
);

CREATE TABLE IF NOT EXISTS sources (
  name          TEXT PRIMARY KEY,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_run_at   TEXT,
  items_found   INTEGER NOT NULL DEFAULT 0,
  error_streak  INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT
);

CREATE TABLE IF NOT EXISTS field_history (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  host            TEXT NOT NULL,
  field_signature TEXT NOT NULL,
  profile_key     TEXT NOT NULL,
  confirmed_at    TEXT NOT NULL,
  UNIQUE (user_id, host, field_signature)
);

CREATE TABLE IF NOT EXISTS job_runs (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued',
  detail     TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);

-- pitch targets: Nigerian companies (no open role required) found via OpenStreetMap,
-- globally cached (no user_id) and refreshed every 24h per city/sector.
CREATE TABLE IF NOT EXISTS pitch_targets (
  external_id   TEXT PRIMARY KEY,   -- OSM type/id
  name          TEXT NOT NULL,
  sector        TEXT NOT NULL,      -- supermarket | airport | manufacturing | company
  city          TEXT,
  website       TEXT,
  email         TEXT,
  email_derived INTEGER NOT NULL DEFAULT 0,  -- 1 = info@domain guess, 0 = published
  phone         TEXT,
  lat           REAL,
  lon           REAL,
  fetched_at    TEXT NOT NULL
);
`;

/**
 * Postgres dialect, derived from the SQLite schema above, the only difference is
 * the AUTOINCREMENT column (Postgres identity column). Everything else in this
 * DDL (TEXT/INTEGER/REAL, inline REFERENCES, composite PKs, UNIQUE, IF NOT EXISTS
 * indexes) is valid in both engines.
 */
export const SCHEMA_PG = SCHEMA.replace(
  "INTEGER PRIMARY KEY AUTOINCREMENT",
  "INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY"
);
