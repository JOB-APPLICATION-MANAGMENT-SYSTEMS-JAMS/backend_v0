/**
 * Boot a serverless bundle the way Vercel does: plain `node`, no tsx, no
 * node_modules next to it. argv[2] is a directory containing api/index.js and
 * a package.json. Prints `HEALTHZ <status>` and exits 0 only on 200.
 */
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

let out = "";
const log = (s) => (out += s + "\n");

try {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: node boot.mjs <bundle-dir>");
  const mod = await import(pathToFileURL(path.join(dir, "api", "index.js")).href);
  if (typeof mod.default !== "function") throw new Error("default export is not a handler function");

  const server = http.createServer((req, res) => mod.default(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/api/v1/healthz`);
  const body = await res.text();
  log(`HEALTHZ ${res.status}`);
  if (res.status !== 200) log(body.slice(0, 3000));
  server.close();
  // exit through a flushed stdout write so the parent test never reads a truncated log
  process.stdout.write(out, () => process.exit(res.status === 200 ? 0 : 1));
} catch (e) {
  log(`BOOT FAILED: ${e?.stack ?? e}`);
  process.stdout.write(out, () => process.exit(1));
}
