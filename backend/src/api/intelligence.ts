import type { Hono } from "hono";
import type pg from "pg";
import type { Db, Queryable } from "../db.js";
import { notFound } from "./http.js";

type Row = pg.QueryResultRow;

// Matches ProjectState in docs/api-contract.md §5.1.
export interface ProjectState {
  computed_at: Date | null;
  tasks: Row[];
  signals: Row[];
  collisions: Row[];
  pending_links: Row[];
  open_replans: number;
}

// Matches TaskEvidence in docs/api-contract.md §5.2.
export interface TaskEvidence {
  task: Row;
  state: Row | null;
  blocking_tasks: Array<{ task: Row; state: Row | null }>;
  links: Row[];
  signals: Row[];
}

export type RiskStatus = "active" | "resolved" | "dismissed";

export interface RiskHistoryItem {
  risk_id: string;
  kind: "signal" | "collision";
  title: string;
  description: string;
  status: RiskStatus;
  severity: "info" | "warning" | "critical";
  related_task_ids: string[];
  detected_at: Date;
  resolved_at: Date | null;
  detection_event_id: string | null;
  resolution_event_id: string | null;
}

export async function loadRiskHistory(
  db: Queryable,
  projectId: string,
  status: RiskStatus | "all" = "all",
  limit = 20,
): Promise<RiskHistoryItem[] | null> {
  const project = await db.query("select 1 from projects where project_id = $1", [projectId]);
  if (project.rowCount === 0) return null;

  const { rows } = await db.query<RiskHistoryItem>(
    `with risks as (
       select signal_id as risk_id, 'signal'::text as kind, title, explanation as description,
              status, severity, related_task_ids, detected_at, resolved_at,
              'health_signal'::text as entity_type
         from health_signals where project_id = $1
       union all
       select collision_id, 'collision',
              'Overlapping work on ' || branch_a || ' and ' || branch_b,
              array_length(overlapping_files, 1) || case when array_length(overlapping_files, 1) = 1 then ' shared file' else ' shared files' end,
              status, 'warning', array_remove(array[task_a_id, task_b_id], null), detected_at, resolved_at,
              'collision'
         from collisions where project_id = $1
     )
     select r.*,
            detected.item_id as detection_event_id,
            resolved.item_id as resolution_event_id
       from risks r
       left join lateral (
         select item_id from timeline_items
          where project_id = $1 and entity_type = r.entity_type and entity_id = r.risk_id
            and kind in ('signal_detected', 'collision_detected')
          order by occurred_at asc, item_id asc limit 1
       ) detected on true
       left join lateral (
         select item_id from timeline_items
          where project_id = $1 and entity_type = r.entity_type and entity_id = r.risk_id
            and kind in ('signal_resolved', 'collision_resolved')
          order by occurred_at desc, item_id desc limit 1
       ) resolved on true
      where ($2 = 'all' or r.status = $2)
      order by coalesce(r.resolved_at, r.detected_at) desc, r.risk_id desc
      limit $3`,
    [projectId, status, limit],
  );
  return rows;
}

// Attaches each link's github_events row as `event`. A second query rather
// than to_jsonb() so timestamps serialize the same way as every other response.
async function withEvents(db: Queryable, projectId: string, links: Row[]): Promise<Row[]> {
  if (links.length === 0) return [];
  const { rows } = await db.query(
    "select * from github_events where project_id = $1 and event_id = any($2)",
    [projectId, links.map((l) => l.event_id)],
  );
  const events = new Map(rows.map((e) => [e.event_id, e]));
  return links
    .filter((l) => events.has(l.event_id))
    .map((l) => ({ ...l, event: events.get(l.event_id) }))
    .sort((a, b) => b.event.occurred_at.getTime() - a.event.occurred_at.getTime());
}

