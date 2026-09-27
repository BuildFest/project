import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { withTransaction, type Db } from "../db.js";
import { newId } from "../ids.js";
import { notFound, parseBody } from "./http.js";
import { CreateDecisionInput, ListTimelineQuery } from "./inputs.js";

const LIMIT = { default: 50, max: 200 };

// A GitHub item's tasks come from event_task_links, which the linker fills in
// after ingestion, so they're joined at read time rather than stored on the item.
const LINKED_TASKS = `
  coalesce((select array_agg(l.task_id order by l.task_id) from event_task_links l
             where t.entity_type = 'github_events' and l.project_id = t.project_id
               and l.event_id = t.entity_id and l.status <> 'rejected'), '{}')`;

export function registerTimelineRoutes(app: Hono, db: Db) {
  async function requireProject(projectId: string) {
    const { rowCount } = await db.query("select 1 from projects where project_id = $1", [projectId]);
    if (!rowCount) notFound("project");
  }

  // Newest first; keyset on (occurred_at, item_id), anchored on the cursor
  // row's own values so no timestamp round-trips through JS.
  app.get("/projects/:projectId/timeline", async (c) => {
    const q = ListTimelineQuery.parse(c.req.query());
    const projectId = c.req.param("projectId");
    await requireProject(projectId);

    const limit = Math.min(q.limit ?? LIMIT.default, LIMIT.max);
    const params: unknown[] = [projectId];
    const where = ["t.project_id = $1"];
    if (q.task_id) {
      params.push(q.task_id);
      where.push(`($${params.length} = any(t.related_task_ids) or $${params.length} = any(${LINKED_TASKS}))`);
    }
    if (q.branch) {
      params.push(q.branch);
      where.push(`exists (
        select 1 from github_events e
         where t.entity_type = 'github_events'
           and e.project_id = t.project_id
           and e.event_id = t.entity_id
           and e.branch = $${params.length}
      )`);
    }
    if (q.cursor) {
      params.push(q.cursor);
      where.push(
        `(t.occurred_at, t.item_id) < (select occurred_at, item_id from timeline_items
                                        where project_id = $1 and item_id = $${params.length})`,
      );
    }
    params.push(limit + 1);
    const { rows } = await db.query(
      `select t.item_id, t.project_id, t.occurred_at, t.kind, t.title, t.summary, t.actor, t.entity_type, t.entity_id,
              array(select distinct unnest(t.related_task_ids || ${LINKED_TASKS}) order by 1) as related_task_ids
         from timeline_items t
        where ${where.join(" and ")}
        order by t.occurred_at desc, t.item_id desc
        limit $${params.length}`,
      params,
    );
    const items = rows.slice(0, limit);
    return c.json({ items, next_cursor: rows.length > limit ? items[items.length - 1].item_id : null });
  });

  app.get("/projects/:projectId/decisions", async (c) => {
    const projectId = c.req.param("projectId");
    await requireProject(projectId);
    const { rows } = await db.query(
      "select * from decisions where project_id = $1 order by decided_at desc, decision_id desc",
      [projectId],
    );
    return c.json(rows);
  });

  app.post("/projects/:projectId/decisions", async (c) => {
    const input = await parseBody(c, CreateDecisionInput);
    const projectId = c.req.param("projectId");
    await requireProject(projectId);

    const decision = await withTransaction(db, async (tx) => {
      const { rowCount: isMember } = await tx.query(
        "select 1 from project_members where project_id = $1 and member_id = $2",
        [projectId, input.member_id],
      );
      if (!isMember) throw new HTTPException(400, { message: "member_id is not a member of this project" });
      // related_task_ids is an array, so no FK checks it; do it here.
      const taskIds = [...new Set(input.related_task_ids)];
      const { rowCount: found } = await tx.query(
        "select 1 from tasks where project_id = $1 and task_id = any($2)",
        [projectId, taskIds],
      );
      if (found !== taskIds.length) throw new HTTPException(400, { message: "related_task_ids must be tasks in this project" });

      const { rows: [row] } = await tx.query(
        `insert into decisions (decision_id, project_id, title, body, decided_by, related_task_ids)
         values ($1, $2, $3, $4, $5, $6) returning *`,
        [newId("dec"), projectId, input.title, input.body, input.member_id, taskIds],
      );
      await tx.query(
        `insert into timeline_items
           (item_id, project_id, occurred_at, kind, title, summary, actor, entity_type, entity_id, related_task_ids)
         values ($1, $2, $3, 'decision', $4, $5, $6, 'decisions', $7, $8)`,
        [newId("tl"), projectId, row.decided_at, `Decision: ${row.title}`, row.body, row.decided_by, row.decision_id, taskIds],
      );
      return row;
    });
    return c.json(decision, 201);
  });
}
