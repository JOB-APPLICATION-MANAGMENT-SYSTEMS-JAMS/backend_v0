import { randomUUID } from "node:crypto";

/**
 * UUIDv7-ish id: 48-bit millisecond timestamp + version/variant bits + random.
 * Monotonic enough for a single-process app and sortable by creation time —
 * matching the spec's "id (UUIDv7)" rule while staying dependency-free.
 */
export function newId(): string {
  const now = Date.now();
  const tsHex = now.toString(16).padStart(12, "0");
  const rnd = randomUUID().replace(/-/g, "");
  const v = rnd.slice(0, 16).split("");
  v[0] = "7";
  v[4] = ((parseInt(rnd[4], 16) & 0x3) | 0x8).toString(16);
  return `${tsHex}${rnd.slice(12, 16)}${v.slice(4, 8).join("")}${rnd.slice(20, 32)}`;
}

export const nowIso = () => new Date().toISOString();
