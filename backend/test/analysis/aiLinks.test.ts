import { describe, expect, it } from "vitest";
import type { CompletionRequest, CompletionResult } from "../../src/ai/client.js";
import type { ModelRouter } from "../../src/ai/router.js";
import { groupEventsForLinking, suggestLinks } from "../../src/analysis/aiLinks.js";
import { T0, event, hoursAfter, task } from "./fixtures.js";

const main = () => "main";

function scriptedRouter(replies: unknown[]): ModelRouter & { requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  return {
    requests,
    available: () => true,
    async run(_job, request): Promise<CompletionResult> {
      requests.push(request);
      const next = replies.shift();
      return {
        text: typeof next === "string" ? next : JSON.stringify(next),
        provider: "groq",
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
      };
    },
  };
}

describe("groupEventsForLinking", () => {
  it("groups a branch's commits and PR events together", () => {
    const groups = groupEventsForLinking(
      [
        event({ event_id: "c1", event_type: "commit", branch: "auth-routes" }),
        event({
          event_id: "p1",
          event_type: "pull_request_merged",
          branch: "main",
          pull_request: { number: 4, title: "Add auth", head_branch: "auth-routes" },
        }),
        event({ event_id: "c2", event_type: "commit", branch: "main" }),
        event({ event_id: "x", event_type: "push", branch: "main" }),
        event({ event_id: "d", event_type: "branch_deleted", branch: "auth-routes" }),
      ],
      main,
    );
    expect(groups.map((g) => [g.key, g.events.map((e) => e.event_id)])).toEqual([
      ["branch:repo_1:auth-routes", ["c1", "p1"]],
      ["commit:c2", ["c2"]],
    ]);
  });
});

describe("suggestLinks", () => {
  const auth = task({ task_id: "task_auth", task_key: "PC-1", title: "Authentication API" });
  const dash = task({ task_id: "task_dash", task_key: "PC-2", title: "Dashboard" });
  const groups = groupEventsForLinking(
    [
      event({
        event_id: "c1",
        event_type: "commit",
        branch: "jwt-refresh",
        commit: { sha: "a", message: "Implement JWT refresh token handling\n\nlong body" },
        changed_files: ["src/api/auth.ts"],
      }),
      event({
        event_id: "c2",
        event_type: "commit",
        branch: "chore-lint",
        occurred_at: hoursAfter(T0, 1),
        commit: { sha: "b", message: "fix lint" },
      }),
    ],
    main,
  );

  it("maps model answers back to groups", async () => {
    const router = scriptedRouter([
      {
        links: [
          { group: "g1", task_id: "task_auth", confidence: 0.86, reason: "JWT refresh is auth work" },
          { group: "g2", task_id: null, confidence: 0.2, reason: "lint only" },
        ],
      },
    ]);
    const suggestions = await suggestLinks(router, groups, [auth, dash]);
    expect(suggestions).toEqual([
      {
        group_key: "branch:repo_1:jwt-refresh",
        task_id: "task_auth",
        confidence: 0.86,
        reason: "JWT refresh is auth work",
      },
      { group_key: "branch:repo_1:chore-lint", task_id: null, confidence: 0.2, reason: "lint only" },
    ]);
    const prompt = JSON.parse(router.requests[0].messages[0].content);
    expect(prompt.groups[0]).toMatchObject({
      group: "g1",
      branch: "jwt-refresh",
      commits: ["Implement JWT refresh token handling"],
      files: ["src/api/auth.ts"],
    });
  });

  it("rejects task ids that are not in the plan", async () => {
    const router = scriptedRouter([
      { links: [{ group: "g1", task_id: "task_made_up", confidence: 0.9, reason: "?" }] },
      { links: [{ group: "g1", task_id: "task_dash", confidence: 0.6, reason: "retry" }] },
    ]);
    const [first] = await suggestLinks(router, groups.slice(0, 1), [auth, dash]);
    expect(first.task_id).toBe("task_dash");
    expect(router.requests).toHaveLength(2);
  });

  it("batches groups", async () => {
    const router = scriptedRouter([
      { links: [{ group: "g1", task_id: "task_auth", confidence: 0.9, reason: "a" }] },
      { links: [{ group: "g1", task_id: null, confidence: 0.1, reason: "b" }] },
    ]);
    const suggestions = await suggestLinks(router, groups, [auth, dash], 1);
    expect(suggestions).toHaveLength(2);
    expect(router.requests).toHaveLength(2);
  });

  it("skips the call when there is nothing to link against", async () => {
    const router = scriptedRouter([]);
    expect(await suggestLinks(router, groups, [])).toEqual([]);
    expect(router.requests).toHaveLength(0);
  });
});
