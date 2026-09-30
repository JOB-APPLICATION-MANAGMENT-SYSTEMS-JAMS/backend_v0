import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { config } from "./config";
import { SCHEMA, SCHEMA_PG } from "../db/schema";

export type Row = Record<string, any>;

/**
 * Dual-driver data layer.
 *
 * - `sqlite` (default): local dev & tests, node:sqlite file, zero setup, same as before.
 * - `postgres`: set `DATABASE_URL` (Neon/Supabase), used on serverless hosts like
 *   Vercel where the filesystem is ephemeral and a file DB would vanish.
 *
 * Every helper is async so one codebase serves both: on the sqlite path the promise
 * resolves immediately. Queries use `?` placeholders and are rewritten to `$1..$n`
 * for Postgres inside the driver.
 */
const pgUrl = process.env.DATABASE_URL?.trim();
export const driver: "postgres" | "sqlite" = pgUrl ? "postgres" : "sqlite";

let pgPoolPromise: Promise<pg.Pool> | null = null;
let sqlitePromise: Promise<DatabaseSync> | null = null;

function getPool(): Promise<pg.Pool> {
  if (!pgPoolPromise) {
    pgPoolPromise = (async () => {
      const pool = new pg.Pool({
        connectionString: pgUrl,
        max: 3,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 15_000,
        // Neon terminates idle connections and requires TLS; sslmode=require in the URL
        ...(pgUrl?.includes("sslmode=require") ? { ssl: { rejectUnauthorized: false } } : {}),
      });
      await pool.query(SCHEMA_PG); // idempotent CREATE IF NOT EXISTS, one round-trip per cold start
      return pool;
    })();
    pgPoolPromise.catch(() => {
      pgPoolPromise = null;
    });
  }
  return pgPoolPromise;
}

async function getSqlite(): Promise<DatabaseSync> {
  if (!sqlitePromise) {
    sqlitePromise = (async () => {
      // lazy: serverless hosts never touch node:sqlite when DATABASE_URL is set
      const { DatabaseSync } = await import("node:sqlite");
      const dir = path.dirname(config.dbPath);
      fs.mkdirSync(dir, { recursive: true });
      const db = new DatabaseSync(config.dbPath);
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec(SCHEMA);
      return db;
    })();
    sqlitePromise.catch(() => {
      sqlitePromise = null;
    });
  }
  return sqlitePromise;
}

/** `?` placeholders → `$1..$n`, skipping question marks inside string literals. */
function toPg(sql: string): string {
  let out = "";
  let n = 0;
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") inStr = !inStr;
    if (ch === "?" && !inStr) {
      out += `$${++n}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Uniform param shapes for both drivers (schema booleans are INTEGER columns). */
function norm(params: any[]): any[] {
  return params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));
}

/**
 * node-postgres returns `int8` (count/sum) and `numeric` (avg) as *strings*, sqlite
 * returns numbers. Coerce those two OIDs back to JS numbers so query code is
 * driver-agnostic (`value.toFixed(...)` etc. would otherwise throw on Postgres).
 * Text/uuid/json columns are left untouched.
 */
const OID_INT8 = 20;
const OID_NUMERIC = 1700;
export function castRows<T>(result: pg.QueryResult): T[] {
  const fields = result.fields ?? [];
  for (const row of result.rows as Row[]) {
    for (const f of fields) {
      if ((f.dataTypeID === OID_INT8 || f.dataTypeID === OID_NUMERIC) && typeof row[f.name] === "string") {
        const n = Number(row[f.name]);
        if (!Number.isNaN(n)) row[f.name] = n;
      }
    }
  }
  return result.rows as T[];
}

/** Positional-parameter SELECT returning every row. */
export async function all<T = Row>(sql: string, ...params: any[]): Promise<T[]> {
  if (driver === "postgres") {
    const pool = await getPool();
    return castRows<T>(await pool.query(toPg(sql), norm(params)));
  }
  return (await getSqlite()).prepare(sql).all(...norm(params)) as T[];
}

/** Positional-parameter SELECT returning the first row or undefined. */
export async function get<T = Row>(sql: string, ...params: any[]): Promise<T | undefined> {
  if (driver === "postgres") {
    const pool = await getPool();
    const rows = castRows<T>(await pool.query(toPg(sql), norm(params)));
    return rows[0];
  }
  return (await getSqlite()).prepare(sql).get(...norm(params)) as T | undefined;
}

/** INSERT/UPDATE/DELETE, returns changes count. */
export async function run(sql: string, ...params: any[]): Promise<number> {
  if (driver === "postgres") {
    const pool = await getPool();
    return (await pool.query(toPg(sql), norm(params))).rowCount ?? 0;
  }
  const res = (await getSqlite()).prepare(sql).run(...norm(params));
  return Number(res.changes);
}

/** Execute many statements (DDL/seeds). */
export async function exec(sql: string): Promise<void> {
  if (driver === "postgres") {
    await (await getPool()).query(sql);
    return;
  }
  (await getSqlite()).exec(sql);
}

/** Run fn inside a transaction (sqlite: same connection; postgres: dedicated client). */
export async function tx<T>(fn: () => T | Promise<T>): Promise<T> {
  if (driver === "postgres") {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn();
      await client.query("COMMIT");
      return out;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw e;
    } finally {
      client.release();
    }
  }
  const db = await getSqlite();
  db.exec("BEGIN");
  try {
    const out = await fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    throw e;
  }
}

export const parseJson = <T>(v: any, fallback: T): T => {
  if (v == null) return fallback;
  if (typeof v === "object") return v as T;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
};
