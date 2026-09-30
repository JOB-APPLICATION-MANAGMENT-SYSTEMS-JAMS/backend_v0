import path from "node:path";

/** Runtime configuration, every value is env-overridable, defaults suit local mode (§31.1). */
const root = path.resolve(process.cwd());

export const config = {
  mode: (process.env.MODE ?? "local") as "local" | "online",
  port: process.env.PORT && process.env.PORT !== "0" ? Number(process.env.PORT) : 8000, // treat PORT=0 (sandbox default) as "use 8000"
  // serverless hosts (Vercel) have a read-only project dir, /tmp is the only writable place.
  // Set DATABASE_URL (Neon/Supabase) on Vercel instead for real persistence.
  dbPath: process.env.DB_PATH ?? (process.env.VERCEL ? "/tmp/jams.db" : path.join(root, "data", "jams.db")),
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  jwtAccessTtlSec: Number(process.env.JWT_ACCESS_TTL ?? 15 * 60),
  jwtRefreshTtlSec: Number(process.env.JWT_REFRESH_TTL ?? 30 * 24 * 3600),
  webOrigin: process.env.WEB_ORIGIN ?? "*",
  defaultGoal: Number(process.env.DEFAULT_GOAL ?? 20),
  ghostAfterDays: Number(process.env.GHOST_AFTER_DAYS ?? 14),
  dailySendCap: Number(process.env.DAILY_SEND_CAP ?? 30),
  timezone: process.env.TIMEZONE ?? "Africa/Lagos",
  /** follow-ups count toward the daily goal at this weight (open decision #3, settled) */
  followUpWeight: Number(process.env.FOLLOW_UP_WEIGHT ?? 0.25),
  workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS ?? 60_000),
  seedDemo: (process.env.SEED_DEMO ?? "true") !== "false",
};
