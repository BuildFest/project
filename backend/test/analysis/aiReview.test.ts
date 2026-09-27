import { describe, expect, it } from "vitest";
import type { CompletionResult } from "../../src/ai/client.js";
import type { ModelRouter } from "../../src/ai/router.js";
import { reviewAnalysis } from "../../src/analysis/aiReview.js";
import type { DerivedTaskState, DesiredHealthSignal, GithubEvent } from "../../src/analysis/types.js";
import { event, task } from "./fixtures.js";

function state(overrides: Partial<DerivedTaskState> = {}): DerivedTaskState {
  return {
    task_id: "task_a",
    computed_status: "in_progress",
    override_status: null,
    effective_status: "in_progress",
    confidence: 0.7,
    evidence_event_ids: ["event_a"],
    last_activity_at: new Date("2026-09-26T12:00:00Z"),
    blocking_task_ids: [],
    explanation: "Linked work exists",
    computation_method: "rules",
    ...overrides,
  };
}

function signal(overrides: Partial<DesiredHealthSignal> = {}): DesiredHealthSignal {
  return {
    type: "plan_state_disagreement",
    severity: "info",
    title: "Plan differs",
    explanation: "The plan says not started but work exists",
    related_task_ids: ["task_a"],
    related_milestone_ids: [],
    evidence_event_ids: ["event_a"],
    fingerprint: "plan_state_disagreement:task_a:not_started:in_progress",
    ...overrides,
  };
}

function answer(overrides: Record<string, unknown> = {}) {
  return {
    tasks: [
      {
        task_id: "task_a",
        status: "in_progress",
        confidence: 0.85,
        explanation: "Commit event_a shows implementation work",
        evidence_event_ids: ["event_a"],
      },
    ],
    signals: [
      {
        fingerprint: "plan_state_disagreement:task_a:not_started:in_progress",
        keep: true,
        severity: "warning",
        title: "Plan needs an update",
        explanation: "event_a shows work while the plan says not started",
        evidence_event_ids: ["event_a"],
      },
    ],
    ...overrides,
  };
}

