/**
 * Build the Vercel serverless entry into one self-contained file at api/index.js.
 *
 * Why a script instead of a CLI line: the banner contains `;`, which cmd.exe eats,
 * and Vercel must produce byte-identical output from the same command on Linux.
 *
 * Why fully bundled (no --packages=external): the deployed function runs without
 * this repo's node_modules unless nft happens to trace it — a load-time
 * `import express` then crashes before any handler code can report anything.
 *
 * Why the banner: esbuild's `__require` helper delegates to a real `require`
 * when one is in scope; without it, bundled CJS deps die on builtin requires
 * like `require("tty")` (debug) with "Dynamic require … is not supported".
 */
import { build } from "esbuild";

await build({
  entryPoints: ["src/serverless.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "api/index.js",
  sourcemap: true,
  banner: { js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);" },
  logLevel: "info",
});
