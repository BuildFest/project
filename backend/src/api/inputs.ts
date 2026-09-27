import { z } from "zod";

// Request bodies. zod strips unknown keys, so a parsed object only ever
// contains whitelisted column names — updateRow() relies on that.
//
// Timestamps are passed through as strings and parsed by Postgres
// (timestamptz accepts "2026-10-01" as well as full ISO strings).

const timestamp = z.string().min(1).nullable();
const optionalText = z.string().nullable();

export const Priority = z.enum(["critical", "high", "medium", "low"]);
export const Scope = z.enum(["must_have", "optional"]);
export const PlanStatus = z.enum(["not_started", "in_progress", "blocked", "complete", "cancelled"]);

export const CreateProjectInput = z.object({
  name: z.string().trim().min(1),
  description: optionalText.optional(),
  task_key_prefix: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{0,9}$/),
  deadline_at: timestamp.default(null),
  timezone: z.string().min(1).default("UTC"),
  members: z
    .array(
      z.object({
        display_name: z.string().trim().min(1),
        github_login: z.string().trim().min(1).nullable().default(null),
        role_label: optionalText.optional(),
      }),
    )
    .default([]),
  brief: z.string().default(""),
});

export const UpdateProjectInput = z.object({
  name: z.string().trim().min(1),
  description: optionalText,
  deadline_at: timestamp,
  timezone: z.string().min(1),
  status: z.enum(["active", "archived"]),
}).partial();

export const AccessLevel = z.enum(["owner", "editor", "viewer"]);

// github_login is how GitHub activity is attributed to a member; "" clears it.
const githubLogin = z
  .string()
  .trim()
  .transform((s) => (s === "" ? null : s))
  .nullable();

export const CreateMemberInput = z.object({
  display_name: z.string().trim().min(1),
  github_login: githubLogin.default(null),
  role_label: optionalText.optional(),
  access_level: AccessLevel.default("editor"),
});

export const UpdateMemberInput = z.object({
  display_name: z.string().trim().min(1),
  github_login: githubLogin,
  role_label: optionalText,
  access_level: AccessLevel,
}).partial();

export const CreatePlanVersionInput = z.object({
  summary: z.string().trim().min(1).nullable().default(null),
  member_id: z.string().min(1).nullable().default(null),
});

export const UpdateBriefInput = z.object({
  content: z.string(),
  content_format: z.enum(["markdown", "plain"]).default("markdown"),
  updated_by: z.string().nullable().default(null),
});

export const CreateMilestoneInput = z.object({
  name: z.string().trim().min(1),
  description: optionalText.optional(),
  target_at: timestamp.optional(),
  sort_order: z.int().optional(),
});

export const UpdateMilestoneInput = CreateMilestoneInput.extend({
  archived: z.boolean(),
}).partial();

export const CreateTaskInput = z.object({
  title: z.string().trim().min(1),
  description: optionalText.optional(),
  owner_member_id: z.string().nullable().optional(),
  priority: Priority.optional(),
  scope: Scope.optional(),
  plan_status: PlanStatus.optional(),
  milestone_id: z.string().nullable().optional(),
  target_at: timestamp.optional(),
  sort_order: z.int().optional(),
});

export const UpdateTaskInput = CreateTaskInput.extend({
  archived: z.boolean(),
}).partial();

// Accepts "owner/name" or a pasted https://github.com/owner/name URL.
export const ConnectRepositoryInput = z.object({
  full_name: z
    .string()
    .trim()
    .transform((s) => s.replace(/^https?:\/\/github\.com\//i, "").replace(/(\.git)?\/?$/, ""))
    .pipe(z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/name")),
  make_primary: z.boolean().default(true),
});

// Query strings arrive as text, hence z.coerce. Browse mode (cursor) and
// consumer mode (after_seq) order differently, so they can't be combined.
export const ListEventsQuery = z
  .object({
    branch: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).optional(),
    cursor: z.string().regex(/^\d+$/, "invalid cursor").optional(),
    after_seq: z.coerce.number().int().min(0).optional(),
  })
  .refine((q) => q.cursor === undefined || q.after_seq === undefined, "use either cursor or after_seq, not both");

export const ListBranchesQuery = z.object({
  status: z.enum(["active", "merged", "deleted"]).optional(),
});

export const ListTimelineQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
  task_id: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
});

export const ListAiRunsQuery = z.object({
  status: z.enum(["success", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

export const CreateDecisionInput = z.object({
  title: z.string().trim().min(1),
  body: z.string().nullable().default(null),
  member_id: z.string().min(1),
  related_task_ids: z.array(z.string().min(1)).default([]),
});

export const CreateDependencyInput = z.object({
  task_id: z.string().min(1),
  depends_on_task_id: z.string().min(1),
});
