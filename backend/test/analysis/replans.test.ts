import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ModelRouter } from "../../src/ai/router.js";
import {
  ReplanChange,
  buildRuleReplan,
  maybeGenerateReplan,
  validateReplanChanges,
  type ReplanContext,
} from "../../src/analysis/replans.js";
import { runAnalysis } from "../../src/analysis/runner.js";
import { startTestDb } from "../db.js";

function context(overrides: Partial<ReplanContext> = {}): ReplanContext {
  return {
    projectId: "project_1",
    planVersion: 1,
    planSnapshot: {},
    memberIds: ["member_1"],
    tasks: [
      { task_id: "blocker", task_key: "PC-1", title: "API", description: null, owner_member_id: null, priority: "high", scope: "must_have", plan_status: "in_progress", milestone_id: "m1", target_at: null, sort_order: 1, archived: false },
      { task_id: "work", task_key: "PC-2", title: "UI", description: null, owner_member_id: null, priority: "medium", scope: "must_have", plan_status: "in_progress", milestone_id: "m1", target_at: null, sort_order: 2, archived: false },
      { task_id: "optional", task_key: "PC-3", title: "Polish", description: null, owner_member_id: null, priority: "low", scope: "optional", plan_status: "not_started", milestone_id: "m1", target_at: null, sort_order: 3, archived: false },
    ],
    milestones: [
      { milestone_id: "m1", name: "Demo", description: null, target_at: new Date("2026-09-26T12:00:00Z"), sort_order: 1, archived: false },
      { milestone_id: "m2", name: "Later", description: null, target_at: new Date("2026-09-27T12:00:00Z"), sort_order: 2, archived: false },
    ],
    dependencies: [{ task_id: "work", depends_on_task_id: "blocker" }],
    states: [
      { task_id: "blocker", effective_status: "in_progress", blocking_task_ids: [] },
      { task_id: "work", effective_status: "possibly_blocked", blocking_task_ids: ["blocker"] },
      { task_id: "optional", effective_status: "not_started", blocking_task_ids: [] },
    ],
    signals: [{
      signal_id: "sig_slip",
      type: "milestone_slipping",
      severity: "critical",
      title: "Demo is overdue",
      explanation: "Demo has incomplete must-have tasks PC-1 and PC-2",
      related_task_ids: ["blocker", "work"],
      related_milestone_ids: ["m1"],
      evidence_event_ids: ["event_1"],
    }],
    intentUpdates: [],
    sourceIds: ["sig_slip"],
    ...overrides,
  };
}

