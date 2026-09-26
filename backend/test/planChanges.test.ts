import { describe, expect, it } from "vitest";
import { PlanChanges } from "../src/api/planChanges.js";

describe("PlanChanges", () => {
  it("accepts every op in the contract", () => {
    const ops = [
      { op: "update_task", task_id: "task_1", changes: { priority: "critical", target_at: "2026-10-01" } },
      { op: "create_task", task: { title: "Retry webhooks", scope: "optional" } },
      { op: "add_dependency", task_id: "task_2", depends_on_task_id: "task_1" },
      { op: "remove_dependency", task_id: "task_3", depends_on_task_id: "task_1" },
      { op: "update_milestone", milestone_id: "ms_1", changes: { target_at: null } },
    ];
    expect(PlanChanges.parse(ops)).toEqual(ops);
  });

  it("strips fields a human couldn't set through the plan endpoints", () => {
    const [op] = PlanChanges.parse([
      { op: "update_task", task_id: "task_1", changes: { title: "New", task_key: "PC-99", project_id: "x" } },
    ]);
    expect(op).toEqual({ op: "update_task", task_id: "task_1", changes: { title: "New" } });
  });

  it("rejects unknown ops, bad values and empty changes", () => {
    expect(PlanChanges.safeParse([{ op: "delete_task", task_id: "task_1" }]).success).toBe(false);
    expect(
      PlanChanges.safeParse([{ op: "update_task", task_id: "task_1", changes: { priority: "urgent" } }]).success,
    ).toBe(false);
    expect(PlanChanges.safeParse([{ op: "update_task", task_id: "task_1", changes: {} }]).success).toBe(false);
    expect(PlanChanges.safeParse([{ op: "update_milestone", milestone_id: "ms_1", changes: {} }]).success).toBe(false);
    expect(PlanChanges.safeParse([{ op: "create_task", task: { title: "" } }]).success).toBe(false);
  });
});
