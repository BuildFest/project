import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { runJson } from "../ai/json.js";
import type { ModelRouter } from "../ai/router.js";
import { withTransaction, type Db } from "../db.js";
import { newId } from "../ids.js";
import { savePlanVersion } from "../api/planVersions.js";

const Ref = z.string().trim().min(1).max(40);
const NullableTimestamp = z.union([z.iso.date(), z.iso.datetime({ offset: true })]).nullable();

export const GeneratedPlan = z.object({
  summary: z.string().trim().min(1).max(500),
  milestones: z.array(z.object({
    ref: Ref,
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(600).nullable().default(null),
    target_at: NullableTimestamp.default(null),
  })).min(1).max(8),
  tasks: z.array(z.object({
    ref: Ref,
    title: z.string().trim().min(1).max(180),
    description: z.string().trim().max(1200).nullable().default(null),
    owner_member_id: z.string().trim().min(1).nullable().default(null),
    priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
    scope: z.enum(["must_have", "optional"]).default("must_have"),
    milestone_ref: Ref.nullable().default(null),
    target_at: NullableTimestamp.default(null),
    depends_on: z.array(Ref).max(8).default([]),
  })).min(1).max(30),
});

export type GeneratedPlan = z.output<typeof GeneratedPlan>;

export interface BootstrapPlanResult {
  summary: string;
  milestone_count: number;
  task_count: number;
  generated_by: "llm";
  plan_version: number;
}

