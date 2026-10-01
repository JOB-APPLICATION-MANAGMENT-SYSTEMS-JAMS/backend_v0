/** Post-deploy checks: rewrite returns merged text, country filter works. */
import fs from "node:fs";
import path from "node:path";

const BASE = "https://backend-v0-3aeu-omega.vercel.app/api/v1";
const tok = fs.readFileSync(path.join(process.cwd(), "prodtok"), "utf8").trim();
const H = { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" };

async function post(p: string, body: any) {
  const r = await fetch(`${BASE}${p}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  return r.json();
}
async function get(p: string) {
  const r = await fetch(`${BASE}${p}`, { headers: H });
  return r.json();
}

// 1. rewrite must return merged text (no raw {{profile.*}} tokens)
const rw: any = await post("/pitch-targets/rewrite", { external_id: "node/8111929251", seed: "verify123", kind: "pitch" });
if (rw.status === "failure") {
  console.log("rewrite FAILED:", JSON.stringify(rw).slice(0, 300));
} else {
  const body: string = rw.data?.body ?? "";
  const tokens = body.match(/\{\{[^}]*\}\}/g);
  console.log("rewrite tail:", JSON.stringify(body.slice(-120)));
  console.log(tokens ? `FAIL: tokens present: ${tokens.join(", ")}` : "PASS: no raw tokens in rewrite");
}

// 2. meta should list countries
const meta: any = await get("/pitch-targets/meta");
const countries = meta.data?.countries ?? [];
console.log(`meta countries: ${countries.length}`, countries.slice(0, 4).map((c: any) => `${c.key}:${c.count}`).join(" "));

// 3. country filter: Nigeria vs all vs another country on a list sector
const ng: any = await get("/pitch-targets?sector=services&country=Nigeria&page_size=1");
const all: any = await get("/pitch-targets?sector=services&country=all&page_size=1");
const gh: any = await get("/pitch-targets?sector=services&country=Ghana&page_size=1");
console.log("services total Nigeria:", ng.data?.pagination?.total_count, "| all:", all.data?.pagination?.total_count, "| Ghana:", gh.data?.pagination?.total_count);
