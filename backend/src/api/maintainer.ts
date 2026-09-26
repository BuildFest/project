import type { Hono } from "hono";
import { z } from "zod";
import type { ModelRouter } from "../ai/router.js";
import type { Db } from "../db.js";
import { askPitCrew, generateDigest } from "../maintainer/service.js";
import { notFound, parseBody } from "./http.js";

const AskInput = z.object({ question: z.string().trim().min(2).max(1000) });

export function registerMaintainerRoutes(app: Hono, db: Db, router: ModelRouter | null) {
  app.get("/projects/:projectId/maintainer/notes", async (c) => {
    const projectId = c.req.param("projectId");
    const exists = await db.query("select 1 from projects where project_id=$1", [projectId]);
    if (!exists.rowCount) return notFound("project");
    const { rows } = await db.query("select * from maintainer_notes where project_id=$1 order by created_at desc limit 100", [projectId]);
    return c.json(rows);
  });
  app.post("/projects/:projectId/maintainer/digest", async (c) => {
    const note = await generateDigest(db, router, c.req.param("projectId"));
    return c.json(note ?? notFound("project"), 201);
  });
  app.post("/projects/:projectId/ask", async (c) => {
    const input = await parseBody(c, AskInput);
    const note = await askPitCrew(db, router, c.req.param("projectId"), input.question);
    return c.json(note ?? notFound("project"), 201);
  });
}