function routerWith(...replies: Array<unknown | Error>): ModelRouter & { requests: any[] } {
  const requests: any[] = [];
  return {
    requests,
    available: () => true,
    async run(job, request): Promise<CompletionResult> {
      requests.push({ job, request });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return {
        text: typeof reply === "string" ? reply : JSON.stringify(reply),
        provider: "anthropic",
        model: "smart",
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
}

const commit = event({ event_id: "event_a", event_type: "commit", branch: "feature" });
const base = {
  tasks: [task({ task_id: "task_a", task_key: "PC-1", plan_status: "not_started" })],
  states: [state()],
  signals: [signal()],
  events: [commit] as GithubEvent[],
};

describe("reviewAnalysis", () => {
  it("uses the smart state-review job and applies grounded decisions", async () => {
    const router = routerWith(answer());
    const result = await reviewAnalysis(router, base);
    expect(router.requests).toHaveLength(1);
    expect(router.requests[0]).toMatchObject({
      job: "state_review",
      request: { json: true, temperature: 0 },
    });
    expect(router.requests[0].request.system).toContain("plan_status is human-authored and immutable");
    expect(result).toMatchObject({ applied: true, error: null });
    expect(result.states[0]).toMatchObject({
      computed_status: "in_progress",
      effective_status: "in_progress",
      confidence: 0.85,
      computation_method: "rules+llm",
    });
    expect(result.signals[0]).toMatchObject({ severity: "warning", title: "Plan needs an update" });
    expect(base.tasks[0].plan_status).toBe("not_started");
  });

  it("lets the reviewer suppress a noisy rule signal", async () => {
    const response = answer();
    response.signals[0].keep = false;
    const result = await reviewAnalysis(routerWith(response), base);
    expect(result.applied).toBe(true);
    expect(result.signals).toEqual([]);
  });

  it("preserves a human override when AI changes computed status", async () => {
    const response = answer();
    response.tasks[0].status = "not_started";
    const input = { ...base, states: [state({ override_status: "possibly_blocked", effective_status: "possibly_blocked" })] };
    const result = await reviewAnalysis(routerWith(response), input);
    expect(result.states[0]).toMatchObject({
      computed_status: "not_started",
      override_status: "possibly_blocked",
      effective_status: "possibly_blocked",
    });
  });

  it("falls back unchanged when no model is configured", async () => {
    const router: ModelRouter = {
      available: () => false,
      run: async () => { throw new Error("must not run"); },
    };
    const result = await reviewAnalysis(router, base);
    expect(result).toEqual({ states: base.states, signals: base.signals, applied: false, error: null });
  });

  it("falls back unchanged when the model call fails", async () => {
    const result = await reviewAnalysis(routerWith(new Error("model down")), base);
    expect(result.states).toBe(base.states);
    expect(result.signals).toBe(base.signals);
    expect(result).toMatchObject({ applied: false, error: "model down" });
  });

  it("rejects invented task IDs, fingerprints, and evidence IDs", async () => {
    const inventedTask = answer();
    inventedTask.tasks[0].task_id = "made_up";
    expect((await reviewAnalysis(routerWith(inventedTask), base)).applied).toBe(false);

    const inventedSignal = answer();
    inventedSignal.signals[0].fingerprint = "made_up";
    expect((await reviewAnalysis(routerWith(inventedSignal), base)).applied).toBe(false);

    const inventedEvidence = answer();
    inventedEvidence.tasks[0].evidence_event_ids = ["made_up"];
    const result = await reviewAnalysis(routerWith(inventedEvidence), base);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("invented evidence");
  });

  it("repairs a schema-valid review that invented an evidence ID", async () => {
    const inventedEvidence = answer();
    inventedEvidence.tasks[0].evidence_event_ids = ["made_up"];
    const router = routerWith(inventedEvidence, answer());

    const result = await reviewAnalysis(router, base);

    expect(router.requests).toHaveLength(2);
    expect(router.requests[1].request.messages[2].content).toContain("invented evidence");
    expect(result).toMatchObject({ applied: true, error: null });
    expect(result.states[0].evidence_event_ids).toEqual(["event_a"]);
  });

  it("requires grounded evidence citations when facts provide them", async () => {
    const missingTaskEvidence = answer();
    missingTaskEvidence.tasks[0].evidence_event_ids = [];
    expect((await reviewAnalysis(routerWith(missingTaskEvidence), base)).error).toContain("omitted evidence for task");

    const missingSignalEvidence = answer();
    missingSignalEvidence.signals[0].evidence_event_ids = [];
    expect((await reviewAnalysis(routerWith(missingSignalEvidence), base)).error).toContain("omitted evidence for signal");
  });

  it("cannot mark a task complete without cited merged evidence", async () => {
    const response = answer();
    response.tasks[0].status = "complete";
    const result = await reviewAnalysis(routerWith(response), base);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("without merged evidence");
  });

  it("can mark a task complete when its cited evidence is a merge", async () => {
    const response = answer();
    response.tasks[0].status = "complete";
    const merged = event({ event_id: "event_a", event_type: "pull_request_merged" });
    const result = await reviewAnalysis(routerWith(response), {
      ...base,
      events: [merged],
      states: [state({ blocking_task_ids: ["task_dependency"] })],
    });
    expect(result.states[0].computed_status).toBe("complete");
    expect(result.states[0].blocking_task_ids).toEqual([]);
    expect(result.applied).toBe(true);
  });

  it("cannot invent a blocked state without rule-derived blockers", async () => {
    const response = answer();
    response.tasks[0].status = "possibly_blocked";
    const result = await reviewAnalysis(routerWith(response), base);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("without a blocking task");
  });

  it("falls back after two malformed replies", async () => {
    const router = routerWith("not json", { wrong: true });
    const result = await reviewAnalysis(router, base);
    expect(router.requests).toHaveLength(2);
    expect(result.states).toBe(base.states);
    expect(result.applied).toBe(false);
    expect(result.error).toContain("invalid");
  });
});
