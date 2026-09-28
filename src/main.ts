import { createApp } from "./app";
import { config } from "./core/config";
import { startScheduler } from "./workers/scheduler";
import { run } from "./core/db";
import { nowIso } from "./util/id";

const app = createApp();

app.listen(config.port, () => {
  console.log(`[jams] API listening on http://localhost:${config.port}/api/v1  (mode=${config.mode})`);
  console.log(`[jams] db: ${config.dbPath}`);
  if (config.mode === "local") startScheduler();
  run(
    `INSERT INTO job_runs (id, kind, status, detail, created_at, finished_at) VALUES (?, 'server_start', 'ok', ?, ?, ?)`,
    `run_${Date.now()}`,
    `port=${config.port}`,
    nowIso(),
    nowIso()
  );
});
