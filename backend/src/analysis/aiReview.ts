import { z } from "zod";
import { runJson } from "../ai/json.js";
import type { ModelRouter } from "../ai/router.js";
import type {
  DerivedTaskState,
  DesiredHealthSignal,
  GithubEvent,
  Task,
} from "./types.js";

const Status = z.enum(["not_started", "in_progress", "complete", "possibly_blocked"]);
const Severity = z.enum(["info", "warning", "critical"]);
const ReviewReply = z.object({
  tasks: z.array(
    z.object({
      task_id: z.string().min(1),
      status: Status,
      confidence: z.number().min(0).max(1),
      explanation: z.string().trim().min(1).max(500),
      evidence_event_ids: z.array(z.string().min(1)).max(20),
    }),
  ),
  signals: z.array(
    z.object({
      fingerprint: z.string().min(1),
      keep: z.boolean(),
      severity: Severity,
      title: z.string().trim().min(1).max(200),
      explanation: z.string().trim().min(1).max(500),
      evidence_event_ids: z.array(z.string().min(1)).max(20),
    }),
  ),
});

export interface ReviewAnalysisInput {
  tasks: Task[];
  states: DerivedTaskState[];
  signals: DesiredHealthSignal[];
  events: GithubEvent[];
}

export interface ReviewAnalysisResult {
  states: DerivedTaskState[];
  signals: DesiredHealthSignal[];
  applied: boolean;
  error: string | null;
}

const SYSTEM_PROMPT = `You review Pit Crew's deterministic plan-versus-repository analysis.
The rules are the safety floor; improve judgment and wording only when the supplied facts support it.
Return exactly one task review per task and one signal review per signal. Never invent IDs or evidence.
Task plan_status is human-authored and immutable; it is context only and cannot be changed.
A task can be complete only when its evidence includes a pull_request_merged event.
Use possibly_blocked only when the supplied rule facts name blocking tasks.
Every non-not_started status and every changed signal claim must cite supplied evidence_event_ids when event evidence exists.
Set keep=false only for a rule signal that is redundant or not useful to the team.
Reply only as JSON: {"tasks":[{"task_id":"...","status":"in_progress","confidence":0.8,"explanation":"...","evidence_event_ids":["..."]}],"signals":[{"fingerprint":"...","keep":true,"severity":"warning","title":"...","explanation":"...","evidence_event_ids":["..."]}]}.`;

function sameMembers(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length && actual.every((id) => expected.includes(id));
}

function subset(actual: string[], allowed: string[]): boolean {
  return new Set(actual).size === actual.length && actual.every((id) => allowed.includes(id));
}

function fallback(input: ReviewAnalysisInput, error: unknown = null): ReviewAnalysisResult {
  return {
    states: input.states,
    signals: input.signals,
    applied: false,
    error: error === null ? null : error instanceof Error ? error.message : String(error),
  };
}

/**
 * Lets the smart model review rule outputs, then enforces hard facts before
 * returning anything. Any malformed or unsupported claim discards the whole
 * review so callers can safely persist the unchanged deterministic result.
 */
export async function reviewAnalysis(
  router: ModelRouter,
  input: ReviewAnalysisInput,
): Promise<ReviewAnalysisResult> {
  if (!router.available("state_review") || (input.states.length === 0 && input.signals.length === 0)) {
    return fallback(input);
  }

  const eventById = new Map(input.events.map((event) => [event.event_id, event]));
  const taskById = new Map(input.tasks.map((task) => [task.task_id, task]));
  const stateById = new Map(input.states.map((state) => [state.task_id, state]));
  const signalByFingerprint = new Map(input.signals.map((signal) => [signal.fingerprint, signal]));
  const facts = {
    tasks: input.states.map((state) => ({
      task: taskById.get(state.task_id) ?? { task_id: state.task_id },
      rule_state: state,
      evidence: state.evidence_event_ids.map((id) => eventById.get(id)).filter(Boolean),
    })),
    signals: input.signals,
  };

  try {
    const reply = await runJson(
      router,
      "state_review",
      { system: SYSTEM_PROMPT, messages: [{ role: "user", content: JSON.stringify(facts) }], maxTokens: 4_000, temperature: 0 },
      ReviewReply,
      { cacheKey: JSON.stringify(facts) },
    );
    if (!sameMembers(reply.tasks.map((item) => item.task_id), input.states.map((state) => state.task_id))) {
      throw new Error("AI review task IDs do not exactly match rule output");
    }
    if (!sameMembers(reply.signals.map((item) => item.fingerprint), input.signals.map((signal) => signal.fingerprint))) {
      throw new Error("AI review signal IDs do not exactly match rule output");
    }

    for (const item of reply.tasks) {
      const rule = stateById.get(item.task_id)!;
      if (!subset(item.evidence_event_ids, rule.evidence_event_ids)) {
        throw new Error(`AI review invented evidence for task ${item.task_id}`);
      }
      if (rule.evidence_event_ids.length > 0 && item.evidence_event_ids.length === 0) {
        throw new Error(`AI review omitted evidence for task ${item.task_id}`);
      }
      if (
        item.status === "complete" &&
        !item.evidence_event_ids.some((id) => eventById.get(id)?.event_type === "pull_request_merged")
      ) {
        throw new Error(`AI review marked task ${item.task_id} complete without merged evidence`);
      }
      if (item.status === "possibly_blocked" && rule.blocking_task_ids.length === 0) {
        throw new Error(`AI review marked task ${item.task_id} blocked without a blocking task`);
      }
    }
    for (const item of reply.signals) {
      const rule = signalByFingerprint.get(item.fingerprint)!;
      if (!subset(item.evidence_event_ids, rule.evidence_event_ids)) {
        throw new Error(`AI review invented evidence for signal ${item.fingerprint}`);
      }
      if (item.keep && rule.evidence_event_ids.length > 0 && item.evidence_event_ids.length === 0) {
        throw new Error(`AI review omitted evidence for signal ${item.fingerprint}`);
      }
    }

    const reviewedStates = input.states.map((rule) => {
      const item = reply.tasks.find((candidate) => candidate.task_id === rule.task_id)!;
      return {
        ...rule,
        computed_status: item.status,
        // Human corrections remain authoritative over both rules and AI.
        effective_status: rule.override_status ?? item.status,
        blocking_task_ids: item.status === "possibly_blocked" ? rule.blocking_task_ids : [],
        confidence: item.confidence,
        evidence_event_ids: item.evidence_event_ids,
        explanation: item.explanation,
        computation_method: "rules+llm" as const,
      };
    });
    const reviewedSignals = input.signals.flatMap((rule) => {
      const item = reply.signals.find((candidate) => candidate.fingerprint === rule.fingerprint)!;
      return item.keep
        ? [{ ...rule, severity: item.severity, title: item.title, explanation: item.explanation, evidence_event_ids: item.evidence_event_ids }]
        : [];
    });
    return { states: reviewedStates, signals: reviewedSignals, applied: true, error: null };
  } catch (error) {
    return fallback(input, error);
  }
}
