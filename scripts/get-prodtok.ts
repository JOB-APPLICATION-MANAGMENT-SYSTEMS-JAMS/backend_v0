/** Log into prod and write the access token to backend/prodtok (short TTL: re-run often). */
import fs from "node:fs";
import path from "node:path";

const BASE = "https://backend-v0-3aeu-omega.vercel.app/api/v1";

const res = await fetch(`${BASE}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "catalog.seed@jams.local", password: "Passw0rd!123" }),
});
const json = await res.json();
const token = json?.data?.access_token;
if (!token) {
  console.error("login failed:", JSON.stringify(json).slice(0, 300));
  process.exit(1);
}
fs.writeFileSync(path.join(process.cwd(), "prodtok"), token);
console.log(`prodtok saved (${token.length} chars)`);
