import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { withTransaction, type Db, type Queryable } from "../db.js";
import { newId } from "../ids.js";
import type { BranchRef } from "../ingestion/compare.js";
import { pgErrorToHttp } from "./errors.js";
import { registerBackfillRoutes } from "./backfill.js";
import { registerBranchRoutes } from "./branches.js";
import { registerEventRoutes } from "./events.js";
import { notFound, parseBody } from "./http.js";
import { registerIngestionRoutes } from "./ingestion.js";
import { registerIntelligenceRoutes } from "./intelligence.js";
import { registerReplanRoutes } from "./replans.js";
import { registerTimelineRoutes } from "./timeline.js";
import {
  CreateDependencyInput,
  CreateMemberInput,
  CreateMilestoneInput,
  CreatePlanVersionInput,
  CreateProjectInput,
  CreateTaskInput,
  UpdateBriefInput,
  UpdateMemberInput,
  UpdateMilestoneInput,
  UpdateProjectInput,
  UpdateTaskInput,
} from "./inputs.js";
import { savePlanVersion } from "./planVersions.js";
import { loadWorkspaces } from "./workspace.js";

/**
 * UPDATE ... SET only the keys present in `patch`. Column names come from a
 * zod-parsed object (unknown keys stripped), and table/id column are literals
 * at every call site, so nothing user-controlled is interpolated.
 */
async function updateRow(
  db: Queryable,
  table: "projects" | "project_members" | "milestones" | "tasks",
  idColumn: "project_id" | "member_id" | "milestone_id" | "task_id",
  projectId: string,
  id: string,
  patch: Record<string, unknown>,
) {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (keys.length === 0) throw new HTTPException(400, { message: "no fields to update" });
  const sets = keys.map((k, i) => `${k} = $${i + 3}`).join(", ");
  const { rows } = await db.query(
    `update ${table} set ${sets} where project_id = $1 and ${idColumn} = $2 returning *`,
    [projectId, id, ...keys.map((k) => patch[k])],
  );
  return rows[0] ?? null;
}