export async function bootstrapPlanFromBrief(
  db: Db,
  router: ModelRouter | null,
  projectId: string,
  memberId: string | null,
): Promise<BootstrapPlanResult> {
  const context = await db.query<{
    name: string;
    description: string | null;
    deadline_at: string | null;
    timezone: string;
    current_plan_version: number | null;
    brief: string;
    brief_updated_at: string;
  }>(`select p.name,p.description,p.deadline_at,p.timezone,p.current_plan_version,
             b.content as brief,b.updated_at::text as brief_updated_at
        from projects p join project_briefs b using (project_id)
       where p.project_id=$1`, [projectId]);
  const project = context.rows[0];
  if (!project) throw new HTTPException(404, { message: "project not found" });
  if (!project.brief.trim()) throw new HTTPException(409, { message: "write the project brief before generating a plan" });

  const counts = await db.query<{ tasks: number; milestones: number }>(
    `select (select count(*)::int from tasks where project_id=$1 and not archived) as tasks,
            (select count(*)::int from milestones where project_id=$1 and not archived) as milestones`,
    [projectId],
  );
  if (counts.rows[0].tasks > 0 || counts.rows[0].milestones > 0) {
    throw new HTTPException(409, { message: "the project already has a plan; use suggested plan changes instead" });
  }
  if (!router?.available("replan")) {
    throw new HTTPException(503, { message: "the planning agent needs an enabled AI provider" });
  }

  const members = await db.query<{ member_id: string; display_name: string; role_label: string | null; github_login: string | null }>(
    "select member_id,display_name,role_label,github_login from project_members where project_id=$1 order by joined_at",
    [projectId],
  );
  const draft = await runJson(router, "replan", {
    system: [
      "Turn a software project brief into a focused, executable project plan.",
      "Return only JSON matching the requested schema.",
      "Use 2-6 outcome-oriented milestones and 5-24 concrete tasks.",
      "Keep task titles concise, preserve must-have versus optional scope, and express dependencies with task refs.",
      "Use only supplied member_id values for owners; use null when ownership is unclear.",
      "Use ISO timestamps or null. Do not invent dates beyond the project deadline.",
      "Avoid generic tasks such as 'work on project'.",
    ].join(" "),
    messages: [{ role: "user", content: JSON.stringify({
      today: new Date().toISOString(),
      project: {
        name: project.name,
        description: project.description,
        deadline_at: project.deadline_at,
        timezone: project.timezone,
      },
      team: members.rows,
      brief: project.brief,
      output_shape: {
        summary: "short explanation",
        milestones: [{ ref: "m1", name: "...", description: null, target_at: null }],
        tasks: [{
          ref: "t1", title: "...", description: null, owner_member_id: null,
          priority: "high", scope: "must_have", milestone_ref: "m1",
          target_at: null, depends_on: [],
        }],
      },
    }) }],
    maxTokens: 4000,
    temperature: 0.15,
  }, GeneratedPlan, { cacheKey: `bootstrap-plan:${projectId}:${project.brief_updated_at}` });

  const memberIds = new Set(members.rows.map((member) => member.member_id));
  const milestoneRefs = new Set(draft.milestones.map((milestone) => milestone.ref));
  const taskRefs = new Set(draft.tasks.map((task) => task.ref));
  if (milestoneRefs.size !== draft.milestones.length || taskRefs.size !== draft.tasks.length) {
    throw new HTTPException(502, { message: "the planning agent returned duplicate references" });
  }

  let planVersion = 1;
  await withTransaction(db, async (tx) => {
    const locked = await tx.query<{ current_plan_version: number | null }>(
      "select current_plan_version from projects where project_id=$1 for update",
      [projectId],
    );
    if (!locked.rows[0]) throw new HTTPException(404, { message: "project not found" });
    const existing = await tx.query(
      `select 1 from tasks where project_id=$1 and not archived
       union all select 1 from milestones where project_id=$1 and not archived limit 1`,
      [projectId],
    );
    if (existing.rowCount) {
      throw new HTTPException(409, { message: "the plan changed while the agent was working; refresh and try again" });
    }
    planVersion = (locked.rows[0].current_plan_version ?? 0) + 1;
    if (memberId && !memberIds.has(memberId)) {
      throw new HTTPException(400, { message: "member_id is not a member of this project" });
    }

    const milestoneIds = new Map<string, string>();
    for (const [index, milestone] of draft.milestones.entries()) {
      const id = newId("ms");
      milestoneIds.set(milestone.ref, id);
      await tx.query(
        `insert into milestones (milestone_id,project_id,name,description,target_at,sort_order)
         values ($1,$2,$3,$4,$5,$6)`,
        [id, projectId, milestone.name, milestone.description, milestone.target_at, index],
      );
    }

    const taskIds = new Map<string, string>();
    for (const [index, task] of draft.tasks.entries()) {
      const id = newId("task");
      taskIds.set(task.ref, id);
      const { rows: [{ task_key }] } = await tx.query<{ task_key: string }>(
        "select allocate_task_key($1) as task_key",
        [projectId],
      );
      await tx.query(
        `insert into tasks (task_id,task_key,project_id,title,description,owner_member_id,priority,scope,
                            plan_status,milestone_id,target_at,sort_order,created_in_plan_version)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'not_started',$9,$10,$11,$12)`,
        [id, task_key, projectId, task.title, task.description,
         task.owner_member_id && memberIds.has(task.owner_member_id) ? task.owner_member_id : null,
         task.priority, task.scope,
         task.milestone_ref && milestoneRefs.has(task.milestone_ref) ? milestoneIds.get(task.milestone_ref) : null,
         task.target_at, index, planVersion],
      );
    }

    const acceptedDependencies: Array<[string, string]> = [];
    const wouldCycle = (taskRef: string, dependencyRef: string) => {
      const stack = [dependencyRef];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (current === taskRef) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const [from, to] of acceptedDependencies) if (from === current) stack.push(to);
      }
      return false;
    };
    for (const task of draft.tasks) {
      const taskId = taskIds.get(task.ref)!;
      for (const dependencyRef of [...new Set(task.depends_on)]) {
        const dependencyId = taskIds.get(dependencyRef);
        if (!dependencyId || dependencyId === taskId || wouldCycle(task.ref, dependencyRef)) continue;
        await tx.query(
          `insert into task_dependencies (project_id,task_id,depends_on_task_id)
           values ($1,$2,$3) on conflict do nothing`,
          [projectId, taskId, dependencyId],
        );
        acceptedDependencies.push([task.ref, dependencyRef]);
      }
    }

    await savePlanVersion(tx, {
      projectId,
      version: planVersion,
      source: "initial",
      summary: draft.summary,
      createdBy: memberId,
    });
    await tx.query(
      `insert into timeline_items
         (item_id,project_id,occurred_at,kind,title,summary,actor,entity_type,entity_id)
       values ($1,$2,now(),'plan_change',$3,$4,$5,'plan_versions',$6)`,
      [newId("tl"), projectId, `Planning agent created Plan v${planVersion}`, draft.summary, memberId, `${projectId}:${planVersion}`],
    );
  });

  return {
    summary: draft.summary,
    milestone_count: draft.milestones.length,
    task_count: draft.tasks.length,
    generated_by: "llm",
    plan_version: planVersion,
  };
}
