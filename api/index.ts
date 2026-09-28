/**
 * Vercel serverless entry — the same Express app, without `app.listen`.
 * `vercel.json` rewrites every path here and Vercel hands the handler the original
 * request path, so Express routing (`/`, `/api/v1/...`) works unchanged.
 */
import { createApp } from "../src/app";

export default createApp();
