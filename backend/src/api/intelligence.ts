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

  app.get("/projects/:projectId/tasks/:taskId/evidence", async (c) => {
    const evidence = await loadTaskEvidence(db, c.req.param("projectId"), c.req.param("taskId"));
    return c.json(evidence ?? notFound("task"));
  });
}
