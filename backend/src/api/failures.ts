import type { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../db.js";
import { newId } from "../ids.js";
import { notFound, parseBody } from "./http.js";

const LIMIT = { default: 50, max: 200 };
const Category = z.enum(["internal_error", "build", "deploy", "merge_conflict", "other"]);

const ListFailuresQuery = z.object({
  category: Category.optional(),
  limit: z.coerce.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

const ReportFailure = z.object({
  category: Category,
  title: z.string().trim().min(1).max(200),
  detail: z.string().trim().max(4000).optional(),
  member_id: z.string().min(1),
});

// Logs an unhandled error from anywhere in the API, best-effort: never
// throws, never delays the response it's called from. `projectId` is
// whatever route param was in scope, or null for project-less routes
// (e.g. the webhook endpoint, or POST /projects itself).
export async function logInternalError(db: Db, projectId: string | null, err: unknown): Promise<void> {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  try {
    await db.query(
      `insert into reported_failures (failure_id, project_id, source, category, title, detail)
       values ($1, $2, 'system', 'internal_error', $3, $4)`,
      [newId("fail"), projectId, message.slice(0, 200), err instanceof Error ? (err.stack ?? message) : message],
    );
  } catch (loggingError) {
    console.error("could not record internal error", loggingError);
  }
}

// Not an AI call (ai_runs already covers those) and not something the
// running app ever sees on its own — a merge conflict, a local build or
// deploy failure. Both feed the same "Fails" view (contract §5.9/§6.3).
export function registerFailureRoutes(app: Hono, db: Db) {
  app.get("/projects/:projectId/failures", async (c) => {
    const q = ListFailuresQuery.parse(c.req.query());
    const projectId = c.req.param("projectId");
    const { rowCount } = await db.query("select 1 from projects where project_id = $1", [projectId]);
    if (!rowCount) notFound("project");

    const limit = Math.min(q.limit ?? LIMIT.default, LIMIT.max);
    const params: unknown[] = [projectId];
    const where = ["project_id = $1"];
    if (q.category) {
      params.push(q.category);
      where.push(`category = $${params.length}`);
    }
    if (q.cursor) {
      params.push(q.cursor);
      where.push(
        `(created_at, failure_id) < (select created_at, failure_id from reported_failures
                                      where project_id = $1 and failure_id = $${params.length})`,
      );
    }
    params.push(limit + 1);
    const { rows } = await db.query(
      `select failure_id, project_id, source, category, title, detail, reported_by, created_at
         from reported_failures
        where ${where.join(" and ")}
        order by created_at desc, failure_id desc
        limit $${params.length}`,
      params,
    );
    const items = rows.slice(0, limit);
    return c.json({ items, next_cursor: rows.length > limit ? items[items.length - 1].failure_id : null });
  });

  app.post("/projects/:projectId/failures", async (c) => {
    const input = await parseBody(c, ReportFailure);
    const projectId = c.req.param("projectId");
    const { rowCount: isMember } = await db.query(
      "select 1 from project_members where project_id = $1 and member_id = $2",
      [projectId, input.member_id],
    );
    if (!isMember) {
      const { rowCount: exists } = await db.query("select 1 from projects where project_id = $1", [projectId]);
      if (!exists) notFound("project");
      return c.json({ error: "member_id is not a member of this project" }, 400);
    }
    const { rows: [row] } = await db.query(
      `insert into reported_failures (failure_id, project_id, source, category, title, detail, reported_by)
       values ($1, $2, 'manual', $3, $4, $5, $6) returning *`,
      [newId("fail"), projectId, input.category, input.title, input.detail ?? null, input.member_id],
    );
    return c.json(row, 201);
  });
}
