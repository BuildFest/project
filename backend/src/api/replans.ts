import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type pg from "pg";
import { z } from "zod";
import { withTransaction, type Db } from "../db.js";
import { newId } from "../ids.js";
import { notFound, parseBody } from "./http.js";
import { PlanChanges, type PlanChange } from "./planChanges.js";
import { savePlanVersion } from "./planVersions.js";

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

function conflict(message: string): never {
  throw new HTTPException(409, { message });
}

// SET clause for a zod-parsed patch. Keys are whitelisted column names (zod
// strips unknown keys), so nothing user-controlled is interpolated.
function setClause(patch: Record<string, unknown>, firstParam: number) {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  return {
    sql: keys.map((k, i) => `${k} = $${i + firstParam}`).join(", "),
    values: keys.map((k) => patch[k]),
  };
}

// Applies one plan change and returns the task IDs it touched. A change that
// no longer fits the plan (missing task, dependency already gone) is a 409;
// database rules (cycles, duplicates, bad references) surface through
// pgErrorToHttp as usual. Either way the whole accept rolls back.
async function applyChange(
  tx: pg.PoolClient,
  projectId: string,
  version: number,
  memberId: string,
  change: PlanChange,
): Promise<string[]> {
  switch (change.op) {
    case "update_task": {
      // A status the team accepted is theirs, like one they typed.
      const changes = change.changes.plan_status === undefined
        ? change.changes
        : { ...change.changes, plan_status_set_by: memberId };
      const set = setClause(changes, 4);
      const { rowCount } = await tx.query(
        `update tasks set ${set.sql}, updated_in_plan_version = $3
          where project_id = $1 and task_id = $2 and not archived`,
        [projectId, change.task_id, version, ...set.values],
      );
      if (rowCount === 0) conflict(`task ${change.task_id} no longer exists`);
      return [change.task_id];
    }
    case "create_task": {
      const t = change.task;
      const { rows: [{ task_key }] } = await tx.query("select allocate_task_key($1) as task_key", [projectId]);
      const taskId = newId("task");
      await tx.query(
        `insert into tasks (task_id, task_key, project_id, title, description, owner_member_id, priority, scope,
                            plan_status, milestone_id, target_at, sort_order, created_in_plan_version,
                            plan_status_set_by)
         values ($1, $2, $3, $4, $5, $6, coalesce($7, 'medium'), coalesce($8, 'must_have'),
                 coalesce($9, 'not_started'), $10, $11, coalesce($12, 0), $13, $14)`,
        [
          taskId, task_key, projectId, t.title, t.description ?? null, t.owner_member_id ?? null,
          t.priority ?? null, t.scope ?? null, t.plan_status ?? null, t.milestone_id ?? null,
          t.target_at ?? null, t.sort_order ?? null, version,
          t.plan_status && t.plan_status !== "not_started" ? memberId : null,
        ],
      );
      return [taskId];
    }
    case "add_dependency":
      await tx.query(
        `insert into task_dependencies (project_id, task_id, depends_on_task_id, created_by) values ($1, $2, $3, $4)`,
        [projectId, change.task_id, change.depends_on_task_id, memberId],
      );
      return [change.task_id, change.depends_on_task_id];
    case "remove_dependency": {
      const { rowCount } = await tx.query(
        `delete from task_dependencies where project_id = $1 and task_id = $2 and depends_on_task_id = $3`,
        [projectId, change.task_id, change.depends_on_task_id],
      );
      if (rowCount === 0) conflict(`dependency ${change.task_id} -> ${change.depends_on_task_id} no longer exists`);
      return [change.task_id, change.depends_on_task_id];
    }
    case "update_milestone": {
      const set = setClause(change.changes, 3);
      const { rowCount } = await tx.query(
        `update milestones set ${set.sql} where project_id = $1 and milestone_id = $2 and not archived`,
        [projectId, change.milestone_id, ...set.values],
      );
      if (rowCount === 0) conflict(`milestone ${change.milestone_id} no longer exists`);
      return [];
    }
  }
}

export function registerReplanRoutes(app: Hono, db: Db, onPlanChanged?: (projectId: string) => void) {
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

  // Applies the suggestion's changes, saves the result as a new plan version,
  // and marks it accepted, all in one transaction (tech doc §5 rule 4: the
  // plan only changes when a human accepts).
  app.post("/projects/:projectId/replans/:suggestionId/accept", async (c) => {
    const { member_id } = await parseBody(c, ReviewReplanInput);
    const projectId = c.req.param("projectId");
    const suggestionId = c.req.param("suggestionId");

    const result = await withTransaction(db, async (tx) => {
      await requireMember(tx, projectId, member_id);
      const { rows: [project] } = await tx.query(
        "select current_plan_version from projects where project_id = $1 for update",
        [projectId],
      );
      // Serialize accepts per project before locking an individual suggestion.
      // A consistent lock order prevents two concurrent accepts from each
      // holding one suggestion row while trying to supersede the other.
      const suggestion = await lockProposed(tx, projectId, suggestionId);
      if (project.current_plan_version !== suggestion.based_on_plan_version) {
        conflict(
          `the plan has changed since this suggestion was made ` +
            `(v${suggestion.based_on_plan_version} -> v${project.current_plan_version})`,
        );
      }

      const parsed = PlanChanges.safeParse(suggestion.proposed_changes);
      if (!parsed.success) conflict("replan suggestion contains changes that can't be applied");

      const version = suggestion.based_on_plan_version + 1;
      const touched = new Set<string>();
      for (const change of parsed.data) {
        for (const taskId of await applyChange(tx, projectId, version, member_id, change)) touched.add(taskId);
      }

      await savePlanVersion(tx, {
        projectId,
        version,
        source: "replan_accepted",
        suggestionId,
        summary: suggestion.rationale,
        createdBy: member_id,
      });

      const { rows: [accepted] } = await tx.query(
        `update replan_suggestions set status = 'accepted', reviewed_by = $3, reviewed_at = now()
          where project_id = $1 and suggestion_id = $2 returning *`,
        [projectId, suggestionId, member_id],
      );
      // Other open suggestions were made against the old plan.
      await tx.query(
        `update replan_suggestions set status = 'superseded'
          where project_id = $1 and status = 'proposed' and suggestion_id <> $2`,
        [projectId, suggestionId],
      );

      const relatedTaskIds = [...touched];
      await addTimelineItem(tx, {
        projectId,
        kind: "replan_reviewed",
        title: "Replan accepted",
        summary: suggestion.rationale,
        actor: member_id,
        entityType: "replan_suggestions",
        entityId: suggestionId,
        relatedTaskIds,
      });
      await addTimelineItem(tx, {
        projectId,
        kind: "plan_change",
        title: `Plan v${version} saved from an accepted replan`,
        summary: `${parsed.data.length} change${parsed.data.length === 1 ? "" : "s"} applied`,
        actor: member_id,
        entityType: "plan_versions",
        entityId: `${projectId}:${version}`,
        relatedTaskIds,
      });

      return { suggestion: accepted, plan_version: version };
    });
    onPlanChanged?.(projectId);
    return c.json(result);
  });
}
