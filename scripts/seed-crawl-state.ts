/** Seed export/state.json from local pitch_targets so a resumed crawl skips pages already fetched. */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(path.join(process.cwd(), "data", "jams.db"));
const rows = db
  .prepare(`SELECT external_id FROM pitch_targets WHERE external_id LIKE 'list:%'`)
  .all() as { external_id: string }[];
const pages = new Set<string>();
for (const { external_id } of rows) {
  // list:<sector>:<pageSlug>:<companySlug>
  const parts = external_id.split(":");
  if (parts.length >= 4) pages.add(parts[2]);
}
fs.mkdirSync(path.join(process.cwd(), "export"), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), "export", "state.json"), JSON.stringify({ done: [...pages] }));
console.log(`seeded state with ${pages.size} page slugs from ${rows.length} list rows`);
