import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { withAiProject } from "../ai/audit.js";
import type { ModelRouter } from "../ai/router.js";
import { bootstrapPlanFromBrief } from "../analysis/planBootstrap.js";
import { STATUS_LABEL } from "../analysis/planSync.js";
import { runAnalysis } from "../analysis/runner.js";
import type { PlanStatus } from "../analysis/types.js";
import { withTransaction, type Db } from "../db.js";
import { newId } from "../ids.js";
import { notFound, parseBody } from "./http.js";
import { loadWorkspaces } from "./workspace.js";

const AgentInput = z.object({ member_id: z.string().min(1).nullable().default(null) });
const UndoInput = z.object({ member_id: z.string().min(1) });
const MOVES_LIMIT = { default: 100, max: 200 };

export function registerPlanAgentRoutes(app: Hono, db: Db, router: ModelRouter | null) {
  app.post("/projects/:projectId/plan-agent/bootstrap", async (c) => {
    const input = await parseBody(c, AgentInput);
    const projectId = c.req.param("projectId");
    // Associate bootstrap completions (including failures) with this project
    // so they appear in its AI audit and Fails view.
    const result = await withAiProject(projectId, () =>
      bootstrapPlanFromBrief(db, router, projectId, input.member_id),
    );
    // The plan has already been committed at this point. A follow-up analysis
    // failure must not turn a successful plan creation into a misleading 500.
    // forcePlanSync: a fresh plan catches up with work already in the repo now.
    const analysis = await runAnalysis(db, router, projectId, new Date(), { forcePlanSync: true }).catch((error) => {
      console.error("post-bootstrap analysis failed", { projectId, error });
      return undefined;
    });
    const [workspace] = await loadWorkspaces(db, [projectId]);
    return c.json({ ...result, ...(analysis ? { analysis } : {}), workspace }, 201);
  });

  // Plan status changes the agent made on its own, newest first.
  app.get("/projects/:projectId/status-moves", async (c) => {
    const projectId = c.req.param("projectId");
    const { rowCount } = await db.query("select 1 from projects where project_id = $1", [projectId]);
    if (!rowCount) notFound("project");
    const requested = Number(c.req.query("limit"));
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, MOVES_LIMIT.max) : MOVES_LIMIT.default;
    const { rows } = await db.query(
      "select * from plan_status_moves where project_id = $1 order by created_at desc, move_id desc limit $2",
      [projectId, limit],
    );
    return c.json(rows);
  });

  // Puts the task back where it was and hands its status to the team, so the
  // agent won't move it again. Refused if anyone changed the status since.
  app.post("/projects/:projectId/status-moves/:moveId/undo", async (c) => {
    const input = await parseBody(c, UndoInput);
    const projectId = c.req.param("projectId");
    const moveId = c.req.param("moveId");
    const move = await withTransaction(db, async (tx) => {
      const { rows: [move] } = await tx.query<{
        task_id: string; task_key: string; from_status: PlanStatus; to_status: PlanStatus; undone_at: Date | null;
      }>(
        `select m.task_id, t.task_key, m.from_status, m.to_status, m.undone_at
           from plan_status_moves m join tasks t on t.project_id = m.project_id and t.task_id = m.task_id
          where m.project_id = $1 and m.move_id = $2
          for update of m`,
        [projectId, moveId],
      );
      if (!move) notFound("status move");
      const { rowCount: isMember } = await tx.query(
        "select 1 from project_members where project_id = $1 and member_id = $2",
        [projectId, input.member_id],
      );
      if (!isMember) throw new HTTPException(400, { message: "member_id is not a member of this project" });
      if (move.undone_at) throw new HTTPException(409, { message: "this change was already undone" });

      const restored = await tx.query(
        `update tasks set plan_status = $3, plan_status_set_by = $4
          where project_id = $1 and task_id = $2 and plan_status = $5 and plan_status_set_by = 'agent'`,
        [projectId, move.task_id, move.from_status, input.member_id, move.to_status],
      );
      if (!restored.rowCount) {
        throw new HTTPException(409, { message: `${move.task_key}'s status changed since the agent moved it; edit it in the plan instead` });
      }
      const { rows: [undone] } = await tx.query(
        "update plan_status_moves set undone_by = $3, undone_at = now() where project_id = $1 and move_id = $2 returning *",
        [projectId, moveId, input.member_id],
      );
      // Its own entity_type: the feed offers Undo only on the agent's entries.
      await tx.query(
        `insert into timeline_items
           (item_id, project_id, occurred_at, kind, title, actor, entity_type, entity_id, related_task_ids)
         values ($1, $2, now(), 'plan_change', $3, $4, 'plan_status_move_undo', $5, $6)`,
        [newId("tl"), projectId, `Undid agent move: ${move.task_key} back to ${STATUS_LABEL[move.from_status]}`,
         input.member_id, moveId, [move.task_id]],
      );
      return undone;
    });
    return c.json(move);
  });

  app.post("/projects/:projectId/plan-agent/run", async (c) => {
    await parseBody(c, AgentInput);
    const projectId = c.req.param("projectId");
    const analysis = await runAnalysis(db, router, projectId, new Date(), { forcePlanSync: true });
    const [workspace] = await loadWorkspaces(db, [projectId]);
    return c.json({ analysis, workspace });
  });
}
