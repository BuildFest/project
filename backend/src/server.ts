// Server entry point: `npm run dev` locally, `node dist/server.js` on Railway.
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { serve } from "@hono/node-server";
import { loadAiConfig } from "./ai/config.js";
import { createModelRouter } from "./ai/router.js";
import { createAiRunLogger } from "./ai/audit.js";
import { createAnalysisScheduler, startAnalysisSweep } from "./analysis/runner.js";
import type { AnalysisTrigger } from "./analysis/runner.js";
import { createApp } from "./api/app.js";
import { requireEnv } from "./config.js";
import { createPool } from "./db.js";
import { createCompareScheduler } from "./ingestion/compare.js";
import { projectEventsToTimeline } from "./ingestion/timeline.js";
import { startMaintainerDigests } from "./maintainer/service.js";

// Railway supplies environment variables directly; local development uses
// backend/.env when present. The file is gitignored.
if (existsSync(".env")) loadEnvFile(".env");

// Fail at boot, not on the first webhook: a server without the secret would
// reject every delivery. Behind Railway's proxy the request origin is
// http://..., so production must say its public https URL explicitly.
requireEnv("GITHUB_WEBHOOK_SECRET");
if (process.env.NODE_ENV === "production") requireEnv("PUBLIC_BASE_URL");

const port = Number(process.env.PORT ?? 8787);
const db = createPool();
const router = createModelRouter(loadAiConfig(), { onRun: createAiRunLogger(db) });
const scheduleAnalysis = createAnalysisScheduler(db, router);
startAnalysisSweep(db, scheduleAnalysis);
startMaintainerDigests(db, router);
const analyzeProjects = (projectIds: string[], trigger: AnalysisTrigger = "github_event") =>
  projectIds.forEach((projectId) => scheduleAnalysis(projectId, { trigger }));

// After each push to a feature branch, recompute its changed files (debounced).
const refreshBranches = createCompareScheduler(db, 3_000, fetch, (projectId) =>
  scheduleAnalysis(projectId, { trigger: "branch_files" }),
);

// Idempotent catch-up: events stored before the timeline projection existed
// (or while it was broken) get their timeline rows.
void projectEventsToTimeline(db)
  .then((n) => n > 0 && console.log(`timeline: projected ${n} earlier events`))
  .catch((error) => console.error("timeline catch-up failed", error));

serve({ fetch: createApp(db, analyzeProjects, refreshBranches, router).fetch, port }, (info) => {
  console.log(`Pit Crew API listening on port ${info.port}`);
});
