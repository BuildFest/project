import type { Hono } from "hono";
import { z } from "zod";
import type { Db } from "../db.js";
import { newId } from "../ids.js";
import { notFound, parseBody } from "./http.js";

const LIMIT = { default: 50, max: 100 };

const ListMessagesQuery = z.object({
  limit: z.coerce.number().int().min(1).optional(),
  cursor: z.string().min(1).optional(),
});

const SendMessageInput = z.object({
  member_id: z.string().min(1),
  body: z.string().trim().min(1).max(2000),
});

export function registerChatRoutes(app: Hono, db: Db) {
  app.get("/projects/:projectId/messages", async (c) => {
    const q = ListMessagesQuery.parse(c.req.query());
    const projectId = c.req.param("projectId");
    const { rowCount } = await db.query("select 1 from projects where project_id = $1", [projectId]);
    if (!rowCount) notFound("project");

    const limit = Math.min(q.limit ?? LIMIT.default, LIMIT.max);
    const params: unknown[] = [projectId];
    const where = ["project_id = $1"];
    if (q.cursor) {
      params.push(q.cursor);
      where.push(
        `(created_at, message_id) < (select created_at, message_id from project_messages
                                    where project_id = $1 and message_id = $${params.length})`,
      );
    }
    params.push(limit + 1);
    const { rows } = await db.query(
      `select message_id, project_id, sender_member_id, sender_display_name, body, created_at
         from project_messages
        where ${where.join(" and ")}
        order by created_at desc, message_id desc
        limit $${params.length}`,
      params,
    );
    const items = rows.slice(0, limit);
    return c.json({ items, next_cursor: rows.length > limit ? items[items.length - 1].message_id : null });
  });

  app.post("/projects/:projectId/messages", async (c) => {
    const input = await parseBody(c, SendMessageInput);
    const projectId = c.req.param("projectId");
    const { rows: members } = await db.query(
      "select display_name from project_members where project_id = $1 and member_id = $2",
      [projectId, input.member_id],
    );
    if (!members[0]) {
      const { rowCount: exists } = await db.query("select 1 from projects where project_id = $1", [projectId]);
      if (!exists) notFound("project");
      return c.json({ error: "member_id is not a member of this project" }, 400);
    }

    const { rows: [message] } = await db.query(
      `insert into project_messages
         (message_id, project_id, sender_member_id, sender_display_name, body)
       values ($1, $2, $3, $4, $5)
       returning message_id, project_id, sender_member_id, sender_display_name, body, created_at`,
      [newId("msg"), projectId, input.member_id, members[0].display_name, input.body],
    );
    return c.json(message, 201);
  });
}
