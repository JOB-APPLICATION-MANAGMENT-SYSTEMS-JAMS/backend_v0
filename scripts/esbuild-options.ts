/**
 * The exact options that produce the deployed serverless bundle.
 * Shared by scripts/build-api.ts and tests/bundle.test.ts so the guard
 * always tests the artifact that actually ships.
 */
import type { BuildOptions } from "esbuild";

export const bundleOptions: BuildOptions = {
  entryPoints: ["src/serverless.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "api/index.js",
  sourcemap: true,
  // esbuild's `__require` helper delegates to a real `require` when one is in
  // scope; without this, bundled CJS deps die on builtin requires like
  // `require("tty")` (debug) with "Dynamic require … is not supported".
  banner: { js: "import{createRequire}from'node:module';const require=createRequire(import.meta.url);" },
  logLevel: "info",
};
