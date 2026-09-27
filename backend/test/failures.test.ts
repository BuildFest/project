import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import { logInternalError } from "../src/api/failures.js";
import { startTestDb } from "./db.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  process.env.GITHUB_WEBHOOK_SECRET = "failures-secret";
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

async function project() {
  const ws = (await call("POST", "/projects", {
    name: "Failures", task_key_prefix: "FL", members: [{ display_name: "Pranshul", github_login: "Pranshul-13" }],
  })).body;
  return { projectId: ws.project.project_id as string, memberId: ws.members[0].member_id as string };
}

describe("POST /projects/:projectId/failures", () => {
  it("logs a manual failure and 400s a non-member", async () => {
    const { projectId, memberId } = await project();
    const res = await call("POST", `/projects/${projectId}/failures`, {
      category: "merge_conflict", title: "ActivityTimeline.tsx: dueling Promise.all edits", detail: "Resolved by hand.", member_id: memberId,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      source: "manual", category: "merge_conflict", title: "ActivityTimeline.tsx: dueling Promise.all edits", reported_by: memberId,
    });

    expect((await call("POST", `/projects/${projectId}/failures`, {
      category: "build", title: "x", member_id: "mem_nope",
    })).status).toBe(400);
  });

  it("rejects an unknown category and 404s an unknown project", async () => {
    const { projectId, memberId } = await project();
    expect((await call("POST", `/projects/${projectId}/failures`, {
      category: "vibes", title: "x", member_id: memberId,
    })).status).toBe(400);
    expect((await call("POST", "/projects/proj_nope/failures", {
      category: "build", title: "x", member_id: memberId,
    })).status).toBe(404);
  });
});

describe("GET /projects/:projectId/failures", () => {
  it("lists newest first, filters by category, and pages with a cursor", async () => {
    const { projectId, memberId } = await project();
    const post = (category: string, title: string) => call("POST", `/projects/${projectId}/failures`, { category, title, member_id: memberId });
    const build = (await post("build", "tsc failed")).body;
    const deploy = (await post("deploy", "Railway build failed")).body;
    const other = (await post("other", "unrelated")).body;

    const all = (await call("GET", `/projects/${projectId}/failures`)).body;
    expect(all.items.map((f: { failure_id: string }) => f.failure_id)).toEqual([
      other.failure_id, deploy.failure_id, build.failure_id, // newest first
    ]);

    const filtered = (await call("GET", `/projects/${projectId}/failures?category=deploy`)).body;
    expect(filtered.items.map((f: { failure_id: string }) => f.failure_id)).toEqual([deploy.failure_id]);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await call("GET", `/projects/${projectId}/failures?limit=1${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.body.items.map((f: { failure_id: string }) => f.failure_id));
      cursor = page.body.next_cursor;
    } while (cursor);
    expect(seen).toEqual(all.items.map((f: { failure_id: string }) => f.failure_id));

    expect((await call("GET", "/projects/proj_nope/failures")).status).toBe(404);
  });
});

describe("logInternalError", () => {
  it("records a system failure without throwing", async () => {
    const { projectId } = await project();
    await logInternalError(db.pool, projectId, new Error("DB pool exhausted"));

    const { items } = (await call("GET", `/projects/${projectId}/failures`)).body;
    expect(items).toMatchObject([{ source: "system", category: "internal_error", title: "Error: DB pool exhausted" }]);

    // A broken database must not break the original error response; the
    // logger catches its own storage failure and resolves cleanly.
    await expect(logInternalError(
      { query: () => Promise.reject(new Error("down")) } as never,
      projectId,
      new Error("x"),
    )).resolves.toBeUndefined();
  });

  it("is wired to the unhandled API error fallback", async () => {
    const { projectId } = await project();
    app.get("/projects/:projectId/test-internal-error", () => {
      throw new Error("test route exploded");
    });

    expect((await call("GET", `/projects/${projectId}/test-internal-error`)).status).toBe(500);
    await expect.poll(async () => {
      const { items } = (await call("GET", `/projects/${projectId}/failures`)).body;
      return items.some((failure: { title: string }) => failure.title === "Error: test route exploded");
    }).toBe(true);
  });
});
