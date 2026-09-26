import { z } from "zod";
import { CreateTaskInput } from "./inputs.js";

// The closed set of plan edits a replan suggestion may propose (contract §5.7).
// B generates them, the accept endpoint applies them, the frontend renders them.
// Field rules reuse the plan-editing inputs, so a replan can't write anything
// a human couldn't write through the plan endpoints.

const id = z.string().min(1);

export const PlanChange = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("update_task"),
    task_id: id,
    changes: CreateTaskInput.partial().refine((c) => Object.keys(c).length > 0, "no fields to change"),
  }),
  z.object({ op: z.literal("create_task"), task: CreateTaskInput }),
  z.object({ op: z.literal("add_dependency"), task_id: id, depends_on_task_id: id }),
  z.object({ op: z.literal("remove_dependency"), task_id: id, depends_on_task_id: id }),
  z.object({
    op: z.literal("update_milestone"),
    milestone_id: id,
    changes: z
      .object({
        target_at: z.string().min(1).nullable().optional(),
        name: z.string().trim().min(1).optional(),
      })
      .refine((c) => Object.keys(c).length > 0, "no fields to change"),
  }),
]);

export type PlanChange = z.infer<typeof PlanChange>;

export const PlanChanges = z.array(PlanChange);
