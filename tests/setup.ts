// Must be the FIRST import in every test file: isolates the DB per test process.
import os from "node:os";
import path from "node:path";

process.env.DB_PATH = process.env.DB_PATH ?? path.join(os.tmpdir(), `jams-test-${process.pid}.db`);
process.env.SEED_DEMO = "false";
process.env.MODE = "test";
