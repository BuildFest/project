import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.js";
import { withTransaction } from "../src/db.js";
import { recordEvents } from "../src/ingestion/record.js";
import { projectEventsToTimeline } from "../src/ingestion/timeline.js";
import { startTestDb } from "./db.js";

const SECRET = "timeline-secret";
const sha = (c: string) => c.repeat(40);

let db: Awaited<ReturnType<typeof startTestDb>>;
let app: ReturnType<typeof createApp>;
let nextGithubId = 7000;

beforeAll(async () => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  process.env.PUBLIC_BASE_URL = "https://pitcrew.example";
  // Fake GitHub repo lookup: acme/demo-<id> has GitHub id <id>.
  vi.stubGlobal("fetch", async (url: string) => {
    const fullName = url.replace("https://api.github.com/repos/", "");
    const id = Number(fullName.split("-").pop());
    return Response.json({ id, name: fullName.split("/")[1], full_name: fullName, default_branch: "main", owner: { login: "acme" } });
  });
  db = await startTestDb();
  app = createApp(db.pool);
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
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

async function sendWebhook(event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const res = await app.request("/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    },
    body,
  });
  expect(res.status).toBe(202);
}

async function setup() {
  const ws = (await call("POST", "/projects", {
    name: "Timeline",
    task_key_prefix: "PC",
    members: [{ display_name: "Pranshul", github_login: "Pranshul-13" }],
  })).body;
  const projectId = ws.project.project_id as string;
  const githubId = nextGithubId++;
  const repo = (await call("POST", `/projects/${projectId}/repositories`, { full_name: `acme/demo-${githubId}` })).body.repository;
  const task = (await call("POST", `/projects/${projectId}/tasks`, { title: "Ingestion" })).body;
  return {
    projectId,
    githubId,
    repositoryId: repo.repository_id as string,
    memberId: ws.members[0].member_id as string,
    taskId: task.task_id as string,
  };
}

function push(githubId: number, branch: string, after: string, commits: Array<{ id: string; message: string }>) {
  const full = commits.map((c) => ({
    ...c, timestamp: "2026-09-21T10:00:00Z", url: "u",
    author: { name: "P", username: "Pranshul-13" }, added: ["a.ts"], removed: [], modified: [],
  }));
  return sendWebhook("push", {
    ref: `refs/heads/${branch}`,
    before: "0".repeat(40),
    after,
    created: true,
    deleted: false,
    commits: full,
    head_commit: full.at(-1) ?? null,
    sender: { login: "Pranshul-13" },
    repository: { id: githubId, pushed_at: 1_790_000_000 },
  });
}

function prOpened(githubId: number, branch: string, number: number) {
  return sendWebhook("pull_request", {
    action: "opened",
    number,
    sender: { login: "Pranshul-13" },
    repository: { id: githubId },
    pull_request: {
      number, title: "PC-1: Webhook ingestion", state: "open", merged: false, html_url: "u",
      created_at: "2026-09-21T12:00:00Z", updated_at: "2026-09-21T12:00:00Z", closed_at: null, merged_at: null,
      head: { ref: branch, sha: sha("b") }, base: { ref: "main" },
    },
  });
}

async function timeline(projectId: string, query = "") {
  return (await call("GET", `/projects/${projectId}/timeline${query}`)).body;
}

