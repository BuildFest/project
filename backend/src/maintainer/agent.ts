import { createHash } from "node:crypto";
import { z } from "zod";
import { runJson } from "../ai/json.js";
import type { ModelRouter } from "../ai/router.js";
import { executeMaintainerTools, type MaintainerFacts, type MaintainerToolName, type ToolCall } from "./tools.js";

const ToolName = z.enum(["get_state", "get_task", "get_events", "get_signals", "get_collisions", "get_replans"]);
const Plan = z.object({ tool_calls: z.array(z.object({ tool: ToolName, ids: z.array(z.string()).max(50).optional() })).min(1).max(8) });
const Citation = z.object({ type: z.enum(["task", "event", "signal", "collision", "replan"]), id: z.string().min(1) });
const Answer = z.object({ title: z.string().trim().min(1).max(160), body: z.string().trim().min(1).max(4000), citations: z.array(Citation).max(30) });
export type MaintainerCitation = z.infer<typeof Citation>;
export interface MaintainerOutput { title: string; body: string; citations: MaintainerCitation[]; generated_by: "rules" | "llm"; error: string | null }

const SYSTEM = `You are Pit Crew's project Maintainer. You coordinate plan-versus-repository work; you do not review code quality.
Use only returned tool facts. Every concrete claim must cite real IDs. Never change plan status, events, or apply replans.
First select read-only tools. After tool results, return a concise grounded answer. Replan rows are proposals only.`;

function ids(facts: MaintainerFacts) {
  return {
    task: new Set(facts.tasks.map((x) => String(x.task_id))), event: new Set(facts.events.map((x) => String(x.event_id))),
    signal: new Set(facts.signals.map((x) => String(x.signal_id))), collision: new Set(facts.collisions.map((x) => String(x.collision_id))),
    replan: new Set(facts.replans.map((x) => String(x.suggestion_id))),
  };
}

function exposedIds(toolResults: Record<string, unknown>) {
  const rows = (name: string) => Array.isArray(toolResults[name]) ? toolResults[name] as Record<string, unknown>[] : [];
  const state = toolResults.get_state as { states?: Record<string, unknown>[] } | undefined;
  return {
    task: new Set([...(state?.states ?? []), ...rows("get_task")].map((x) => String(x.task_id))),
    event: new Set(rows("get_events").map((x) => String(x.event_id))),
    signal: new Set(rows("get_signals").map((x) => String(x.signal_id))),
    collision: new Set(rows("get_collisions").map((x) => String(x.collision_id))),
    replan: new Set(rows("get_replans").map((x) => String(x.suggestion_id))),
  };
}

function fallback(facts: MaintainerFacts, kind: "digest" | "ask", question?: string, error: unknown = null): MaintainerOutput {
  const citations: MaintainerCitation[] = [];
  const lines: string[] = [];
  const query = (question ?? "").toLowerCase();
  const asksAttention = /attention|risk|block|problem|concern|stuck/.test(query);
  const asksChanges = /change|recent|happen|merge|commit|pull request|\bpr\b/.test(query);
  const matchingTasks = kind === "ask"
    ? facts.tasks.filter((task) => {
        const haystack = `${task.task_key ?? ""} ${task.title ?? ""}`.toLowerCase();
        return haystack.split(/\s+/).some((term) => term.length > 2 && query.includes(term));
      })
    : [];
  for (const task of matchingTasks.slice(0, 3)) {
    const state = facts.states.find((item) => item.task_id === task.task_id);
    lines.push(`${task.task_key} ${task.title} is ${state?.effective_status ?? task.plan_status ?? "not yet analyzed"}.`);
    citations.push({ type: "task", id: String(task.task_id) });
  }
  if (facts.signals.length && (kind === "digest" || asksAttention || matchingTasks.length === 0)) {
    lines.push(`${facts.signals.length} active health signal${facts.signals.length === 1 ? "" : "s"}.`);
    citations.push(...facts.signals.slice(0, 5).map((x) => ({ type: "signal" as const, id: String(x.signal_id) })));
  }
  if (facts.collisions.length && (kind === "digest" || asksAttention || /branch|file|collision/.test(query))) {
    lines.push(`${facts.collisions.length} active branch collision risk${facts.collisions.length === 1 ? "" : "s"}.`);
    citations.push(...facts.collisions.slice(0, 5).map((x) => ({ type: "collision" as const, id: String(x.collision_id) })));
  }
  const recent = facts.events.slice(0, 3);
  if (recent.length && (kind === "digest" || asksChanges || lines.length === 0)) {
    lines.push(`${recent.length} recent repository event${recent.length === 1 ? "" : "s"} are available.`);
    citations.push(...recent.map((x) => ({ type: "event" as const, id: String(x.event_id) })));
  }
  if (!lines.length) lines.push("No analyzed repository activity or active risks are available yet.");
  const body = kind === "ask" ? `For “${question}”: ${lines.join(" ")}` : lines.join(" ");
  return { title: kind === "digest" ? "Project digest" : `Ask Pit Crew: ${question ?? "answer"}`, body, citations, generated_by: "rules", error: error ? String(error instanceof Error ? error.message : error) : null };
}

export async function runMaintainer(router: ModelRouter | null, facts: MaintainerFacts, kind: "digest" | "ask", question?: string): Promise<MaintainerOutput> {
  const job = kind === "digest" ? "digest" : "ask";
  if (!router?.available(job)) return fallback(facts, kind, question);
  const inventory = { project: facts.project, counts: { tasks: facts.tasks.length, events: facts.events.length, signals: facts.signals.length, collisions: facts.collisions.length, replans: facts.replans.length }, task_ids: facts.tasks.map((x) => x.task_id), signal_ids: facts.signals.map((x) => x.signal_id) };
  const intent = kind === "digest" ? "Create a current project digest." : `Answer: ${question}`;
  try {
    const plan = await runJson(router, job, { system: SYSTEM, messages: [{ role: "user", content: JSON.stringify({ intent, inventory }) }], maxTokens: 700, temperature: 0 }, Plan, { cacheKey: createHash("sha1").update(JSON.stringify({ intent, inventory })).digest("hex") });
    const toolResults = executeMaintainerTools(facts, plan.tool_calls as ToolCall[]);
    const answer = await runJson(router, job, { system: SYSTEM, messages: [
      { role: "user", content: JSON.stringify({ intent, inventory }) },
      { role: "assistant", content: JSON.stringify(plan) },
      { role: "user", content: JSON.stringify({ tool_results: toolResults, instruction: "Return title, body and citations JSON." }) },
    ], maxTokens: 1800, temperature: 0 }, Answer);
    const real = ids(facts);
    const exposed = exposedIds(toolResults);
    for (const citation of answer.citations) {
      if (!real[citation.type].has(citation.id)) throw new Error(`invented ${citation.type} citation ${citation.id}`);
      if (!exposed[citation.type].has(citation.id)) throw new Error(`citation was not returned by a tool: ${citation.id}`);
    }
    if ((facts.events.length || facts.signals.length || facts.collisions.length) && answer.citations.length === 0) throw new Error("grounded answer omitted citations");
    return { ...answer, generated_by: "llm", error: null };
  } catch (error) { return fallback(facts, kind, question, error); }
}
