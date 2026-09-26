import { describe, expect, it } from "vitest";
import type { CompletionRequest, CompletionResult } from "../src/ai/client.js";
import type { ModelRouter } from "../src/ai/router.js";
import { runMaintainer } from "../src/maintainer/agent.js";
import { executeMaintainerTools, type MaintainerFacts } from "../src/maintainer/tools.js";

const facts: MaintainerFacts = {
  project: { project_id: "proj_1", name: "Pit Crew" },
  tasks: [{ task_id: "task_1", task_key: "PC-1", title: "Auth" }],
  states: [{ task_id: "task_1", effective_status: "in_progress" }],
  events: [{ event_id: "event_1", event_type: "pull_request_opened", branch: "auth" }],
  signals: [{ signal_id: "sig_1", title: "Dependency incomplete" }],
  collisions: [{ collision_id: "col_1", branch_a: "auth", branch_b: "api" }],
  replans: [{ suggestion_id: "replan_1", rationale: "Move milestone" }],
};

function router(replies: unknown[]): ModelRouter & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    available: () => true,
    async run(_job, request): Promise<CompletionResult> {
      requests.push(request);
      return { text: JSON.stringify(replies.shift()), provider: "anthropic", model: "smart", inputTokens: 2, outputTokens: 3 };
    },
  };
}

describe("Maintainer agent", () => {
  it("selects read-only tools and returns validated grounded citations", async () => {
    const model = router([
      { tool_calls: [{ tool: "get_state" }, { tool: "get_events", ids: ["event_1"] }, { tool: "get_signals" }] },
      { title: "Auth coordination", body: "Auth has an open PR and a dependency warning.", citations: [{ type: "event", id: "event_1" }, { type: "signal", id: "sig_1" }] },
    ]);
    const result = await runMaintainer(model, facts, "ask", "What needs attention?");
    expect(result).toMatchObject({ generated_by: "llm", error: null, title: "Auth coordination" });
    expect(result.citations).toHaveLength(2);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1].messages.at(-1)?.content).toContain("event_1");
  });

  it("rejects invented citations and falls back to deterministic facts", async () => {
    const model = router([
      { tool_calls: [{ tool: "get_events" }] },
      { title: "Made up", body: "Unsupported", citations: [{ type: "event", id: "event_fake" }] },
    ]);
    const result = await runMaintainer(model, facts, "digest");
    expect(result.generated_by).toBe("rules");
    expect(result.error).toContain("invented event citation");
    expect(result.citations.every((citation) => citation.id !== "event_fake")).toBe(true);
  });

  it("works without a configured model", async () => {
    const result = await runMaintainer(null, facts, "ask", "Status?");
    expect(result).toMatchObject({ generated_by: "rules", error: null });
    expect(result.body).toContain("active health signal");
  });

  it("limits tools to requested real rows", () => {
    expect(executeMaintainerTools(facts, [{ tool: "get_task", ids: ["task_1", "task_fake"] }, { tool: "get_replans" }])).toEqual({
      get_task: [facts.tasks[0]], get_replans: facts.replans,
    });
  });
});