describe("GitHub events on the timeline", () => {
  it("gives pushes, branches and PRs a row, keeping webhook commits nested", async () => {
    const { projectId, githubId } = await setup();
    await push(githubId, "PC-1-ingest", sha("b"), [
      { id: sha("a"), message: "PC-1: first" },
      { id: sha("b"), message: "PC-1: store deliveries\n\nlong body" },
    ]);
    await prOpened(githubId, "PC-1-ingest", 4);

    const { items } = await timeline(projectId);
    expect(items.every((i: any) => i.kind === "github_event" && i.entity_type === "github_events")).toBe(true);
    expect(items.map((i: any) => i.title).sort()).toEqual([
      "Pranshul-13 created branch PC-1-ingest",
      "Pranshul-13 opened PR #4: PC-1: Webhook ingestion",
      "Pranshul-13 pushed to PC-1-ingest",
    ]);
    // The push row summarizes its head commit (first line only); commits get no rows.
    expect(items.find((i: any) => i.title.includes("pushed")).summary).toBe("PC-1: store deliveries");
  });

  it("gives backfilled commits their own row, and catch-up is idempotent", async () => {
    const { projectId, repositoryId } = await setup();
    await withTransaction(db.pool, (tx) =>
      recordEvents(
        tx,
        { repository_id: repositoryId, project_id: projectId },
        [{
          event_type: "commit", external_event_id: sha("c"), actor: null, occurred_at: "2026-09-20T09:00:00Z", branch: "old",
          commit: { sha: sha("c"), message: "old work", author: "Dev", url: null }, pull_request: null, changed_files: [],
        }],
        "backfill",
        null,
      ),
    );
    expect((await timeline(projectId)).items.map((i: any) => i.title)).toEqual(["Dev committed to old"]);

    // Events stored before the projection existed: wipe their rows, then catch up twice.
    await db.pool.query("delete from timeline_items where project_id = $1", [projectId]);
    expect(await projectEventsToTimeline(db.pool, { projectId })).toBe(1);
    expect(await projectEventsToTimeline(db.pool, { projectId })).toBe(0);
    expect((await timeline(projectId)).items).toHaveLength(1);
  });

  it("pages newest first with a cursor that visits every item once", async () => {
    const { projectId, githubId } = await setup();
    for (const [i, c] of ["1", "2", "3", "4"].entries()) {
      await push(githubId, `b${i}`, sha(c), [{ id: sha(c), message: `m${i}` }]);
    }
    const all = (await timeline(projectId, "?limit=200")).items; // 4 pushes + 4 branch creations
    expect(all).toHaveLength(8);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: any = await timeline(projectId, `?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.items.map((i: any) => i.item_id));
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen).toEqual(all.map((i: any) => i.item_id));
  });

  it("filters project history to GitHub activity on one branch", async () => {
    const { projectId, githubId, memberId } = await setup();
    await push(githubId, "feature/auth", sha("e"), [{ id: sha("e"), message: "auth work" }]);
    await push(githubId, "feature/billing", sha("f"), [{ id: sha("f"), message: "billing work" }]);
    await call("POST", `/projects/${projectId}/decisions`, { title: "Project-wide decision", member_id: memberId });

    const { items } = await timeline(projectId, "?branch=feature%2Fauth");
    expect(items.map((item: any) => item.title).sort()).toEqual([
      "Pranshul-13 created branch feature/auth",
      "Pranshul-13 pushed to feature/auth",
    ]);
  });
});

describe("decisions", () => {
  it("records a decision, lists it, and puts it on the timeline", async () => {
    const { projectId, memberId, taskId } = await setup();
    const res = await call("POST", `/projects/${projectId}/decisions`, {
      title: "Process webhooks inline", body: "Hackathon scale; no worker.", member_id: memberId, related_task_ids: [taskId],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      title: "Process webhooks inline", decided_by: memberId, related_task_ids: [taskId], suggestion_id: null,
    });
    expect(res.body.decision_id).toMatch(/^dec_/);

    const list = (await call("GET", `/projects/${projectId}/decisions`)).body;
    expect(list.map((d: any) => d.decision_id)).toEqual([res.body.decision_id]);
    const [item] = (await timeline(projectId)).items;
    expect(item).toMatchObject({
      kind: "decision", title: "Decision: Process webhooks inline", entity_id: res.body.decision_id, related_task_ids: [taskId],
    });
  });

  it("rejects outsiders, foreign tasks and blank titles", async () => {
    const a = await setup();
    const b = await setup();
    const post = (body: object) => call("POST", `/projects/${a.projectId}/decisions`, { title: "x", member_id: a.memberId, ...body });
    expect((await post({ member_id: b.memberId })).status).toBe(400);
    expect((await post({ related_task_ids: [b.taskId] })).status).toBe(400);
    expect((await post({ title: " " })).status).toBe(400);
    expect((await call("GET", "/projects/proj_nope/decisions")).status).toBe(404);
  });
});

describe("GET /projects/:projectId/timeline?task_id=", () => {
  it("finds decisions about the task and GitHub items linked to it later", async () => {
    const { projectId, githubId, memberId, taskId } = await setup();
    await push(githubId, "PC-1-x", sha("d"), [{ id: sha("d"), message: "PC-1 work" }]);
    await call("POST", `/projects/${projectId}/decisions`, { title: "About PC-1", member_id: memberId, related_task_ids: [taskId] });
    await call("POST", `/projects/${projectId}/decisions`, { title: "Unrelated", member_id: memberId });

    // The linker attaches the push event to the task after ingestion.
    const { rows: [pushEvent] } = await db.pool.query(
      "select event_id from github_events where project_id = $1 and event_type = 'push'",
      [projectId],
    );
    await db.pool.query(
      `insert into event_task_links (link_id, project_id, event_id, task_id, method, confidence, status)
       values ($1, $2, $3, $4, 'task_key', 1, 'confirmed')`,
      [`link_${projectId}`, projectId, pushEvent.event_id, taskId],
    );

    const { items } = await timeline(projectId, `?task_id=${taskId}`);
    expect(items.map((i: any) => i.title).sort()).toEqual(["Decision: About PC-1", "Pranshul-13 pushed to PC-1-x"]);
    expect(items.every((i: any) => i.related_task_ids.includes(taskId))).toBe(true);
    expect((await call("GET", "/projects/proj_nope/timeline")).status).toBe(404);
  });
});