// Read-only snapshot for the dashboard, which polls it. Never triggers analysis.
// Sequential queries: db may be a single transaction client.
export async function loadProjectState(db: Queryable, projectId: string): Promise<ProjectState | null> {
  const project = await db.query("select 1 from projects where project_id = $1", [projectId]);
  if (project.rowCount === 0) return null;

  const tasks = await db.query(
    `select d.* from derived_task_states d
       join tasks t on t.project_id = d.project_id and t.task_id = d.task_id
      where d.project_id = $1 and not t.archived
      order by t.sort_order, t.created_at`,
    [projectId],
  );
  const signals = await db.query(
    "select * from health_signals where project_id = $1 and status = 'active' order by detected_at desc",
    [projectId],
  );
  const collisions = await db.query(
    "select * from collisions where project_id = $1 and status = 'active' order by detected_at desc",
    [projectId],
  );
  const links = await db.query(
    "select * from event_task_links where project_id = $1 and status = 'suggested'",
    [projectId],
  );
  const replans = await db.query<{ count: number }>(
    "select count(*)::int as count from replan_suggestions where project_id = $1 and status = 'proposed'",
    [projectId],
  );
  const computed = await db.query<{ computed_at: Date | null }>(
    "select max(computed_at) as computed_at from derived_task_states where project_id = $1",
    [projectId],
  );

  return {
    computed_at: computed.rows[0].computed_at,
    tasks: tasks.rows,
    signals: signals.rows,
    collisions: collisions.rows,
    pending_links: await withEvents(db, projectId, links.rows),
    open_replans: replans.rows[0].count,
  };
}

// Loads the rows behind the evidence drawer without triggering analysis.
// Sequential queries: db may be a single transaction client.
export async function loadTaskEvidence(
  db: Queryable,
  projectId: string,
  taskId: string,
): Promise<TaskEvidence | null> {
  const task = await db.query("select * from tasks where project_id = $1 and task_id = $2", [projectId, taskId]);
  if (task.rowCount === 0) return null;

  const state = await db.query(
    "select * from derived_task_states where project_id = $1 and task_id = $2",
    [projectId, taskId],
  );
  const currentState = state.rows[0] ?? null;
  const blockingIds: string[] = currentState?.blocking_task_ids ?? [];
  let blockingTasks: Array<{ task: Row; state: Row | null }> = [];
  if (blockingIds.length > 0) {
    const tasks = await db.query(
      "select * from tasks where project_id = $1 and task_id = any($2)",
      [projectId, blockingIds],
    );
    const states = await db.query(
      "select * from derived_task_states where project_id = $1 and task_id = any($2)",
      [projectId, blockingIds],
    );
    const tasksById = new Map(tasks.rows.map((row) => [row.task_id, row]));
    const statesById = new Map(states.rows.map((row) => [row.task_id, row]));
    blockingTasks = blockingIds
      .filter((id) => tasksById.has(id))
      .map((id) => ({ task: tasksById.get(id)!, state: statesById.get(id) ?? null }));
  }

  const links = await db.query(
    "select * from event_task_links where project_id = $1 and task_id = $2 and status <> 'rejected'",
    [projectId, taskId],
  );
  const signals = await db.query(
    `select * from health_signals
      where project_id = $1 and status = 'active' and related_task_ids @> array[$2]::text[]
      order by detected_at desc`,
    [projectId, taskId],
  );

  return {
    task: task.rows[0],
    state: currentState,
    blocking_tasks: blockingTasks,
    links: await withEvents(db, projectId, links.rows),
    signals: signals.rows,
  };
}

export function registerIntelligenceRoutes(app: Hono, db: Db) {
  app.get("/projects/:projectId/state", async (c) => {
    const state = await loadProjectState(db, c.req.param("projectId"));
    return c.json(state ?? notFound("project"));
  });

  app.get("/projects/:projectId/risks", async (c) => {
    const rawStatus = c.req.query("status") ?? "all";
    if (!["all", "active", "resolved", "dismissed"].includes(rawStatus)) {
      return c.json({ error: "status must be active, resolved, dismissed, or all" }, 400);
    }
    const requested = Number(c.req.query("limit") ?? 20);
    if (!Number.isInteger(requested) || requested < 1) {
      return c.json({ error: "limit must be a positive integer" }, 400);
    }
    const risks = await loadRiskHistory(db, c.req.param("projectId"), rawStatus as RiskStatus | "all", Math.min(requested, 100));
    return c.json(risks ?? notFound("project"));
  });

  app.get("/projects/:projectId/tasks/:taskId/evidence", async (c) => {
    const evidence = await loadTaskEvidence(db, c.req.param("projectId"), c.req.param("taskId"));
    return c.json(evidence ?? notFound("task"));
  });

  app.get("/projects/:projectId/pr-notes", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await db.query("select 1 from projects where project_id=$1", [projectId]);
    if (!project.rowCount) return notFound("project");
    const requested = Number(c.req.query("limit") ?? 50);
    const limit = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 200) : 50;
    const { rows } = await db.query(
      `select * from pr_notes where project_id=$1 order by created_at desc,note_id desc limit $2`,
      [projectId, limit],
    );
    return c.json(rows);
  });
}
