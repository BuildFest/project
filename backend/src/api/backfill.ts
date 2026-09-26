import type { Hono } from "hono";
import type { Db } from "../db.js";
import { runBackfill } from "../ingestion/backfill.js";
import { notFound } from "./http.js";

// One run per repository at a time; a second request while one is running
// gets the running one's start time instead of starting another.
const running = new Map<string, string>();

export function registerBackfillRoutes(app: Hono, db: Db) {
  app.post("/projects/:projectId/repositories/:repositoryId/backfill", async (c) => {
    const { projectId, repositoryId } = c.req.param();
    const { rowCount } = await db.query("select 1 from repositories where project_id = $1 and repository_id = $2", [
      projectId,
      repositoryId,
    ]);
    if (!rowCount) notFound("repository");

    const inFlight = running.get(repositoryId);
    if (inFlight) return c.json({ started_at: inFlight }, 202);

    const startedAt = new Date().toISOString();
    running.set(repositoryId, startedAt);
    // Tens of GitHub calls; runs after the response. Progress: repository.last_backfill_at.
    void runBackfill(db, repositoryId)
      .then((stats) => console.log("backfill finished", { repositoryId, ...stats }))
      .catch((error) => console.error("backfill failed", { repositoryId, error }))
      .finally(() => running.delete(repositoryId));
    return c.json({ started_at: startedAt }, 202);
  });
}
