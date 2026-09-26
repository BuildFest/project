import type { Hono } from "hono";
import type { Db } from "../db.js";
import { notFound } from "./http.js";
import { ListBranchesQuery } from "./inputs.js";

export function registerBranchRoutes(app: Hono, db: Db) {
  // Small per project (tens of branches), so returned whole, not paginated.
  app.get("/projects/:projectId/branches", async (c) => {
    const q = ListBranchesQuery.parse(c.req.query());
    const projectId = c.req.param("projectId");

    const { rowCount } = await db.query("select 1 from projects where project_id = $1", [projectId]);
    if (!rowCount) notFound("project");

    const { rows } = await db.query(
      `select * from branch_states
        where project_id = $1 and ($2::text is null or status = $2)
        order by case status when 'active' then 0 when 'merged' then 1 else 2 end,
                 last_activity_at desc nulls last, branch`,
      [projectId, q.status ?? null],
    );
    return c.json(rows);
  });
}
