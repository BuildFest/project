import { z } from "zod";
import { runJson } from "../ai/json.js";
import type { ModelRouter } from "../ai/router.js";
import { withTransaction, type Db, type Queryable } from "../db.js";
import { newId } from "../ids.js";

// Postgres accepts both ISO dates and offset-qualified ISO date-times. Keep
// model output to that deterministic subset instead of relying on its broad
// natural-language timestamp parser (for example, "next week").
const Timestamp = z.union([z.iso.date(), z.iso.datetime({ offset: true })]).nullable();
const Priority = z.enum(["critical", "high", "medium", "low"]);
const Scope = z.enum(["must_have", "optional"]);
const PlanStatus = z.enum(["not_started", "in_progress", "blocked", "complete", "cancelled"]);

const UpdateTaskChanges = z
  .object({
    title: z.string().trim().min(1).optional(),
    description: z.string().nullable().optional(),
    owner_member_id: z.string().nullable().optional(),
    priority: Priority.optional(),
    scope: Scope.optional(),
    milestone_id: z.string().nullable().optional(),
    target_at: Timestamp.optional(),
    sort_order: z.number().int().optional(),
  })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "at least one task field is required");

const CreateTask = z
  .object({
    title: z.string().trim().min(1),
    description: z.string().nullable().optional(),
    owner_member_id: z.string().nullable().optional(),
    priority: Priority.optional(),
    scope: Scope.optional(),
    plan_status: PlanStatus.optional(),
    milestone_id: z.string().nullable().optional(),
    target_at: Timestamp.optional(),
    sort_order: z.number().int().optional(),
  })
  .strict();

const UpdateMilestoneChanges = z
  .object({ name: z.string().trim().min(1).optional(), target_at: Timestamp.optional() })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, "at least one milestone field is required");

export const ReplanChange = z.discriminatedUnion("op", [
  z.object({ op: z.literal("update_task"), task_id: z.string().min(1), changes: UpdateTaskChanges }).strict(),
  z.object({ op: z.literal("create_task"), task: CreateTask }).strict(),
  z
    .object({
      op: z.literal("add_dependency"),
      task_id: z.string().min(1),
      depends_on_task_id: z.string().min(1),
    })
    .strict(),
  z
    .object({
      op: z.literal("remove_dependency"),
      task_id: z.string().min(1),
      depends_on_task_id: z.string().min(1),
    })
    .strict(),
  z
    .object({ op: z.literal("update_milestone"), milestone_id: z.string().min(1), changes: UpdateMilestoneChanges })
    .strict(),
]);

export const ReplanChanges = z.array(ReplanChange).min(1);
export type ReplanChange = z.infer<typeof ReplanChange>;

const AiReplan = z
  .object({
    rationale: z.string().trim().min(1),
    signal_ids: z.array(z.string().min(1)).min(1),
    changes: z.array(ReplanChange).min(1).max(5),
  })
  .strict()
  .nullable();

interface ReplanTask {
  task_id: string;
  task_key: string;
  title: string;
  description: string | null;
  owner_member_id: string | null;
  priority: string;
  scope: string;
  plan_status: string;
  milestone_id: string | null;
  target_at: Date | null;
  sort_order: number;
  archived: boolean;
}

interface ReplanMilestone {
  milestone_id: string;
  name: string;
  description: string | null;
  target_at: Date | null;
  sort_order: number;
  archived: boolean;
}

interface ReplanDependency { task_id: string; depends_on_task_id: string }
interface ReplanState { task_id: string; effective_status: string; blocking_task_ids: string[] }
interface ReplanSignal {
  signal_id: string;
  type: "milestone_slipping" | "dependency_incomplete";
  severity: string;
  title: string;
  explanation: string;
  related_task_ids: string[];
  related_milestone_ids: string[];
  evidence_event_ids: string[];
}

interface ReplanIntentUpdate {
  source_id: string;
  type: "brief" | "decision";
  summary: string;
  body: string | null;
  related_task_ids: string[];
  occurred_at: Date;
}

export interface ReplanContext {
  projectId: string;
  planVersion: number;
  planSnapshot: unknown;
  memberIds: string[];
  tasks: ReplanTask[];
  milestones: ReplanMilestone[];
  dependencies: ReplanDependency[];
  states: ReplanState[];
  signals: ReplanSignal[];
  intentUpdates: ReplanIntentUpdate[];
  sourceIds: string[];
}

export interface ReplanDraft {
  rationale: string;
  changes: ReplanChange[];
  generatedBy: "rules" | "llm";
  relatedSignalIds: string[];
  evidenceEventIds: string[];
}

