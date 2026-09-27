import { describe, expect, it } from "vitest";
import { deriveBranchFiles } from "../../src/analysis/branches.js";
import { event, hoursAfter, task, T0 } from "./fixtures.js";

const defaults = (repositoryId: string) => repositoryId === "repo_2" ? "trunk" : "main";

describe("deriveBranchFiles", () => {
  it("unions push, commit and PR files in stable order", () => {
    const events = [
      event({ event_id: "3", event_type: "pull_request_updated", branch: "pc-1-auth", pull_request: { number: 1, title: "Auth", head_branch: "pc-1-auth" }, changed_files: ["c.ts", "a.ts"], occurred_at: hoursAfter(T0, 2) }),
      event({ event_id: "1", event_type: "push", branch: "pc-1-auth", changed_files: ["b.ts"], occurred_at: T0 }),
      event({ event_id: "2", event_type: "commit", branch: "pc-1-auth", changed_files: ["a.ts", "b.ts"], occurred_at: hoursAfter(T0, 1) }),
    ];

    expect(deriveBranchFiles(events, [task({ task_id: "task_1", task_key: "PC-1" })], "PC", defaults)).toEqual([{
      repository_id: "repo_1", branch: "pc-1-auth", changed_files: ["a.ts", "b.ts", "c.ts"], task_id: "task_1",
    }]);
  });

  it("resets files across terminal lifecycle events and re-creation", () => {
    const types = ["push", "pull_request_merged", "push", "branch_deleted", "branch_created", "commit"] as const;
    const files = ["old.ts", "after-merge.ts", "after-merge.ts", "after-delete.ts", "creation.ts", "new.ts"];
    const events = types.map((event_type, index) => event({
      event_id: String(index), event_type, branch: "feature", changed_files: [files[index]], occurred_at: hoursAfter(T0, index),
    }));
    expect(deriveBranchFiles(events, [], "PC", defaults)[0].changed_files).toEqual(["new.ts"]);
  });

  it("sorts out-of-order input by time and event id before replaying", () => {
    const events = [
      event({ event_id: "b", event_type: "push", branch: "feature", changed_files: ["new.ts"], occurred_at: hoursAfter(T0, 1) }),
      event({ event_id: "z", event_type: "push", branch: "feature", changed_files: ["discarded.ts"], occurred_at: T0 }),
      event({ event_id: "a", event_type: "branch_created", branch: "feature", occurred_at: hoursAfter(T0, 1) }),
    ];
    expect(deriveBranchFiles(events, [], "PC", defaults)[0].changed_files).toEqual(["new.ts"]);
  });

  it("skips default branches and links only live tasks named by the branch", () => {
    const events = [
      event({ event_id: "main", event_type: "push", branch: "main", changed_files: ["main.ts"] }),
      event({ event_id: "known", event_type: "push", branch: "pc-2-and-pc-3", changed_files: ["x.ts"] }),
      event({ event_id: "unknown", event_type: "push", branch: "pc-99-work", changed_files: ["y.ts"] }),
    ];
    const tasks = [
      task({ task_id: "archived", task_key: "PC-2", archived: true }),
      task({ task_id: "live", task_key: "PC-3" }),
    ];
    expect(deriveBranchFiles(events, tasks, "PC", defaults)).toEqual([
      { repository_id: "repo_1", branch: "pc-2-and-pc-3", changed_files: ["x.ts"], task_id: "live" },
      { repository_id: "repo_1", branch: "pc-99-work", changed_files: ["y.ts"], task_id: null },
    ]);
  });
});
