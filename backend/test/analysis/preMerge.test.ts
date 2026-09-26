import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CompletionResult } from "../../src/ai/client.js";
import type { ModelRouter } from "../../src/ai/router.js";
import { generatePreMergeNote, coordinationFacts } from "../../src/analysis/preMerge.js";
import type { AnalysisResult } from "../../src/analysis/pipeline.js";
import type { ProjectSnapshot } from "../../src/analysis/load.js";
import { runAnalysis } from "../../src/analysis/runner.js";
import type { CoordinationFact } from "../../src/analysis/preMerge.js";
import { createApp } from "../../src/api/app.js";
import { event, task, T0 } from "./fixtures.js";
import { startTestDb } from "../db.js";

const prEvent = event({
  event_id: "pr_event",
  event_type: "pull_request_opened",
  branch: "pc-2-ui",
  changed_files: ["src/shared.ts"],
  pull_request: { number: 12, title: "PC-2 dashboard", head_branch: "pc-2-ui" },
});

function routerFor(answers: Partial<Record<string, unknown>>): ModelRouter {
  return {
    available: () => true,
    async run(job): Promise<CompletionResult> {
      return { text: JSON.stringify(answers[job]), provider: "anthropic", model: "smart", inputTokens: 2, outputTokens: 3 };
    },
  };
}

describe("pre-merge note rules and guardrails", () => {
  const facts: CoordinationFact[] = [{
    id: "dependency:task_ui:task_api",
    kind: "incomplete_dependency",
    summary: "PC-2 depends on PC-1, which is in_progress",
    evidence_event_ids: ["pr_event"],
  }];

  it("collects collision, dependency, scope, and plan-signal facts", () => {
    const api = task({ task_id: "task_api", task_key: "PC-1", title: "API" });
    const ui = task({ task_id: "task_ui", task_key: "PC-2", title: "UI", priority: "high" });
    const snapshot = {
      tasks: [api, ui],
      dependencies: [{ task_id: "task_ui", depends_on_task_id: "task_api" }],
      links: [{ event_id: "pr_event", task_id: "task_ui", method: "task_key", confidence: 1, status: "confirmed", is_primary: true }],
    } as ProjectSnapshot;
    const result = {
      branches: [],
      states: [
        { task_id: "task_api", effective_status: "in_progress", evidence_event_ids: ["api_event"] },
        { task_id: "task_ui", effective_status: "in_progress", evidence_event_ids: ["pr_event"] },
      ],
      collisions: [{ repository_id: "repo_1", branch_a: "other", branch_b: "pc-2-ui", task_a_id: "task_api", task_b_id: "task_ui", overlapping_files: ["src/shared.ts"] }],
      signals: [{ fingerprint: "plan:ui", title: "Plan differs", explanation: "PC-2 has started", related_task_ids: ["task_ui"], evidence_event_ids: ["pr_event"] }],
    } as AnalysisResult;
    const collected = coordinationFacts(snapshot, result, prEvent);
    expect(collected.taskId).toBe("task_ui");
    expect(collected.facts.map((fact) => fact.kind)).toEqual([
      "collision_risk", "incomplete_dependency", "scope", "plan_signal",
    ]);
    expect(collected.facts[0].summary).toContain("src/shared.ts");
  });

  it("produces a useful deterministic fallback without API keys", async () => {
    const generated = await generatePreMergeNote(null, prEvent, facts);
    expect(generated.generatedBy).toBe("rules");
    expect(generated.note).toContain("Before merging PR #12");
    expect(generated.note).toContain("depends on PC-1");
  });

  it("uses fast scope context and a smart grounded coordination note", async () => {
    const generated = await generatePreMergeNote(routerFor({
      diff_summary: { summary: "Updates dashboard coordination files" },
      pre_merge_review: { summary: "Wait for PC-1 before merging.", cited_fact_ids: [facts[0].id] },
    }), prEvent, facts);
    expect(generated).toEqual({
      generatedBy: "llm",
      note: `Wait for PC-1 before merging. Evidence: [${facts[0].id}]`,
    });
  });

  it("rejects invented citations and code-quality review language", async () => {
    const invented = await generatePreMergeNote(routerFor({
      diff_summary: { summary: "scope" },
      pre_merge_review: { summary: "Looks ready.", cited_fact_ids: ["invented"] },
    }), prEvent, facts);
    expect(invented.generatedBy).toBe("rules");

    const codeReview = await generatePreMergeNote(routerFor({
      diff_summary: { summary: "scope" },
      pre_merge_review: { summary: "Refactor this function before merging.", cited_fact_ids: [facts[0].id] },
    }), prEvent, facts);
    expect(codeReview.generatedBy).toBe("rules");
    expect(codeReview.note).not.toMatch(/refactor|function/i);
  });
});

describe("pre-merge note persistence and API", () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let pool: pg.Pool;
  beforeAll(async () => { db = await startTestDb(); pool = db.pool; }, 120_000);
  afterAll(async () => { await db?.stop(); });

  it("persists one dashboard-readable note per event across repeated analysis", async () => {
    await pool.query("insert into projects (project_id,name,task_key_prefix,created_by) values ('proj_note','P','PC','test')");
    await pool.query(`insert into repositories (repository_id,project_id,owner,name,full_name)
      values ('repo_note','proj_note','o','r','o/r')`);
    await pool.query(`insert into tasks (task_id,task_key,project_id,title,scope,priority,plan_status)
      values ('task_note','PC-1','proj_note','UI','must_have','high','in_progress')`);
    await pool.query(`insert into github_events
      (event_id,project_id,repository_id,source,external_event_id,event_type,occurred_at,branch,pull_request,changed_files)
      values ('evt_note','proj_note','repo_note','backfill','pr:1:opened:x','pull_request_opened',$1,'pc-1-ui',$2,'{src/ui.ts}')`,
      [T0, JSON.stringify({ number: 1, title: "PC-1 UI", state: "open", head_branch: "pc-1-ui", base_branch: "main", url: "", merged: false })]);
    await pool.query(`insert into branch_states
      (repository_id,branch,project_id,status,task_id,open_pr_number,last_activity_at)
      values ('repo_note','pc-1-ui','proj_note','active','task_note',1,$1)`, [T0]);

    const first = await runAnalysis(pool, null, "proj_note", T0);
    const second = await runAnalysis(pool, null, "proj_note", T0);
    expect(first.notes).toBe(1);
    expect(second.notes).toBe(0);
    const stored = await pool.query("select * from maintainer_notes where project_id='proj_note'");
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({ source_event_id: "evt_note", pull_request_number: 1, generated_by: "rules" });
    expect(stored.rows[0].note).toContain("Before merging PR #1");

    const response = await createApp(pool).request("/projects/proj_note/maintainer-notes?limit=1");
    expect(response.status).toBe(200);
    const body = await response.json() as any[];
    expect(body).toHaveLength(1);
    expect(body[0].source_event_id).toBe("evt_note");
  });
});
