import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import { startTestDb } from "./db.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  process.env.GITHUB_WEBHOOK_SECRET = "chat-secret";
  db = await startTestDb();
  app = createApp(db.pool);
}, 120_000);

afterAll(async () => {
  await db?.stop();
});

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function project(name = "Chat") {
  const ws = (await call("POST", "/projects", {
    name,
    task_key_prefix: name.slice(0, 2).toUpperCase(),
    members: [
      { display_name: "Alex", github_login: "alex" },
      { display_name: "Sam", github_login: "sam" },
    ],
  })).body;
  return {
    projectId: ws.project.project_id as string,
    alexId: ws.members[0].member_id as string,
    samId: ws.members[1].member_id as string,
  };
}

describe("project team chat", () => {
  it("lets project members exchange persistent messages", async () => {
    const { projectId, alexId, samId } = await project();
    const first = await call("POST", `/projects/${projectId}/messages`, { member_id: alexId, body: "  Ship the API first.  " });
    const second = await call("POST", `/projects/${projectId}/messages`, { member_id: samId, body: "I am on it." });

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ sender_member_id: alexId, sender_display_name: "Alex", body: "Ship the API first." });
    expect(second.status).toBe(201);

    const page = await call("GET", `/projects/${projectId}/messages`);
    expect(page.status).toBe(200);
    expect(page.body.items.map((message: { body: string }) => message.body)).toEqual(["I am on it.", "Ship the API first."]);
  });

  it("rejects non-members and keeps projects isolated", async () => {
    const one = await project("One");
    const two = await project("Two");
    expect((await call("POST", `/projects/${one.projectId}/messages`, {
      member_id: two.alexId,
      body: "wrong room",
    })).status).toBe(400);
    expect((await call("POST", "/projects/proj_nope/messages", {
      member_id: one.alexId,
      body: "nowhere",
    })).status).toBe(404);

    await call("POST", `/projects/${one.projectId}/messages`, { member_id: one.alexId, body: "only one" });
    expect((await call("GET", `/projects/${two.projectId}/messages`)).body.items).toEqual([]);
  });

  it("pages newest first and preserves a removed sender's display name", async () => {
    const { projectId, alexId } = await project("Paging");
    const sent = [];
    for (const body of ["one", "two", "three"]) {
      sent.push((await call("POST", `/projects/${projectId}/messages`, { member_id: alexId, body })).body);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await call("GET", `/projects/${projectId}/messages?limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.body.items.map((message: { body: string }) => message.body));
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(seen).toEqual(["three", "two", "one"]);

    expect((await call("DELETE", `/projects/${projectId}/members/${alexId}`)).status).toBe(204);
    const messages = (await call("GET", `/projects/${projectId}/messages`)).body.items;
    expect(messages[0]).toMatchObject({ sender_member_id: null, sender_display_name: "Alex", body: "three" });
  });

  it("validates message content and unknown projects", async () => {
    const { projectId, alexId } = await project("Validation");
    expect((await call("POST", `/projects/${projectId}/messages`, { member_id: alexId, body: "   " })).status).toBe(400);
    expect((await call("POST", `/projects/${projectId}/messages`, { member_id: alexId, body: "x".repeat(2001) })).status).toBe(400);
    expect((await call("GET", "/projects/proj_nope/messages")).status).toBe(404);
  });
});
