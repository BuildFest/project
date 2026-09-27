import type { Hono } from "hono";
import type { Db } from "../db.js";
import { notFound } from "./http.js";
import { ListAiRunsQuery } from "./inputs.js";

const LIMIT = { default: 50, max: 200 };

// Every AI call the router makes is logged to ai_runs (audit.ts), success or
// failure, so this needs no separate tracking of its own — it's a read over
// existing data. Built for the "Fails" view (contract §5.9): the team's own
// record of every time an AI job broke, for the Agentic Stress Test track.
export function registerAiRunRoutes(app: Hono, db: Db) {
  app.get("/projects/:projectId/ai-runs", async (c) => {
    const q = ListAiRunsQuery.parse(c.req.query());
    const projectId = c.req.param("projectId");
    const { rowCount } = await db.query("select 1 from projects where project_id = $1", [projectId]);
    if (!rowCount) notFound("project");

    const limit = Math.min(q.limit ?? LIMIT.default, LIMIT.max);
    const params: unknown[] = [projectId];
    const where = ["project_id = $1"];
    if (q.status) {
      params.push(q.status);
      where.push(`status = $${params.length}`);
    }
    if (q.cursor) {
      params.push(q.cursor);
      where.push(
        `(created_at, run_id) < (select created_at, run_id from ai_runs
                                  where project_id = $1 and run_id = $${params.length})`,
      );
    }
    params.push(limit + 1);
    const { rows } = await db.query(
      `select run_id, project_id, job, tier, provider, model, input_tokens, output_tokens,
              duration_ms, cached, status, error, source_event_id, created_at
         from ai_runs
        where ${where.join(" and ")}
        order by created_at desc, run_id desc
        limit $${params.length}`,
      params,
    );
    const items = rows.slice(0, limit);
    return c.json({ items, next_cursor: rows.length > limit ? items[items.length - 1].run_id : null });
  });
}
