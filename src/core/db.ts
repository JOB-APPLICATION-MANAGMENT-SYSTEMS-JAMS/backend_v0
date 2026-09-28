import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { SCHEMA } from "../db/schema";

export type Row = Record<string, any>;

/** Single source of truth: SQLite file — same SQL shapes as the Postgres blueprint (§32). */
const dir = path.dirname(config.dbPath);
fs.mkdirSync(dir, { recursive: true });

export const db = new DatabaseSync(config.dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec(SCHEMA);

/** Positional-parameter SELECT returning every row. */
export function all<T = Row>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

/** Positional-parameter SELECT returning the first row or undefined. */
export function get<T = Row>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

/** INSERT/UPDATE/DELETE — returns changes count. */
export function run(sql: string, ...params: any[]): number {
  const res = db.prepare(sql).run(...params);
  return Number(res.changes);
}

/** Execute many statements (DDL/seeds). */
export function exec(sql: string): void {
  db.exec(sql);
}

/** Run fn inside a transaction (nested calls join the outer transaction). */
export function tx<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const out = fn();
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
