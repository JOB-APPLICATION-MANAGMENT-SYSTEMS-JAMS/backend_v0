/**
 * Vercel serverless entry — the same Express app, without `app.listen`.
 *
 * `vercel.json` rewrites every path here and Vercel hands the handler the original
 * request path, so Express routing (`/`, `/api/v1/...`) works unchanged.
 *
 * The app is loaded lazily: the transpiled entry keeps relative imports unresolved at
 * runtime, so we try each plausible resolution and, if all fail, report every error
 * plus a shallow file listing instead of an opaque FUNCTION_INVOCATION_FAILED.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let handler: Handler | null = null;
let bootReport = "";

const CANDIDATES = ["../src/app.ts", "../src/app.js", "../src/app.mjs", "../src/app"];

async function tree(dir: string, depth = 0): Promise<string> {
  if (depth > 3) return "";
  const fs = await import("node:fs");
  const path = await import("node:path");
  const lines: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    lines.push(`${"  ".repeat(depth)}${e.name}${e.isDirectory() ? "/" : ""}`);
    if (e.isDirectory()) lines.push(await tree(path.join(dir, e.name), depth + 1));
  }
  return lines.filter(Boolean).join("\n");
}

async function load(): Promise<Handler | null> {
  const failures: string[] = [];
  for (const spec of CANDIDATES) {
    try {
      const mod = await import(spec);
      const app = mod.createApp();
      console.log(`[api] booted via ${spec}`);
      return (req, res) => (app as unknown as Handler)(req, res);
    } catch (e: any) {
      failures.push(`${spec} → ${e?.name ?? "Error"}: ${e?.message ?? e}`);
    }
  }
  let listing = "";
  try {
    listing = await tree("/var/task");
  } catch (e: any) {
    listing = `tree failed: ${e?.message ?? e}`;
  }
  bootReport = [
    `node ${process.version} · VERCEL=${process.env.VERCEL ?? "-"} · NODE_ENV=${process.env.NODE_ENV ?? "-"}`,
    "import attempts:",
    ...failures.map((f) => `  ${f}`),
    "/var/task:",
    listing,
  ].join("\n");
  console.error(`[api] boot failed:\n${bootReport}`);
  return null;
}

export default async function serve(req: IncomingMessage, res: ServerResponse) {
  if (!handler && !bootReport) handler = await load();
  if (!handler) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(`API boot failed:\n${bootReport}`);
    return;
  }
  handler(req, res);
}
