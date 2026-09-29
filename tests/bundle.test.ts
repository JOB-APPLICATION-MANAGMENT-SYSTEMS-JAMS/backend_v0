/**
 * Regression guard for the failure that took the deployed backend down:
 * Vercel compiles the function entry in isolation, so the shipped bundle must
 * boot with plain `node` and NO node_modules and NO repo source next to it —
 * a single bare import (express…) or extensionless relative import kills the
 * function before any handler can report anything (bare FUNCTION_INVOCATION_FAILED).
 *
 * Also fails if api/index.js was not rebuilt after a source change, so the
 * committed artifact can never drift from src/.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bundleOptions } from "../scripts/esbuild-options";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const committed = path.join(root, "api", "index.js");
const fixture = path.join(root, "tests", "fixtures", "boot.mjs");

let dir = "";
let freshBundle = "";

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "jams-bundle-"));
  const outfile = path.join(dir, "api", "index.js");
  fs.mkdirSync(path.join(dir, "api"), { recursive: true });
  await build({
    ...bundleOptions,
    absWorkingDir: root,
    outfile,
    logLevel: "silent",
  });
  freshBundle = outfile;
  // Vercel's /var/task always has the project package.json; the module type matters
  fs.copyFileSync(path.join(root, "package.json"), path.join(dir, "package.json"));
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

function boot(bundleDir: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fixture, bundleDir], { cwd: bundleDir });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

test("bundle boots and serves healthz with no node_modules (Vercel layout)", async () => {
  const { code, out } = await boot(dir);
  assert.equal(code, 0, out);
  assert.match(out, /HEALTHZ 200/);
});

test("committed api/index.js matches a fresh build of src/", async () => {
  assert.ok(fs.existsSync(committed), "api/index.js is missing — run `pnpm run build` and commit it");
  assert.ok(
    fs.readFileSync(freshBundle).equals(fs.readFileSync(committed)),
    "api/index.js is stale — run `pnpm run build` and commit the result"
  );
});
