/**
 * Vercel serverless entry — the same Express app, without `app.listen`.
 *
 * `vercel.json` rewrites every path here and Vercel hands the handler the original
 * request path, so Express routing (`/`, `/api/v1/...`) works unchanged.
 *
 * The app is loaded lazily inside try/catch: if anything in the import graph throws
 * at boot, the error is written into the response body instead of collapsing into an
 * opaque FUNCTION_INVOCATION_FAILED.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let handler: Handler | null = null;
let bootError = "";

async function getHandler(): Promise<Handler | null> {
  if (handler) return handler;
  if (bootError) return null;
  try {
    const { createApp } = await import("../src/app");
    const app = createApp();
    handler = (req, res) => (app as unknown as Handler)(req, res);
    return handler;
  } catch (e: any) {
    bootError = `${e?.name ?? "Error"}: ${e?.message ?? e}${e?.stack ? `\n${e.stack}` : ""}`;
    console.error("[api] boot failed:", e);
    return null;
  }
}

export default async function serve(req: IncomingMessage, res: ServerResponse) {
  const h = await getHandler();
  if (!h) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(`API boot failed:\n${bootError || "unknown error"}`);
    return;
  }
  h(req, res);
}
