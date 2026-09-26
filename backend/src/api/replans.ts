import type { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../db.js";
import { notFound } from "./http.js";

const ReplanStatus = z.enum(["proposed", "accepted", "rejected", "superseded"]);

export function registerReplanRoutes(app: Hono, db: Db) {
  app.get("/projects/:projectId/replans", async (c) => {
    const projectId = c.req.param("projectId");
    const status = c.req.query("status");
    const filter = status === undefined ? null : ReplanStatus.parse(status);

    const project = await db.query("select 1 from projects where project_id = $1", [projectId]);
    if (project.rowCount === 0) notFound("project");

    const { rows } = await db.query(
      `select * from replan_suggestions
        where project_id = $1 and ($2::text is null or status = $2)
        order by created_at desc, suggestion_id desc`,
      [projectId, filter],
    );
    return c.json(rows);
  });
}
