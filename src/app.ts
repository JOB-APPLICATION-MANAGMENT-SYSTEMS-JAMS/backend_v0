import express from "express";
import cors from "cors";
import { apiRouter, apiIndex } from "./routes/index";
import { errorHandler } from "./core/errors";
import { requestContext, startRateLimitSweeper } from "./core/middleware";
import { config } from "./core/config";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  if (process.env.VERCEL && config.jwtSecret === "dev-secret-change-me") {
    // anyone who reads this repo can forge tokens, say it where the deploy logs show it
    console.warn("[jams] JWT_SECRET is not set, falling back to the well-known dev secret. Set JWT_SECRET on the deployment.");
  }
  app.use(
    cors({
      origin: config.webOrigin === "*" ? true : config.webOrigin.split(",").map((s) => s.trim()),
      credentials: true,
    })
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(requestContext);
  startRateLimitSweeper();

  app.use("/api/v1", apiRouter);
  // convenience: docs-style index listing (replaces FastAPI /docs for humans)
  app.get("/", (_req, res) => res.json(apiIndex()));
  app.use((_req, res) => res.status(404).json({ status: "failure", status_code: 404, message: "Route not found", error: { code: "NOT_FOUND" } }));
  app.use(errorHandler);
  return app;
}