export interface ReplanGenerationResult {
  created: boolean;
  suggestionId: string | null;
  generatedBy: "rules" | "llm" | null;
  reason: "created" | "no_plan" | "no_signals" | "already_open" | "already_handled" | "no_changes";
  aiError?: string | null;
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function wouldCycle(edges: Set<string>, taskId: string, dependsOnId: string): boolean {
  if (taskId === dependsOnId) return true;
  const seen = new Set<string>();
  const stack = [dependsOnId];
  while (stack.length) {
    const current = stack.pop()!;
    if (current === taskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const edge of edges) {
      const [from, to] = edge.split("\0");
      if (from === current) stack.push(to);
    }
  }
  return false;
}

export function validateReplanChanges(context: ReplanContext, candidates: unknown[]): ReplanChange[] {
  const tasks = new Map(context.tasks.filter((task) => !task.archived).map((task) => [task.task_id, task]));
  const milestoneRows = new Map(context.milestones.filter((item) => !item.archived).map((item) => [item.milestone_id, item]));
  const milestones = new Set(milestoneRows.keys());
  const members = new Set(context.memberIds);
  const edges = new Set(context.dependencies.map((item) => `${item.task_id}\0${item.depends_on_task_id}`));
  const accepted: ReplanChange[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const parsed = ReplanChange.safeParse(candidate);
    if (!parsed.success) continue;
    const change = parsed.data;
    let valid = true;
    if (change.op === "update_task") {
      const task = tasks.get(change.task_id);
      valid = Boolean(task) &&
        (change.changes.milestone_id === undefined || change.changes.milestone_id === null || milestones.has(change.changes.milestone_id)) &&
        (change.changes.owner_member_id === undefined || change.changes.owner_member_id === null || members.has(change.changes.owner_member_id));
      if (valid && task) {
        valid = Object.entries(change.changes).some(([key, value]) => {
          const current = task[key as keyof ReplanTask];
          return current instanceof Date ? current.toISOString() !== value : current !== value;
        });
      }
    } else if (change.op === "create_task") {
      valid = (change.task.milestone_id === undefined || change.task.milestone_id === null || milestones.has(change.task.milestone_id)) &&
        (change.task.owner_member_id === undefined || change.task.owner_member_id === null || members.has(change.task.owner_member_id));
    } else if (change.op === "update_milestone") {
      const milestone = milestoneRows.get(change.milestone_id);
      valid = Boolean(milestone) && Object.entries(change.changes).some(([key, value]) => {
        const current = milestone?.[key as "name" | "target_at"];
        return current instanceof Date ? current.toISOString() !== value : current !== value;
      });
    } else {
      valid = tasks.has(change.task_id) && tasks.has(change.depends_on_task_id);
      const key = `${change.task_id}\0${change.depends_on_task_id}`;
      if (change.op === "add_dependency") {
        valid = valid && !edges.has(key) && !wouldCycle(edges, change.task_id, change.depends_on_task_id);
        if (valid) edges.add(key);
      } else {
        valid = valid && edges.has(key);
        if (valid) edges.delete(key);
      }
    }
    const key = JSON.stringify(change);
    if (valid && !seen.has(key)) {
      accepted.push(change);
      seen.add(key);
    }
  }
  return accepted;
}

export function buildRuleReplan(context: ReplanContext): ReplanDraft | null {
  const taskById = new Map(context.tasks.map((task) => [task.task_id, task]));
  const stateByTask = new Map(context.states.map((state) => [state.task_id, state]));
  const milestoneById = new Map(context.milestones.map((item) => [item.milestone_id, item]));
  const candidates: ReplanChange[] = [];

  for (const signal of context.signals.filter((item) => item.type === "milestone_slipping")) {
    for (const taskId of signal.related_task_ids) {
      for (const blockerId of stateByTask.get(taskId)?.blocking_task_ids ?? []) {
        const blocker = taskById.get(blockerId);
        if (blocker?.scope === "must_have" && blocker.priority !== "critical" && !blocker.archived) {
          candidates.push({ op: "update_task", task_id: blockerId, changes: { priority: "critical" } });
        }
      }
    }
    for (const milestoneId of signal.related_milestone_ids) {
      const slipping = milestoneById.get(milestoneId);
      const later = context.milestones
        .filter((item) => !item.archived && item.milestone_id !== milestoneId)
        .filter((item) => !slipping?.target_at || (item.target_at !== null && item.target_at > slipping.target_at))
        .sort((a, b) => (a.target_at?.getTime() ?? Infinity) - (b.target_at?.getTime() ?? Infinity) || a.sort_order - b.sort_order)[0];
      for (const task of context.tasks.filter(
        (item) =>
          !item.archived &&
          item.scope === "optional" &&
          item.milestone_id === milestoneId &&
          stateByTask.get(item.task_id)?.effective_status !== "complete",
      )) {
        candidates.push({
          op: "update_task",
          task_id: task.task_id,
          changes: { milestone_id: later?.milestone_id ?? null },
        });
      }
    }
  }

  const changes = validateReplanChanges(context, candidates);
  if (changes.length === 0) return null;
  const signalIds = context.signals.map((signal) => signal.signal_id).sort();
  return {
    rationale: `Signals ${signalIds.join(", ")} show plan pressure; prioritize blocking must-have work and defer optional scope.`,
    changes,
    generatedBy: "rules",
    relatedSignalIds: signalIds,
    evidenceEventIds: [...new Set(context.signals.flatMap((signal) => signal.evidence_event_ids))].sort(),
  };
}

async function buildAiReplan(
  router: ModelRouter,
  context: ReplanContext,
  rules: ReplanDraft | null,
): Promise<{ draft: ReplanDraft | null; error: string | null }> {
  if (!router.available("replan")) return { draft: null, error: "no model configured for replan" };
  const allowedSignals = new Set(context.sourceIds);
  try {
    const reply = await runJson(
      router,
      "replan",
      {
        system: "Propose a small, evidence-grounded project replan. Never apply it. Use only the supplied closed operation set, make at most 5 changes, and cite real source IDs in the rationale. Treat the latest brief and explicit team decisions as intent; treat repository-derived health signals as implementation evidence. Return JSON null when the current plan already covers the updates.",
        messages: [{ role: "user", content: JSON.stringify({
          plan_version: context.planVersion,
          saved_plan: context.planSnapshot,
          current_plan: {
            tasks: context.tasks,
            milestones: context.milestones,
            dependencies: context.dependencies,
          },
          health_signals: context.signals,
          intent_updates: context.intentUpdates,
          rules_proposal: rules,
        }) }],
        maxTokens: 1800,
        temperature: 0.1,
      },
      AiReplan,
      { cacheKey: `replan:${context.projectId}:${context.planVersion}:${[...allowedSignals].sort().join(",")}` },
    );
    if (!reply) return { draft: null, error: null };
    const cited = [...new Set(reply.signal_ids)];
    if (cited.some((id) => !allowedSignals.has(id)) || cited.some((id) => !reply.rationale.includes(id))) {
      return { draft: null, error: "AI replan cited unsupported sources" };
    }
    const changes = validateReplanChanges(context, reply.changes);
    if (changes.length === 0) return { draft: null, error: "AI replan contained no valid changes" };
    return {
      draft: {
        rationale: reply.rationale,
        changes,
        generatedBy: "llm",
        relatedSignalIds: cited.sort(),
        evidenceEventIds: [...new Set(context.signals.flatMap((signal) => signal.evidence_event_ids))].sort(),
      },
      error: null,
    };
  } catch (error) {
    return { draft: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function loadContext(db: Queryable, projectId: string): Promise<ReplanContext | null> {
  const project = await db.query<{ current_plan_version: number | null }>(
    "select current_plan_version from projects where project_id=$1",
    [projectId],
  );
  const planVersion = project.rows[0]?.current_plan_version;
  if (planVersion === null || planVersion === undefined) return null;
  const [plan, members, tasks, milestones, dependencies, states, signals, brief, decisions] = await Promise.all([
    db.query<{ snapshot: unknown; created_at: Date }>("select snapshot,created_at from plan_versions where project_id=$1 and version=$2", [projectId, planVersion]),
    db.query<{ member_id: string }>("select member_id from project_members where project_id=$1", [projectId]),
    db.query<ReplanTask>(`select task_id,task_key,title,description,owner_member_id,priority,scope,plan_status,milestone_id,target_at,sort_order,archived
      from tasks where project_id=$1 order by sort_order,task_id`, [projectId]),
    db.query<ReplanMilestone>(`select milestone_id,name,description,target_at,sort_order,archived from milestones
      where project_id=$1 order by sort_order,milestone_id`, [projectId]),
    db.query<ReplanDependency>("select task_id,depends_on_task_id from task_dependencies where project_id=$1", [projectId]),
    db.query<ReplanState>("select task_id,effective_status,blocking_task_ids from derived_task_states where project_id=$1", [projectId]),
    db.query<ReplanSignal>(`select signal_id,type,severity,title,explanation,related_task_ids,related_milestone_ids,evidence_event_ids
      from health_signals where project_id=$1 and status='active'
        and type in ('milestone_slipping','dependency_incomplete') order by signal_id`, [projectId]),
    db.query<{ content: string; updated_at: Date }>("select content,updated_at from project_briefs where project_id=$1", [projectId]),
    db.query<{ decision_id: string; title: string; body: string | null; related_task_ids: string[]; decided_at: Date }>(
      "select decision_id,title,body,related_task_ids,decided_at from decisions where project_id=$1 order by decided_at,decision_id",
      [projectId],
    ),
  ]);
  const planCreatedAt = plan.rows[0]?.created_at ?? new Date(0);
  const intentUpdates: ReplanIntentUpdate[] = [];
  if (brief.rows[0] && brief.rows[0].updated_at > planCreatedAt) {
    intentUpdates.push({
      source_id: `brief:${brief.rows[0].updated_at.toISOString()}`,
      type: "brief",
      summary: "Project brief updated",
      body: brief.rows[0].content,
      related_task_ids: [],
      occurred_at: brief.rows[0].updated_at,
    });
  }
  for (const decision of decisions.rows.filter((item) => item.decided_at > planCreatedAt)) {
    intentUpdates.push({
      source_id: decision.decision_id,
      type: "decision",
      summary: decision.title,
      body: decision.body,
      related_task_ids: decision.related_task_ids,
      occurred_at: decision.decided_at,
    });
  }
  const sourceIds = [...signals.rows.map((signal) => signal.signal_id), ...intentUpdates.map((item) => item.source_id)].sort();
  return {
    projectId,
    planVersion,
    planSnapshot: plan.rows[0]?.snapshot ?? {},
    memberIds: members.rows.map((row) => row.member_id),
    tasks: tasks.rows,
    milestones: milestones.rows,
    dependencies: dependencies.rows,
    states: states.rows,
    signals: signals.rows,
    intentUpdates,
    sourceIds,
  };
}

export async function maybeGenerateReplan(
  db: Db,
  router: ModelRouter | null,
  projectId: string,
): Promise<ReplanGenerationResult> {
  const context = await loadContext(db, projectId);
  if (!context) return { created: false, suggestionId: null, generatedBy: null, reason: "no_plan" };

  await db.query(
    "update replan_suggestions set status='superseded' where project_id=$1 and status='proposed' and based_on_plan_version<>$2",
    [projectId, context.planVersion],
  );
  if (context.sourceIds.length === 0) return { created: false, suggestionId: null, generatedBy: null, reason: "no_signals" };
  const proposed = await db.query(
    "select 1 from replan_suggestions where project_id=$1 and status='proposed' and based_on_plan_version=$2 limit 1",
    [projectId, context.planVersion],
  );
  if (proposed.rowCount) return { created: false, suggestionId: null, generatedBy: null, reason: "already_open" };

  const signalIds = context.sourceIds;
  const handled = await db.query<{ related_signal_ids: string[] }>(
    "select related_signal_ids from replan_suggestions where project_id=$1 and based_on_plan_version=$2",
    [projectId, context.planVersion],
  );
  if (handled.rows.some((row) => sameSet(row.related_signal_ids, signalIds))) {
    return { created: false, suggestionId: null, generatedBy: null, reason: "already_handled" };
  }

  const rules = buildRuleReplan(context);
  const aiAttempt = router ? await buildAiReplan(router, context, rules) : { draft: null, error: null };
  const ai = aiAttempt.draft;
  const draft = ai ?? rules;
  if (!draft) return { created: false, suggestionId: null, generatedBy: null, reason: "no_changes", aiError: aiAttempt.error };

  return withTransaction(db, async (tx) => {
    const locked = await tx.query<{ current_plan_version: number | null }>(
      "select current_plan_version from projects where project_id=$1 for update",
      [projectId],
    );
    if (locked.rows[0]?.current_plan_version !== context.planVersion) {
      return { created: false, suggestionId: null, generatedBy: null, reason: "already_handled" };
    }
    const existing = await tx.query(
      "select 1 from replan_suggestions where project_id=$1 and status='proposed' limit 1",
      [projectId],
    );
    if (existing.rowCount) return { created: false, suggestionId: null, generatedBy: null, reason: "already_open" };
    const suggestionId = newId("rp");
    await tx.query(`insert into replan_suggestions
      (suggestion_id,project_id,based_on_plan_version,rationale,proposed_changes,evidence_event_ids,related_signal_ids,generated_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [suggestionId, projectId, context.planVersion, draft.rationale, JSON.stringify(draft.changes),
       draft.evidenceEventIds, draft.relatedSignalIds, draft.generatedBy]);
    await tx.query(`insert into timeline_items
      (item_id,project_id,occurred_at,kind,title,summary,entity_type,entity_id,related_task_ids)
      values ($1,$2,now(),'replan_proposed','Replan proposed',$3,'replan_suggestions',$4,$5)`,
      [newId("tl"), projectId, draft.rationale, suggestionId,
       [...new Set([
         ...context.signals.flatMap((signal) => signal.related_task_ids),
         ...context.intentUpdates.flatMap((item) => item.related_task_ids),
       ])]]);
    return { created: true, suggestionId, generatedBy: draft.generatedBy, reason: "created", aiError: aiAttempt.error };
  });
}