describe("replan validation and rules", () => {
  it("accepts only the closed operation schema and never permits plan_status updates", () => {
    expect(ReplanChange.safeParse({ op: "update_task", task_id: "work", changes: { priority: "critical" } }).success).toBe(true);
    expect(ReplanChange.safeParse({ op: "delete_task", task_id: "work" }).success).toBe(false);
    expect(ReplanChange.safeParse({ op: "update_task", task_id: "work", changes: { plan_status: "complete" } }).success).toBe(false);
    expect(ReplanChange.safeParse({ op: "update_task", task_id: "work", changes: {} }).success).toBe(false);
  });

  it("accepts ISO timestamps and rejects natural-language dates", () => {
    expect(ReplanChange.safeParse({
      op: "update_task",
      task_id: "work",
      changes: { target_at: "2026-10-01" },
    }).success).toBe(true);
    expect(ReplanChange.safeParse({
      op: "update_milestone",
      milestone_id: "m1",
      changes: { target_at: "2026-10-01T14:30:00-05:00" },
    }).success).toBe(true);
    expect(ReplanChange.safeParse({
      op: "update_task",
      task_id: "work",
      changes: { target_at: "next week" },
    }).success).toBe(false);
  });

  it("drops missing IDs, no-ops, duplicates and dependency cycles", () => {
    const changes = validateReplanChanges(context(), [
      { op: "update_task", task_id: "missing", changes: { priority: "critical" } },
      { op: "update_task", task_id: "blocker", changes: { priority: "high" } },
      { op: "update_task", task_id: "blocker", changes: { owner_member_id: "missing" } },
      { op: "update_task", task_id: "blocker", changes: { priority: "critical" } },
      { op: "update_task", task_id: "blocker", changes: { priority: "critical" } },
      { op: "add_dependency", task_id: "blocker", depends_on_task_id: "work" },
      { op: "remove_dependency", task_id: "blocker", depends_on_task_id: "optional" },
    ]);
    expect(changes).toEqual([{ op: "update_task", task_id: "blocker", changes: { priority: "critical" } }]);
  });

  it("prioritizes must-have blockers and moves optional scope to the next milestone", () => {
    expect(buildRuleReplan(context())).toMatchObject({
      generatedBy: "rules",
      relatedSignalIds: ["sig_slip"],
      evidenceEventIds: ["event_1"],
      changes: [
        { op: "update_task", task_id: "blocker", changes: { priority: "critical" } },
        { op: "update_task", task_id: "optional", changes: { milestone_id: "m2" } },
      ],
    });
    expect(buildRuleReplan(context())?.rationale).toContain("sig_slip");
  });

  it("clears optional milestone assignment when no later milestone exists", () => {
    const draft = buildRuleReplan(context({ milestones: context().milestones.slice(0, 1) }));
    expect(draft?.changes).toContainEqual({ op: "update_task", task_id: "optional", changes: { milestone_id: null } });
  });

  it("does not defer optional tasks that are effectively complete", () => {
    const completed = context();
    completed.states = completed.states.map((item) =>
      item.task_id === "optional" ? { ...item, effective_status: "complete" } : item,
    );
    const draft = buildRuleReplan(completed);
    expect(draft?.changes).not.toContainEqual(
      expect.objectContaining({ op: "update_task", task_id: "optional" }),
    );
    expect(draft?.changes).toEqual([
      { op: "update_task", task_id: "blocker", changes: { priority: "critical" } },
    ]);
  });
});

let db: Awaited<ReturnType<typeof startTestDb>>;
let pool: pg.Pool;
let sequence = 0;

beforeAll(async () => {
  db = await startTestDb();
  pool = db.pool;
}, 120_000);

afterAll(async () => {
  await db?.stop();
});

async function seedProject(kind: "slipping" | "dependency" = "slipping") {
  const suffix = ++sequence;
  const projectId = `replan_project_${suffix}`;
  const m1 = `m1_${suffix}`;
  const m2 = `m2_${suffix}`;
  const blocker = `blocker_${suffix}`;
  const work = `work_${suffix}`;
  const optional = `optional_${suffix}`;
  const signalId = `signal_${suffix}`;
  const evidenceEventId = `event_${suffix}`;
  await pool.query(
    "insert into projects (project_id,name,task_key_prefix,created_by) values ($1,'Replan','RP','test')",
    [projectId],
  );
  await pool.query(
    `insert into milestones (milestone_id,project_id,name,target_at,sort_order) values
      ($1,$3,'Demo','2026-09-26T12:00:00Z',1),($2,$3,'Later','2026-09-27T12:00:00Z',2)`,
    [m1, m2, projectId],
  );
  await pool.query(
    `insert into tasks (task_id,task_key,project_id,title,priority,scope,plan_status,milestone_id,sort_order) values
      ($1,'RP-1',$4,'API','high','must_have','in_progress',$5,1),
      ($2,'RP-2',$4,'UI','medium','must_have','in_progress',$5,2),
      ($3,'RP-3',$4,'Polish','low','optional','not_started',$5,3)`,
    [blocker, work, optional, projectId, m1],
  );
  await pool.query("insert into task_dependencies (project_id,task_id,depends_on_task_id) values ($1,$2,$3)", [projectId, work, blocker]);
  await pool.query(
    `insert into derived_task_states (task_id,project_id,computed_status,blocking_task_ids) values
      ($1,$4,'in_progress','{}'),($2,$4,'possibly_blocked',$5),($3,$4,'not_started','{}')`,
    [blocker, work, optional, projectId, [blocker]],
  );
  await pool.query("insert into plan_versions (project_id,version,source,snapshot) values ($1,1,'initial',$2)", [projectId, { tasks: [blocker, work, optional] }]);
  await pool.query("update projects set current_plan_version=1 where project_id=$1", [projectId]);
  await pool.query(
    `insert into health_signals
      (signal_id,project_id,type,severity,title,explanation,related_task_ids,related_milestone_ids,evidence_event_ids,fingerprint)
      values ($1,$2,$3,'warning','Pressure','Signal evidence',$4,$5,$6,$7)`,
    [signalId, projectId, kind === "slipping" ? "milestone_slipping" : "dependency_incomplete",
     [work], kind === "slipping" ? [m1] : [], [evidenceEventId], `${kind}:${suffix}`],
  );
  return { projectId, m1, m2, blocker, work, optional, signalId, evidenceEventId };
}

