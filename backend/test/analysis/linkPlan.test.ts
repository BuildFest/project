import { describe, expect, it } from "vitest";
import {
  countsTowardState,
  linksFromSuggestions,
  planLinks,
} from "../../src/analysis/linkPlan.js";
import type { EventTaskLink } from "../../src/analysis/types.js";
import { event, task } from "./fixtures.js";

const main = () => "main";
const auth = task({ task_id: "task_auth", task_key: "PC-1" });
const dash = task({ task_id: "task_dash", task_key: "PC-2" });

function link(overrides: Partial<EventTaskLink> & Pick<EventTaskLink, "event_id" | "task_id">): EventTaskLink {
  return { method: "llm", confidence: 0.9, status: "suggested", is_primary: true, ...overrides };
}

describe("countsTowardState", () => {
  it("counts confirmed links and confident ai suggestions only", () => {
    expect(countsTowardState(link({ event_id: "e", task_id: "t", status: "confirmed", confidence: 0.1 }))).toBe(true);
    expect(countsTowardState(link({ event_id: "e", task_id: "t", confidence: 0.8 }))).toBe(true);
    expect(countsTowardState(link({ event_id: "e", task_id: "t", confidence: 0.79 }))).toBe(false);
    expect(countsTowardState(link({ event_id: "e", task_id: "t", status: "rejected", confidence: 1 }))).toBe(false);
  });
});

describe("planLinks", () => {
  it("links by task key without asking the model", () => {
    const plan = planLinks(
      [event({ event_id: "c1", event_type: "commit", branch: "pc-1-auth" })],
      [auth, dash],
      "PC",
      [],
      main,
    );
    expect(plan.links.map((l) => [l.event_id, l.task_id, l.method, l.status])).toEqual([
      ["c1", "task_auth", "task_key", "confirmed"],
    ]);
    expect(plan.needsAi).toEqual([]);
  });

  it("lets commits inherit the key named only in their PR title", () => {
    const plan = planLinks(
      [
        event({ event_id: "c1", event_type: "commit", branch: "auth-work" }),
        event({
          event_id: "p1",
          event_type: "pull_request_opened",
          pull_request: { number: 3, title: "PC-1 auth routes", head_branch: "auth-work" },
        }),
      ],
      [auth],
      "PC",
      [],
      main,
    );
    expect(plan.links.map((l) => [l.event_id, l.method, l.status])).toEqual([
      ["p1", "task_key", "confirmed"],
      ["c1", "task_key", "confirmed"],
    ]);
  });

  it("lets new events inherit an earlier ai link on the same branch", () => {
    const plan = planLinks(
      [
        event({ event_id: "c1", event_type: "commit", branch: "jwt" }),
        event({ event_id: "c2", event_type: "commit", branch: "jwt" }),
      ],
      [auth],
      "PC",
      [link({ event_id: "c1", task_id: "task_auth", confidence: 0.85 })],
      main,
    );
    expect(plan.links).toMatchObject([
      { event_id: "c2", task_id: "task_auth", method: "llm", status: "suggested", confidence: 0.85 },
    ]);
    expect(plan.needsAi).toEqual([]);
  });

  it("sends only unlinked, unrelated work to the model", () => {
    const plan = planLinks(
      [
        event({ event_id: "c1", event_type: "commit", branch: "jwt" }),
        event({ event_id: "c2", event_type: "commit", branch: "main" }),
      ],
      [auth],
      "PC",
      [],
      main,
    );
    expect(plan.needsAi.map((g) => [g.key, g.events.map((e) => e.event_id)])).toEqual([
      ["branch:repo_1:jwt", ["c1"]],
      ["commit:c2", ["c2"]],
    ]);
  });
});

describe("linksFromSuggestions", () => {
  const groups = [
    { key: "branch:repo_1:jwt", branch: "jwt", events: [event({ event_id: "c1", event_type: "commit" })] },
  ];

  it("links every event in the group with the model's reason", () => {
    const links = linksFromSuggestions(
      groups,
      [{ group_key: "branch:repo_1:jwt", task_id: "task_auth", confidence: 0.7, reason: "jwt is auth" }],
      [],
    );
    expect(links).toEqual([
      {
        event_id: "c1",
        task_id: "task_auth",
        method: "llm",
        status: "suggested",
        confidence: 0.7,
        reason: "jwt is auth",
        is_primary: true,
      },
    ]);
  });

  it("never re-suggests a pair a teammate rejected, and skips null answers", () => {
    const rejected = [link({ event_id: "c1", task_id: "task_auth", status: "rejected" })];
    expect(
      linksFromSuggestions(
        groups,
        [{ group_key: "branch:repo_1:jwt", task_id: "task_auth", confidence: 0.9, reason: "x" }],
        rejected,
      ),
    ).toEqual([]);
    expect(
      linksFromSuggestions(groups, [{ group_key: "branch:repo_1:jwt", task_id: null, confidence: 0.1, reason: "x" }], []),
    ).toEqual([]);
  });
});
