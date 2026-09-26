import type pg from "pg";

export type PlanVersionSource = "initial" | "manual" | "replan_accepted";

// Snapshots the live plan (milestones, tasks, dependencies) as a new
// plan_versions row and makes it the project's current version. Must run in
// the same transaction as the plan edits it records.
export async function savePlanVersion(
  tx: pg.PoolClient,
  input: {
    projectId: string;
    version: number;
    source: PlanVersionSource;
    suggestionId?: string | null;
    summary: string | null;
    createdBy: string | null;
  },
): Promise<void> {
  const milestones = await tx.query(
    "select * from milestones where project_id = $1 order by sort_order, created_at",
    [input.projectId],
  );
  const tasks = await tx.query(
    "select * from tasks where project_id = $1 order by sort_order, created_at",
    [input.projectId],
  );
  const dependencies = await tx.query(
    "select * from task_dependencies where project_id = $1 order by task_id, depends_on_task_id",
    [input.projectId],
  );
  const snapshot = { milestones: milestones.rows, tasks: tasks.rows, dependencies: dependencies.rows };

  await tx.query(
    `insert into plan_versions (project_id, version, source, suggestion_id, summary, snapshot, created_by)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.projectId, input.version, input.source, input.suggestionId ?? null,
      input.summary, JSON.stringify(snapshot), input.createdBy,
    ],
  );
  await tx.query("update projects set current_plan_version = $2 where project_id = $1", [
    input.projectId, input.version,
  ]);
}
