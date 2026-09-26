import type { Hono } from "hono";
import type { Db } from "../db.js";
import { notFound } from "./http.js";
import { ListEventsQuery } from "./inputs.js";

const BROWSE_LIMIT = { default: 50, max: 200 };
const CONSUME_LIMIT = { default: 200, max: 500 };

// pg returns bigint as a string; seq is well within Number's safe range.
const withNumericSeq = (row: Record<string, unknown>) => ({ ...row, seq: Number(row.seq) });

export function registerEventRoutes(app: Hono, db: Db) {
  /**
   * Two modes over the same filters:
   *   browse  (default)     newest first, ?cursor=  → { items, next_cursor }      (frontend)
   *   consume (?after_seq=) seq ascending           → { items, next_after_seq, has_more } (Person 2)
   */
  app.get("/projects/:projectId/events", async (c) => {
    const q = ListEventsQuery.parse(c.req.query());
    const projectId = c.req.param("projectId");

    const { rowCount } = await db.query("select 1 from projects where project_id = $1", [projectId]);
    if (!rowCount) notFound("project");

    const params: unknown[] = [projectId];
    const where = ["e.project_id = $1"];
    if (q.branch) {
      params.push(q.branch);
      where.push(`e.branch = $${params.length}`);
    }
    if (q.task_id) {
      params.push(q.task_id);
      where.push(
        `exists (select 1 from event_task_links l
                  where l.project_id = e.project_id and l.event_id = e.event_id
                    and l.task_id = $${params.length} and l.status <> 'rejected')`,
      );
    }

    if (q.after_seq !== undefined) {
      const limit = Math.min(q.limit ?? CONSUME_LIMIT.default, CONSUME_LIMIT.max);
      params.push(q.after_seq, limit + 1);
      const { rows } = await db.query(
        `select e.* from github_events e
          where ${where.join(" and ")} and e.seq > $${params.length - 1}
          order by e.seq limit $${params.length}`,
        params,
      );
      const items = rows.slice(0, limit).map(withNumericSeq);
      return c.json({
        items,
        next_after_seq: items.length ? items[items.length - 1].seq : q.after_seq,
        has_more: rows.length > limit,
      });
    }

    // Keyset on (occurred_at, seq), anchored on the cursor row's own values so
    // no timestamp ever round-trips through JS (Date drops microseconds).
    const limit = Math.min(q.limit ?? BROWSE_LIMIT.default, BROWSE_LIMIT.max);
    if (q.cursor) {
      params.push(q.cursor);
      where.push(
        `(e.occurred_at, e.seq) < (select occurred_at, seq from github_events
                                    where project_id = $1 and seq = $${params.length})`,
      );
    }
    params.push(limit + 1);
    const { rows } = await db.query(
      `select e.* from github_events e
        where ${where.join(" and ")}
        order by e.occurred_at desc, e.seq desc limit $${params.length}`,
      params,
    );
    const items = rows.slice(0, limit).map(withNumericSeq);
    const hasMore = rows.length > limit;
    return c.json({ items, next_cursor: hasMore ? String(items[items.length - 1].seq) : null });
  });
}
