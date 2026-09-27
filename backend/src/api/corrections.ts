import type { Hono } from "hono";
import type { Db } from "../db.js";
import { newId } from "../ids.js";
import { notFound, parseBody } from "./http.js";
import { z } from "zod";

const DerivedStatus = z.enum(["not_started", "in_progress", "complete", "possibly_blocked"]);
const PutOverride = z.object({
  override_status: DerivedStatus,
  reason: z.string().trim().min(1).optional(),
  member_id: z.string().min(1),
  version: z.number().int().positive(),
});
const ManualLink = z.object({
  event_id: z.string().min(1),
  task_id: z.string().min(1),
  member_id: z.string().min(1),
});
const ReviewLink = z.object({
  status: z.enum(["confirmed", "rejected"]),
  member_id: z.string().min(1),
});
const Dismiss = z.object({ status: z.literal("dismissed"), member_id: z.string().min(1) });

export function registerCorrectionRoutes(app: Hono, db: Db) {
  app.put("/projects/:projectId/tasks/:taskId/override", async (c) => {
    const input = await parseBody(c, PutOverride);
    const { rows } = await db.query(
      `update derived_task_states
          set override_status = $3, override_by = $4, override_at = now(), override_reason = $5
        where project_id = $1 and task_id = $2 and version = $6 returning *`,
      [c.req.param("projectId"), c.req.param("taskId"), input.override_status, input.member_id, input.reason ?? null, input.version],
    );
    if (rows[0]) return c.json(rows[0]);
    const current = await db.query(
      "select * from derived_task_states where project_id = $1 and task_id = $2",
      [c.req.param("projectId"), c.req.param("taskId")],
    );
    if (!current.rows[0]) notFound("derived task state");
    return c.json({ error: "derived task state changed; confirm the current version", current: current.rows[0] }, 409);
  });

  app.delete("/projects/:projectId/tasks/:taskId/override", async (c) => {
    const { rows } = await db.query(
      `update derived_task_states
          set override_status = null, override_by = null, override_at = null, override_reason = null
        where project_id = $1 and task_id = $2 returning *`,
      [c.req.param("projectId"), c.req.param("taskId")],
    );
    return c.json(rows[0] ?? notFound("derived task state"));
  });

  app.post("/projects/:projectId/links", async (c) => {
    const input = await parseBody(c, ManualLink);
    const { rows } = await db.query(
      `insert into event_task_links
         (link_id, project_id, event_id, task_id, method, confidence, status, is_primary,
          created_by, confirmed_by, confirmed_at)
       values ($1, $2, $3, $4, 'manual', 1, 'confirmed', false, $5, $5, now()) returning *`,
      [newId("link"), c.req.param("projectId"), input.event_id, input.task_id, input.member_id],
    );
    return c.json(rows[0], 201);
  });

  app.patch("/projects/:projectId/links/:linkId", async (c) => {
    const input = await parseBody(c, ReviewLink);
    const { rows } = await db.query(
      `update event_task_links
          set status = $3,
              reviewed_by = $4,
              reviewed_at = now(),
              confirmed_by = case when $3 = 'confirmed' then $4 else null end,
              confirmed_at = case when $3 = 'confirmed' then now() else null end
        where project_id = $1 and link_id = $2 and status = 'suggested' returning *`,
      [c.req.param("projectId"), c.req.param("linkId"), input.status, input.member_id],
    );
    return c.json(rows[0] ?? notFound("suggested link"));
  });

  app.patch("/projects/:projectId/signals/:signalId", async (c) => {
    const input = await parseBody(c, Dismiss);
    const { rows } = await db.query(
      `update health_signals set status = 'dismissed', dismissed_by = $3, dismissed_at = now()
        where project_id = $1 and signal_id = $2 and status = 'active' returning *`,
      [c.req.param("projectId"), c.req.param("signalId"), input.member_id],
    );
    return c.json(rows[0] ?? notFound("active health signal"));
  });

  app.patch("/projects/:projectId/collisions/:collisionId", async (c) => {
    const input = await parseBody(c, Dismiss);
    const { rows } = await db.query(
      `update collisions set status = 'dismissed', dismissed_by = $3, dismissed_at = now()
        where project_id = $1 and collision_id = $2 and status = 'active' returning *`,
      [c.req.param("projectId"), c.req.param("collisionId"), input.member_id],
    );
    return c.json(rows[0] ?? notFound("active collision"));
  });
}