function router(reply: unknown): ModelRouter {
  return {
    available: () => true,
    run: async () => ({
      text: JSON.stringify(reply),
      provider: "anthropic",
      model: "test",
      inputTokens: 1,
      outputTokens: 1,
    }),
  };
}

describe("maybeGenerateReplan", () => {
  it("saves one rules proposal and timeline row without applying plan changes", async () => {
    const seeded = await seedProject();
    const first = await maybeGenerateReplan(pool, null, seeded.projectId);
    expect(first).toMatchObject({ created: true, generatedBy: "rules", reason: "created" });
    expect((await maybeGenerateReplan(pool, null, seeded.projectId)).reason).toBe("already_open");

    const suggestions = await pool.query("select * from replan_suggestions where project_id=$1", [seeded.projectId]);
    expect(suggestions.rows).toHaveLength(1);
    expect(suggestions.rows[0]).toMatchObject({
      status: "proposed",
      based_on_plan_version: 1,
      generated_by: "rules",
      related_signal_ids: [seeded.signalId],
      evidence_event_ids: [seeded.evidenceEventId],
    });
    expect(suggestions.rows[0].rationale).toContain(seeded.signalId);
    expect(suggestions.rows[0].proposed_changes).toEqual([
      { op: "update_task", task_id: seeded.blocker, changes: { priority: "critical" } },
      { op: "update_task", task_id: seeded.optional, changes: { milestone_id: seeded.m2 } },
    ]);
    expect((await pool.query("select priority from tasks where task_id=$1", [seeded.blocker])).rows[0].priority).toBe("high");
    expect((await pool.query("select kind from timeline_items where entity_id=$1", [first.suggestionId])).rows[0].kind).toBe("replan_proposed");
  });

  it("does not recreate a handled signal set on the same plan version", async () => {
    const seeded = await seedProject();
    const first = await maybeGenerateReplan(pool, null, seeded.projectId);
    await pool.query(
      "update replan_suggestions set status='rejected',reviewed_by='test',reviewed_at=now() where suggestion_id=$1",
      [first.suggestionId],
    );
    expect((await maybeGenerateReplan(pool, null, seeded.projectId)).reason).toBe("already_handled");
    expect((await pool.query("select count(*)::int count from replan_suggestions where project_id=$1", [seeded.projectId])).rows[0].count).toBe(1);
  });

  it("supersedes a stale proposal and generates against the new plan version", async () => {
    const seeded = await seedProject();
    const first = await maybeGenerateReplan(pool, null, seeded.projectId);
    await pool.query("insert into plan_versions (project_id,version,source,snapshot) values ($1,2,'manual','{}')", [seeded.projectId]);
    await pool.query("update projects set current_plan_version=2 where project_id=$1", [seeded.projectId]);
    const second = await maybeGenerateReplan(pool, null, seeded.projectId);
    expect(second).toMatchObject({ created: true, generatedBy: "rules" });
    const statuses = await pool.query("select suggestion_id,status,based_on_plan_version from replan_suggestions where project_id=$1 order by based_on_plan_version", [seeded.projectId]);
    expect(statuses.rows).toEqual([
      { suggestion_id: first.suggestionId, status: "superseded", based_on_plan_version: 1 },
      { suggestion_id: second.suggestionId, status: "proposed", based_on_plan_version: 2 },
    ]);
  });

  it("uses a grounded smart-tier proposal and drops invalid operations", async () => {
    const seeded = await seedProject("dependency");
    const result = await maybeGenerateReplan(pool, router({
      rationale: `${seeded.signalId} shows the blocked API should be prioritized`,
      signal_ids: [seeded.signalId],
      changes: [
        { op: "update_task", task_id: "missing", changes: { priority: "critical" } },
        { op: "update_task", task_id: seeded.blocker, changes: { priority: "critical" } },
      ],
    }), seeded.projectId);
    expect(result).toMatchObject({ created: true, generatedBy: "llm" });
    const row = (await pool.query("select proposed_changes,generated_by from replan_suggestions where suggestion_id=$1", [result.suggestionId])).rows[0];
    expect(row).toEqual({
      proposed_changes: [{ op: "update_task", task_id: seeded.blocker, changes: { priority: "critical" } }],
      generated_by: "llm",
    });
  });

  it("falls back to rules when AI rationale is not grounded", async () => {
    const seeded = await seedProject();
    const result = await maybeGenerateReplan(pool, router({
      rationale: "This does not cite the signal",
      signal_ids: [seeded.signalId],
      changes: [{ op: "update_task", task_id: seeded.blocker, changes: { priority: "critical" } }],
    }), seeded.projectId);
    expect(result).toMatchObject({ created: true, generatedBy: "rules" });
  });

  it("uses a brief update made after the saved plan as replanning evidence", async () => {
    const seeded = await seedProject("dependency");
    const { rows: [brief] } = await pool.query<{ updated_at: Date }>(
      `insert into project_briefs (project_id,content,updated_at)
       values ($1,'The API must support offline mode.',now() + interval '1 second') returning updated_at`,
      [seeded.projectId],
    );
    const sourceId = `brief:${brief.updated_at.toISOString()}`;
    const result = await maybeGenerateReplan(pool, router({
      rationale: `${sourceId} adds offline mode to the required scope`,
      signal_ids: [sourceId],
      changes: [{ op: "update_task", task_id: seeded.blocker, changes: { title: "Offline-capable API" } }],
    }), seeded.projectId);

    expect(result).toMatchObject({ created: true, generatedBy: "llm" });
    const suggestion = (await pool.query(
      "select related_signal_ids,proposed_changes from replan_suggestions where suggestion_id=$1",
      [result.suggestionId],
    )).rows[0];
    expect(suggestion.related_signal_ids).toEqual([sourceId]);
    expect(suggestion.proposed_changes).toEqual([
      { op: "update_task", task_id: seeded.blocker, changes: { title: "Offline-capable API" } },
    ]);
  });

  it("runs after analysis persistence and exposes the generation result", async () => {
    const seeded = await seedProject();
    const result = await runAnalysis(pool, null, seeded.projectId, new Date("2026-09-26T14:00:00Z"));
    expect(result.replan).toMatchObject({ created: true, generatedBy: "rules", reason: "created" });
    expect(result.replanError).toBeNull();
    expect((await pool.query(
      "select count(*)::int count from replan_suggestions where project_id=$1 and status='proposed'",
      [seeded.projectId],
    )).rows[0].count).toBe(1);
  });

  it("skips projects without a saved plan or actionable fallback", async () => {
    const noPlan = `no_plan_${++sequence}`;
    await pool.query("insert into projects (project_id,name,task_key_prefix,created_by) values ($1,'No plan','NP','test')", [noPlan]);
    expect((await maybeGenerateReplan(pool, null, noPlan)).reason).toBe("no_plan");

    const seeded = await seedProject("dependency");
    expect((await maybeGenerateReplan(pool, null, seeded.projectId)).reason).toBe("no_changes");
  });
});
