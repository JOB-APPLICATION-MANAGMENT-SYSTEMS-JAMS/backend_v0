/**
 * Build the Vercel serverless entry into one self-contained file at api/index.js.
 *
 * A script rather than a CLI line because the banner contains `;`, which cmd.exe
 * eats — and Vercel must produce byte-identical output from the same command.
 * The options live in ./esbuild-options so tests/bundle.test.ts guards exactly
 * what ships.
 */
import { build } from "esbuild";
import { bundleOptions } from "./esbuild-options";

await build(bundleOptions);
