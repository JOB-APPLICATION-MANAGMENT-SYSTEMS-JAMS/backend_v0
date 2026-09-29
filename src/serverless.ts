/**
 * Vercel serverless entry — `pnpm run build` bundles this file (and the whole
 * app) into `api/index.js` with esbuild, because Vercel compiles the entry in
 * isolation while Node's ESM loader cannot resolve the extensionless relative
 * imports this codebase uses.
 *
 * `vercel.json` rewrites every path to this function and hands the handler the
 * original request path, so Express routing (`/`, `/api/v1/...`) works unchanged.
 *
 * The app is loaded lazily so a boot crash surfaces its real error (500 body +
 * console) instead of an opaque FUNCTION_INVOCATION_FAILED.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let handler: Handler | null = null;
let bootReport = "";

async function load(): Promise<Handler | null> {
  try {
    const { createApp } = await import("./app");
    const app = createApp();
    console.log("[api] booted");
    return (req, res) => (app as unknown as Handler)(req, res);
  } catch (e: any) {
    bootReport = [
      `node ${process.version} · VERCEL=${process.env.VERCEL ?? "-"} · NODE_ENV=${process.env.NODE_ENV ?? "-"}`,
      `${e?.name ?? "Error"}: ${e?.message ?? e}`,
      e?.stack ?? "",
    ].join("\n");
    console.error(`[api] boot failed:\n${bootReport}`);
    return null;
  }
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