export function createApp(
  db: Db,
  onEventsIngested?: (projectIds: string[]) => void,
  onBranchesPushed?: (refs: BranchRef[]) => void,
) {
  const app = new Hono();

  app.use("*", cors({ origin: process.env.CORS_ORIGIN ?? "http://localhost:3000" }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues }, 400);
    const mapped = pgErrorToHttp(err);
    if (mapped) return c.json(mapped.body, mapped.status);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // ---- projects ------------------------------------------------------------

  app.get("/projects", async (c) => {
    const { rows } = await db.query("select project_id from projects where status = 'active'");
    return c.json(await loadWorkspaces(db, rows.map((r) => r.project_id)));
  });

  app.get("/projects/:projectId", async (c) => {
    const [workspace] = await loadWorkspaces(db, [c.req.param("projectId")]);
    return workspace ? c.json(workspace) : notFound("project");
  });

  app.post("/projects", async (c) => {
    const input = await parseBody(c, CreateProjectInput);
    const projectId = newId("proj");
    const members = input.members.map((m, i) => ({
      ...m,
      member_id: newId("mem"),
      access_level: i === 0 ? "owner" : "editor",
    }));
    const creator = members[0]?.member_id ?? "system";

    const workspace = await withTransaction(db, async (tx) => {
      await tx.query(
        `insert into projects (project_id, name, description, task_key_prefix, created_by, deadline_at, timezone)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [projectId, input.name, input.description ?? null, input.task_key_prefix, creator, input.deadline_at, input.timezone],
      );
      for (const m of members) {
        await tx.query(
          `insert into project_members (member_id, project_id, display_name, role_label, github_login, access_level)
           values ($1, $2, $3, $4, $5, $6)`,
          [m.member_id, projectId, m.display_name, m.role_label ?? null, m.github_login, m.access_level],
        );
      }
      await tx.query(
        `insert into project_briefs (project_id, content, updated_by) values ($1, $2, $3)`,
        [projectId, input.brief, members[0]?.member_id ?? null],
      );
      const [created] = await loadWorkspaces(tx, [projectId]);
      return created;
    });
    return c.json(workspace, 201);
  });

  app.patch("/projects/:projectId", async (c) => {
    const patch = await parseBody(c, UpdateProjectInput);
    const id = c.req.param("projectId");
    return c.json((await updateRow(db, "projects", "project_id", id, id, patch)) ?? notFound("project"));
  });

  app.put("/projects/:projectId/brief", async (c) => {
    const input = await parseBody(c, UpdateBriefInput);
    const { rows } = await db.query(
      `update project_briefs set content = $2, content_format = $3, updated_by = $4
        where project_id = $1 returning *`,
      [c.req.param("projectId"), input.content, input.content_format, input.updated_by],
    );
    return c.json(rows[0] ?? notFound("project"));
  });

  // ---- members -------------------------------------------------------------

  app.post("/projects/:projectId/members", async (c) => {
    const input = await parseBody(c, CreateMemberInput);
    const projectId = c.req.param("projectId");
    const { rowCount } = await db.query("select 1 from projects where project_id = $1", [projectId]);
    if (!rowCount) notFound("project");
    // A github_login already used in this project is a unique violation -> 409.
    const { rows } = await db.query(
      `insert into project_members (member_id, project_id, display_name, github_login, role_label, access_level)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [newId("mem"), projectId, input.display_name, input.github_login, input.role_label ?? null, input.access_level],
    );
    return c.json(rows[0], 201);
  });

  app.patch("/projects/:projectId/members/:memberId", async (c) => {
    const patch = await parseBody(c, UpdateMemberInput);
    const row = await updateRow(db, "project_members", "member_id", c.req.param("projectId"), c.req.param("memberId"), patch);
    return c.json(row ?? notFound("member"));
  });

  // ---- milestones ----------------------------------------------------------

  app.post("/projects/:projectId/milestones", async (c) => {
    const input = await parseBody(c, CreateMilestoneInput);
    const { rows } = await db.query(
      `insert into milestones (milestone_id, project_id, name, description, target_at, sort_order)
       values ($1, $2, $3, $4, $5, coalesce($6, 0)) returning *`,
      [newId("ms"), c.req.param("projectId"), input.name, input.description ?? null, input.target_at ?? null, input.sort_order ?? null],
    );
    return c.json(rows[0], 201);
  });

  app.patch("/projects/:projectId/milestones/:milestoneId", async (c) => {
    const patch = await parseBody(c, UpdateMilestoneInput);
    const row = await updateRow(db, "milestones", "milestone_id", c.req.param("projectId"), c.req.param("milestoneId"), patch);
    return c.json(row ?? notFound("milestone"));
  });

  // ---- tasks ---------------------------------------------------------------

  app.post("/projects/:projectId/tasks", async (c) => {
    const input = await parseBody(c, CreateTaskInput);
    const projectId = c.req.param("projectId");

    // Key allocation and insert share a transaction: if the insert fails, the
    // counter bump rolls back too and no task number is burned.
    const task = await withTransaction(db, async (tx) => {
      const { rows: [{ task_key }] } = await tx.query("select allocate_task_key($1) as task_key", [projectId]);
      if (!task_key) notFound("project");
      const { rows } = await tx.query(
        `insert into tasks (task_id, task_key, project_id, title, description, owner_member_id, priority, scope,
                            plan_status, milestone_id, target_at, sort_order)
         values ($1, $2, $3, $4, $5, $6, coalesce($7, 'medium'), coalesce($8, 'must_have'),
                 coalesce($9, 'not_started'), $10, $11, coalesce($12, 0))
         returning *`,
        [
          newId("task"), task_key, projectId, input.title, input.description ?? null, input.owner_member_id ?? null,
          input.priority ?? null, input.scope ?? null, input.plan_status ?? null, input.milestone_id ?? null,
          input.target_at ?? null, input.sort_order ?? null,
        ],
      );
      return rows[0];
    });
    return c.json(task, 201);
  });

  app.patch("/projects/:projectId/tasks/:taskId", async (c) => {
    const patch = await parseBody(c, UpdateTaskInput);
    const row = await updateRow(db, "tasks", "task_id", c.req.param("projectId"), c.req.param("taskId"), patch);
    return c.json(row ?? notFound("task"));
  });

  // ---- dependencies --------------------------------------------------------

  app.post("/projects/:projectId/dependencies", async (c) => {
    const input = await parseBody(c, CreateDependencyInput);
    const { rows } = await db.query(
      `insert into task_dependencies (project_id, task_id, depends_on_task_id) values ($1, $2, $3) returning *`,
      [c.req.param("projectId"), input.task_id, input.depends_on_task_id],
    );
    return c.json(rows[0], 201);
  });

  app.delete("/projects/:projectId/dependencies/:taskId/:dependsOnTaskId", async (c) => {
    const { rowCount } = await db.query(
      `delete from task_dependencies where project_id = $1 and task_id = $2 and depends_on_task_id = $3`,
      [c.req.param("projectId"), c.req.param("taskId"), c.req.param("dependsOnTaskId")],
    );
    return rowCount ? c.body(null, 204) : notFound("dependency");
  });

  // ---- plan versions -------------------------------------------------------

  // "Save plan": snapshots the live plan as the next version. Replan
  // suggestions are relative to a version, so the plan editor calls this once
  // the initial plan is set up, and again after manual edits worth keeping.
  app.post("/projects/:projectId/plan-versions", async (c) => {
    const input = await parseBody(c, CreatePlanVersionInput);
    const projectId = c.req.param("projectId");
    const saved = await withTransaction(db, async (tx) => {
      // Row lock: two concurrent saves can't claim the same version number.
      const { rows: [project] } = await tx.query(
        "select current_plan_version from projects where project_id = $1 for update",
        [projectId],
      );
      if (!project) notFound("project");
      if (input.member_id) {
        const { rowCount } = await tx.query(
          "select 1 from project_members where project_id = $1 and member_id = $2",
          [projectId, input.member_id],
        );
        if (!rowCount) throw new HTTPException(400, { message: "member_id is not a member of this project" });
      }

      const version = (project.current_plan_version ?? 0) + 1;
      await savePlanVersion(tx, {
        projectId,
        version,
        source: version === 1 ? "initial" : "manual",
        summary: input.summary,
        createdBy: input.member_id,
      });
      await tx.query(
        `insert into timeline_items
           (item_id, project_id, occurred_at, kind, title, summary, actor, entity_type, entity_id)
         values ($1, $2, now(), 'plan_change', $3, $4, $5, 'plan_versions', $6)`,
        [newId("tl"), projectId, `Plan v${version} saved`, input.summary, input.member_id, `${projectId}:${version}`],
      );
      const { rows: [row] } = await tx.query(
        "select project_id, version, source, summary, created_at from plan_versions where project_id = $1 and version = $2",
        [projectId, version],
      );
      return row;
    });
    return c.json(saved, 201);
  });

  // ---- repositories and webhooks (src/api/ingestion.ts) ---------------------

  registerIngestionRoutes(app, db, onEventsIngested, onBranchesPushed);
  registerBackfillRoutes(app, db);

  // ---- project intelligence (src/api/intelligence.ts) -----------------------

  registerIntelligenceRoutes(app, db);
  registerReplanRoutes(app, db);

  // ---- events (src/api/events.ts) ------------------------------------------

  registerEventRoutes(app, db);

  // ---- branches (src/api/branches.ts) --------------------------------------

  registerBranchRoutes(app, db);

  // ---- timeline and decisions (src/api/timeline.ts) ------------------------

  registerTimelineRoutes(app, db);

  return app;
}
