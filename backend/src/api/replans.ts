import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type pg from "pg";
import { z } from "zod";
import { withTransaction, type Db } from "../db.js";
import { newId } from "../ids.js";
import { notFound, parseBody } from "./http.js";

const ReplanStatus = z.enum(["proposed", "accepted", "rejected", "superseded"]);
const ReviewReplanInput = z.object({ member_id: z.string().min(1) });

async function requireMember(tx: pg.PoolClient, projectId: string, memberId: string) {
  const { rowCount } = await tx.query(
    "select 1 from project_members where project_id = $1 and member_id = $2",
    [projectId, memberId],
  );
  if (rowCount === 0) throw new HTTPException(400, { message: "member_id is not a member of this project" });
}

// Locks the suggestion for the rest of the transaction; only proposed ones can be reviewed.
async function lockProposed(tx: pg.PoolClient, projectId: string, suggestionId: string) {
  const { rows } = await tx.query(
    "select * from replan_suggestions where project_id = $1 and suggestion_id = $2 for update",
    [projectId, suggestionId],
  );
  const suggestion = rows[0] ?? notFound("replan suggestion");
  if (suggestion.status !== "proposed") {
    throw new HTTPException(409, { message: `replan suggestion is already ${suggestion.status}` });
  }
  return suggestion;
}

async function addTimelineItem(
  tx: pg.PoolClient,
  item: {
    projectId: string;
    kind: "replan_reviewed" | "plan_change";
    title: string;
    summary: string | null;
    actor: string;
    entityType: string;
    entityId: string;
    relatedTaskIds?: string[];
  },
) {
  await tx.query(
    `insert into timeline_items
       (item_id, project_id, occurred_at, kind, title, summary, actor, entity_type, entity_id, related_task_ids)
     values ($1, $2, now(), $3, $4, $5, $6, $7, $8, $9)`,
    [
      newId("tl"), item.projectId, item.kind, item.title, item.summary, item.actor,
      item.entityType, item.entityId, item.relatedTaskIds ?? [],
    ],
  );
}

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

  app.post("/projects/:projectId/replans/:suggestionId/reject", async (c) => {
    const { member_id } = await parseBody(c, ReviewReplanInput);
    const projectId = c.req.param("projectId");
    const suggestion = await withTransaction(db, async (tx) => {
      await requireMember(tx, projectId, member_id);
      await lockProposed(tx, projectId, c.req.param("suggestionId"));
      const { rows } = await tx.query(
        `update replan_suggestions set status = 'rejected', reviewed_by = $3, reviewed_at = now()
          where project_id = $1 and suggestion_id = $2 returning *`,
        [projectId, c.req.param("suggestionId"), member_id],
      );
      await addTimelineItem(tx, {
        projectId,
        kind: "replan_reviewed",
        title: "Replan rejected",
        summary: rows[0].rationale,
        actor: member_id,
        entityType: "replan_suggestions",
        entityId: rows[0].suggestion_id,
      });
      return rows[0];
    });
    return c.json(suggestion);
  });
}
