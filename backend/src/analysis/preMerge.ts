import { z } from "zod";
import type { CompletionRequest, CompletionResult } from "../ai/client.js";
import { runJson } from "../ai/json.js";
import type { ModelRouter, RunOptions } from "../ai/router.js";
import type { Db } from "../db.js";
import { newId } from "../ids.js";
import type { AnalysisResult } from "./pipeline.js";
import type { ProjectSnapshot } from "./load.js";
import type { GithubEvent } from "./types.js";

export interface CoordinationFact {
  id: string;
  kind: "collision_risk" | "incomplete_dependency" | "scope" | "plan_signal";
  summary: string;
  evidence_event_ids: string[];
}

export interface PreMergeNote {
  source_event_id: string;
  repository_id: string;
  pull_request_number: number;
  branch: string;
  task_id: string | null;
  note: string;
  facts: CoordinationFact[];
  evidence_event_ids: string[];
  generated_by: "rules" | "llm";
}

interface CapturedRun {
  job: "diff_summary" | "pre_merge_review";
  provider: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  error: string | null;
}

const DiffReply = z.object({ summary: z.string().trim().min(1).max(300) });
const NoteReply = z.object({
  summary: z.string().trim().min(1).max(600),
  cited_fact_ids: z.array(z.string().min(1)).max(20),
});

const CODE_REVIEW_LANGUAGE = /\b(refactor|code quality|cleaner|bug|test coverage|naming|performance|security vulnerability|function|class)\b/i;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function taskForEvent(snapshot: ProjectSnapshot, result: AnalysisResult, event: GithubEvent): string | null {
  const linked = snapshot.links.find((link) => link.event_id === event.event_id && link.status !== "rejected");
  if (linked) return linked.task_id;
  return result.branches.find(
    (branch) => branch.repository_id === event.repository_id && branch.branch === event.branch,
  )?.task_id ?? null;
}

export function coordinationFacts(
  snapshot: ProjectSnapshot,
  result: AnalysisResult,
  event: GithubEvent,
): { taskId: string | null; facts: CoordinationFact[] } {
  const taskId = taskForEvent(snapshot, result, event);
  const task = snapshot.tasks.find((candidate) => candidate.task_id === taskId);
  const stateByTask = new Map(result.states.map((state) => [state.task_id, state]));
  const facts: CoordinationFact[] = [];

  for (const collision of result.collisions) {
    if (collision.repository_id !== event.repository_id || !event.branch ||
        (collision.branch_a !== event.branch && collision.branch_b !== event.branch)) continue;
    const other = collision.branch_a === event.branch ? collision.branch_b : collision.branch_a;
    facts.push({
      id: `collision:${event.repository_id}:${collision.branch_a}:${collision.branch_b}`,
      kind: "collision_risk",
      summary: `Collision risk with ${other} in ${collision.overlapping_files.join(", ")}`,
      evidence_event_ids: [event.event_id],
    });
  }

  if (task) {
    for (const dependency of snapshot.dependencies.filter((item) => item.task_id === task.task_id)) {
      const dependencyTask = snapshot.tasks.find((item) => item.task_id === dependency.depends_on_task_id);
      const status = stateByTask.get(dependency.depends_on_task_id)?.effective_status ?? "not_started";
      if (!dependencyTask || status === "complete") continue;
      facts.push({
        id: `dependency:${task.task_id}:${dependencyTask.task_id}`,
        kind: "incomplete_dependency",
        summary: `${task.task_key} depends on ${dependencyTask.task_key}, which is ${status}`,
        evidence_event_ids: unique([event.event_id, ...(stateByTask.get(dependencyTask.task_id)?.evidence_event_ids ?? [])]),
      });
    }
    facts.push({
      id: `scope:${task.task_id}`,
      kind: "scope",
      summary: `${task.task_key} is ${task.scope.replace("_", " ")}, ${task.priority} priority, and ${task.plan_status} in the plan`,
      evidence_event_ids: [event.event_id],
    });
    for (const signal of result.signals.filter((item) => item.related_task_ids.includes(task.task_id))) {
      facts.push({
        id: `signal:${signal.fingerprint}`,
        kind: "plan_signal",
        summary: `${signal.title}: ${signal.explanation}`,
        evidence_event_ids: unique([event.event_id, ...signal.evidence_event_ids]),
      });
    }
  }
  return { taskId, facts };
}

function rulesNote(event: GithubEvent, facts: CoordinationFact[]): string {
  const number = event.pull_request!.number;
  const risks = facts.filter((fact) => fact.kind !== "scope");
  if (risks.length === 0) return `Before merging PR #${number}: no dependency, collision, or plan-alignment risks are currently detected.`;
  return `Before merging PR #${number}: ${risks.map((fact) => fact.summary).join("; ")}.`;
}

