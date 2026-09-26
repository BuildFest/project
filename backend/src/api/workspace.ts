import type pg from "pg";
import type { Queryable } from "../db.js";

type Row = pg.QueryResultRow;

// Matches ProjectWorkspace in frontend/lib/types.ts.
export interface ProjectWorkspace {
  project: Row;
  members: Row[];
  brief: Row;
  milestones: Row[];
  tasks: Row[];
  dependencies: Row[];
}

/**
 * Loads full workspaces for the given projects, in the same order as the
 * projects are created. One query per table regardless of how many projects.
 */
export async function loadWorkspaces(db: Queryable, projectIds: string[]): Promise<ProjectWorkspace[]> {
  if (projectIds.length === 0) return [];
  const ids = [projectIds];

  const [projects, members, briefs, milestones, tasks, dependencies] = await Promise.all([
    db.query("select * from projects where project_id = any($1) order by created_at, project_id", ids),
    db.query("select * from project_members where project_id = any($1) order by joined_at, member_id", ids),
    db.query("select * from project_briefs where project_id = any($1)", ids),
    db.query("select * from milestones where project_id = any($1) order by sort_order, created_at", ids),
    db.query("select * from tasks where project_id = any($1) order by sort_order, created_at", ids),
    db.query("select * from task_dependencies where project_id = any($1) order by created_at", ids),
  ]);

  const byProject = (rows: Row[]) => {
    const map = new Map<string, Row[]>();
    for (const row of rows) {
      const list = map.get(row.project_id) ?? [];
      list.push(row);
      map.set(row.project_id, list);
    }
    return map;
  };
  const membersBy = byProject(members.rows);
  const briefsBy = byProject(briefs.rows);
  const milestonesBy = byProject(milestones.rows);
  const tasksBy = byProject(tasks.rows);
  const depsBy = byProject(dependencies.rows);

  return projects.rows.map((project) => ({
    project,
    members: membersBy.get(project.project_id) ?? [],
    brief: briefsBy.get(project.project_id)?.[0] ?? {
      project_id: project.project_id,
      content: "",
      content_format: "markdown",
      updated_at: project.updated_at,
      updated_by: null,
    },
    milestones: milestonesBy.get(project.project_id) ?? [],
    tasks: tasksBy.get(project.project_id) ?? [],
    dependencies: depsBy.get(project.project_id) ?? [],
  }));
}