function captureRouter(router: ModelRouter, runs: CapturedRun[]): ModelRouter {
  return {
    available: (job) => router.available(job),
    async run(job, request: CompletionRequest, options?: RunOptions): Promise<CompletionResult> {
      const started = Date.now();
      try {
        const result = await router.run(job, request, options);
        if (job === "diff_summary" || job === "pre_merge_review") {
          runs.push({ job, provider: result.provider, model: result.model, inputTokens: result.inputTokens,
            outputTokens: result.outputTokens, durationMs: Date.now() - started, error: null });
        }
        return result;
      } catch (error) {
        if (job === "diff_summary" || job === "pre_merge_review") {
          runs.push({ job, provider: null, model: null, inputTokens: 0, outputTokens: 0,
            durationMs: Date.now() - started, error: (error as Error).message });
        }
        throw error;
      }
    },
  };
}

export async function generatePreMergeNote(
  router: ModelRouter | null,
  event: GithubEvent,
  facts: CoordinationFact[],
  runs: CapturedRun[] = [],
): Promise<{ note: string; generatedBy: "rules" | "llm" }> {
  const fallback = rulesNote(event, facts);
  if (!router || !router.available("pre_merge_review")) return { note: fallback, generatedBy: "rules" };
  const audited = captureRouter(router, runs);
  let diffSummary: string | null = null;
  if (audited.available("diff_summary")) {
    try {
      const diff = await runJson(audited, "diff_summary", {
        system: "Summarize only the PR's coordination scope from its title, branch and changed files. Do not review code quality.",
        messages: [{ role: "user", content: JSON.stringify({ pull_request: event.pull_request, branch: event.branch, changed_files: event.changed_files }) }],
        maxTokens: 200, temperature: 0, json: true,
      }, DiffReply, { cacheKey: `pre-merge-diff:${event.event_id}` });
      if (!CODE_REVIEW_LANGUAGE.test(diff.summary)) diffSummary = diff.summary;
    } catch { /* The smart note still has deterministic facts. */ }
  }
  try {
    const reply = await runJson(audited, "pre_merge_review", {
      system: "Write a concise before-you-merge coordination note. Discuss only collisions, dependencies, scope and plan alignment. Never review implementation or code quality. Cite only supplied fact IDs.",
      messages: [{ role: "user", content: JSON.stringify({ pull_request: event.pull_request, facts, diff_summary: diffSummary }) }],
      maxTokens: 500, temperature: 0, json: true,
    }, NoteReply, { cacheKey: `pre-merge-note:${event.event_id}:${JSON.stringify(facts)}` });
    const allowed = new Set(facts.map((fact) => fact.id));
    if (CODE_REVIEW_LANGUAGE.test(reply.summary) ||
        new Set(reply.cited_fact_ids).size !== reply.cited_fact_ids.length ||
        reply.cited_fact_ids.some((id) => !allowed.has(id)) ||
        (facts.length > 0 && reply.cited_fact_ids.length === 0)) return { note: fallback, generatedBy: "rules" };
    const citations = reply.cited_fact_ids.map((id) => `[${id}]`).join(" ");
    return { note: `${reply.summary}${citations ? ` Evidence: ${citations}` : ""}`, generatedBy: "llm" };
  } catch {
    return { note: fallback, generatedBy: "rules" };
  }
}

async function persistRuns(db: Db, projectId: string, sourceEventId: string, runs: CapturedRun[]) {
  for (const run of runs) {
    await db.query(`insert into ai_runs
      (run_id,project_id,job,provider,model,input_tokens,output_tokens,duration_ms,status,error,source_event_id)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [newId("airun"), projectId, run.job, run.provider, run.model, run.inputTokens, run.outputTokens,
       run.durationMs, run.error ? "failed" : "success", run.error, sourceEventId]);
  }
}

/** Creates at most one dashboard note for each PR opened/synchronized event. */
export async function notifyPendingPullRequests(
  db: Db,
  router: ModelRouter | null,
  projectId: string,
  snapshot: ProjectSnapshot,
  result: AnalysisResult,
): Promise<number> {
  const candidates = snapshot.events.filter((event) =>
    ["pull_request_opened", "pull_request_updated", "pull_request_reopened"].includes(event.event_type),
  );
  let inserted = 0;
  for (const event of candidates) {
    if (!event.pull_request || !event.branch) continue;
    const exists = await db.query("select 1 from maintainer_notes where project_id=$1 and source_event_id=$2", [projectId, event.event_id]);
    if (exists.rowCount) continue;
    const { taskId, facts } = coordinationFacts(snapshot, result, event);
    const runs: CapturedRun[] = [];
    const generated = await generatePreMergeNote(router, event, facts, runs);
    await persistRuns(db, projectId, event.event_id, runs);
    const evidence = unique([event.event_id, ...facts.flatMap((fact) => fact.evidence_event_ids)]);
    const saved = await db.query(`insert into maintainer_notes
      (note_id,project_id,repository_id,source_event_id,pull_request_number,branch,task_id,note,facts,evidence_event_ids,generated_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      on conflict (project_id,source_event_id) do nothing`,
      [newId("note"), projectId, event.repository_id, event.event_id, event.pull_request.number,
       event.branch, taskId, generated.note, JSON.stringify(facts), evidence, generated.generatedBy]);
    inserted += saved.rowCount ?? 0;
  }
  return inserted;
}
