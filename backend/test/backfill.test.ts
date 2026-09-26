import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/api/app.js";
import { githubList } from "../src/github.js";
import { runBackfill } from "../src/ingestion/backfill.js";
import { startTestDb } from "./db.js";

const SECRET = "backfill-secret";
const sha = (c: string) => c.repeat(40);

let db: Awaited<ReturnType<typeof startTestDb>>;
let app: ReturnType<typeof createApp>;

// ---- a fake GitHub, reconfigured per test ----------------------------------

let nextRepo = 5000;
const routes = new Map<string, () => Response>();
const calls: string[] = [];

function commit(s: string, date: string, message = `commit ${s[0]}`) {
  return {
    sha: s, html_url: `https://github.com/c/${s}`, author: { login: "dev" },
    commit: { message, author: { name: "Dev" }, committer: { date } },
  };
}

function pull(number: number, head: string, headSha: string, opts: { merged?: string; closed?: string } = {}) {
  return {
    number, title: `PC-${number}: work`, state: opts.closed || opts.merged ? "closed" : "open",
    html_url: `https://github.com/pr/${number}`, user: { login: "dev" },
    created_at: "2026-09-20T10:00:00Z", updated_at: "2026-09-21T10:00:00Z",
    closed_at: opts.merged ?? opts.closed ?? null, merged_at: opts.merged ?? null,
    head: { ref: head, sha: headSha }, base: { ref: "main" },
  };
}

/** A repo with: PR 1 merged (branch deleted after), PR 2 open on feat-b, branches main + feat-b. */
function fakeRepo(fullName: string, githubId: number) {
  const r = (path: string, body: unknown) => routes.set(`https://api.github.com/repos/${fullName}${path}`, () => Response.json(body));
  r("", { id: githubId, name: fullName.split("/")[1], full_name: fullName, default_branch: "main", owner: { login: "acme" } });
  r("/pulls?state=all&sort=created&direction=asc&per_page=100", [
    pull(1, "feat-a", sha("a"), { merged: "2026-09-21T12:00:00Z" }),
    pull(2, "feat-b", sha("b")),
  ]);
  r("/branches?per_page=100", [{ name: "main", commit: { sha: sha("m") } }, { name: "feat-b", commit: { sha: sha("b") } }]);
  r(`/compare/main...${sha("b")}`, {
    commits: [commit(sha("9"), "2026-09-22T09:00:00Z"), commit(sha("b"), "2026-09-22T10:00:00Z")],
    files: [{ filename: "src/x.ts" }, { filename: "src/y.ts" }],
  });
  r(`/commits/${sha("m")}`, commit(sha("m"), "2026-09-19T08:00:00Z", "initial"));
}

beforeAll(async () => {
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  process.env.PUBLIC_BASE_URL = "https://pitcrew.example";
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    return routes.get(url)?.() ?? new Response("{}", { status: 404 });
  });
  db = await startTestDb();
  app = createApp(db.pool);
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await db?.stop();
});

beforeEach(() => {
  calls.length = 0;
});

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function sendWebhook(event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  await app.request("/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-github-event": event, "x-github-delivery": randomUUID(),
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    },
    body,
  });
}

async function connectedRepo() {
  const githubId = nextRepo++;
  const fullName = `acme/demo-${githubId}`;
  fakeRepo(fullName, githubId);
  const project = (await call("POST", "/projects", { name: "Backfill", task_key_prefix: "PC" })).body;
  const projectId = project.project.project_id as string;
  const res = await call("POST", `/projects/${projectId}/repositories`, { full_name: fullName });
  return { projectId, repositoryId: res.body.repository.repository_id as string, githubId, fullName };
}

async function events(repositoryId: string) {
  const { rows } = await db.pool.query(
    "select event_type, branch, source, external_event_id from github_events where repository_id = $1 order by seq",
    [repositoryId],
  );
  return rows;
}

async function branches(repositoryId: string) {
  const { rows } = await db.pool.query(
    "select branch, status, head_sha, open_pr_number, changed_files from branch_states where repository_id = $1 order by branch",
    [repositoryId],
  );
  return Object.fromEntries(rows.map((r) => [r.branch, r]));
}

// ---------------------------------------------------------------------------

describe("githubList", () => {
  it("follows Link rel=next across pages", async () => {
    routes.set("https://api.github.com/x?per_page=100", () =>
      Response.json([1, 2], { headers: { link: '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=2>; rel="last"' } }),
    );
    routes.set("https://api.github.com/x?page=2", () => Response.json([3]));
    expect(await githubList("/x")).toEqual([1, 2, 3]);
  });
});

describe("runBackfill", () => {
  it("imports PRs, branches, branch-unique commits and changed files", async () => {
    const { repositoryId } = await connectedRepo();
    const stats = await runBackfill(db.pool, repositoryId);
    expect(stats).toMatchObject({ prs_listed: 2, branches_listed: 2, failures: [] });

    const evs = await events(repositoryId);
    expect(evs.every((e) => e.source === "backfill")).toBe(true);
    expect(evs.map((e) => `${e.event_type}:${e.branch}`)).toEqual([
      "pull_request_opened:feat-a",
      "pull_request_merged:feat-a",
      "pull_request_opened:feat-b",
      "branch_created:main",
      "branch_created:feat-b",
      "commit:feat-b",
      "commit:feat-b",
    ]);

    const b = await branches(repositoryId);
    expect(b.main).toMatchObject({ status: "active", head_sha: sha("m"), changed_files: [] });
    expect(b["feat-b"]).toMatchObject({ status: "active", head_sha: sha("b"), open_pr_number: 2, changed_files: ["src/x.ts", "src/y.ts"] });
    // Merged then deleted: stays "merged", never reported as a fresh deletion.
    expect(b["feat-a"]).toMatchObject({ status: "merged" });

    const { rows } = await db.pool.query("select last_backfill_at from repositories where repository_id = $1", [repositoryId]);
    expect(rows[0].last_backfill_at).not.toBeNull();
  });

  it("is idempotent: a second run inserts nothing", async () => {
    const { repositoryId } = await connectedRepo();
    await runBackfill(db.pool, repositoryId);
    const before = (await events(repositoryId)).length;
    expect((await runBackfill(db.pool, repositoryId)).events_inserted).toBe(0);
    expect((await events(repositoryId)).length).toBe(before);
  });

  it("doesn't duplicate a PR the webhook already saw with an older head", async () => {
    const { repositoryId, githubId } = await connectedRepo();
    await sendWebhook("pull_request", {
      action: "opened", number: 2, sender: { login: "dev" }, repository: { id: githubId },
      pull_request: { ...pull(2, "feat-b", sha("7")), merged: false },
    });
    await runBackfill(db.pool, repositoryId);
    const opened = (await events(repositoryId)).filter((e) => e.event_type === "pull_request_opened" && e.branch === "feat-b");
    expect(opened).toHaveLength(1);
    expect(opened[0].source).toBe("webhook");
  });

  it("catches up a head that moved unseen, and deletes branches GitHub no longer lists", async () => {
    const { repositoryId, githubId } = await connectedRepo();
    const push = (branch: string, after: string, created: boolean) =>
      sendWebhook("push", {
        ref: `refs/heads/${branch}`, before: "0".repeat(40), after, created, deleted: false, commits: [], head_commit: null,
        sender: { login: "dev" }, repository: { id: githubId, pushed_at: 1_790_000_000 },
      });
    await push("feat-b", sha("7"), true); // webhook saw feat-b at an older head
    await push("old-spike", sha("5"), true); // later deleted on GitHub while we weren't listening

    const stats = await runBackfill(db.pool, repositoryId);
    expect(stats.branches_deleted).toBe(1);
    const b = await branches(repositoryId);
    expect(b["feat-b"]).toMatchObject({ status: "active", head_sha: sha("b"), changed_files: ["src/x.ts", "src/y.ts"] });
    expect(b["old-spike"]).toMatchObject({ status: "deleted" });
    const catchUp = (await events(repositoryId)).find((e) => e.event_type === "push" && e.source === "backfill");
    expect(catchUp).toMatchObject({ branch: "feat-b", external_event_id: `refs/heads/feat-b:${sha("b")}` });
  });
});

describe("backfill status on the repository", () => {
  async function repoRow(repositoryId: string) {
    const { rows } = await db.pool.query(
      "select backfill_status, backfill_error, last_backfill_at from repositories where repository_id = $1",
      [repositoryId],
    );
    return rows[0];
  }

  it("records success", async () => {
    const { repositoryId } = await connectedRepo();
    await runBackfill(db.pool, repositoryId);
    expect(await repoRow(repositoryId)).toMatchObject({ backfill_status: "succeeded", backfill_error: null });
  });

  it("keeps importing branches when pull requests can't be listed, and says why", async () => {
    const { repositoryId, fullName } = await connectedRepo();
    routes.set(`https://api.github.com/repos/${fullName}/pulls?state=all&sort=created&direction=asc&per_page=100`, () =>
      new Response("{}", { status: 403 }),
    );
    const stats = await runBackfill(db.pool, repositoryId);
    expect(stats.branches_listed).toBe(2);
    expect(await branches(repositoryId)).toHaveProperty("feat-b.changed_files", ["src/x.ts", "src/y.ts"]);
    const row = await repoRow(repositoryId);
    expect(row.backfill_status).toBe("partial");
    expect(row.backfill_error).toMatch(/pull requests: GitHub returned 403.*Pull requests: Read/);
    expect(row.last_backfill_at).not.toBeNull();
  });

  it("marks the run failed when the repository itself can't be read", async () => {
    const { repositoryId, fullName } = await connectedRepo();
    routes.delete(`https://api.github.com/repos/${fullName}`);
    await expect(runBackfill(db.pool, repositoryId)).rejects.toThrow(/404/);
    expect(await repoRow(repositoryId)).toMatchObject({ backfill_status: "failed", last_backfill_at: null });
  });
});

describe("POST /projects/:projectId/repositories/:repositoryId/backfill", () => {
  it("starts a run in the background and 404s for another project's repo", async () => {
    const { projectId, repositoryId } = await connectedRepo();
    const res = await call("POST", `/projects/${projectId}/repositories/${repositoryId}/backfill`);
    expect(res.status).toBe(202);
    expect(res.body.started_at).toEqual(expect.any(String));
    await vi.waitFor(async () => {
      const { rows } = await db.pool.query("select last_backfill_at from repositories where repository_id = $1", [repositoryId]);
      expect(rows[0].last_backfill_at).not.toBeNull();
    });

    const other = await connectedRepo();
    expect((await call("POST", `/projects/${other.projectId}/repositories/${repositoryId}/backfill`)).status).toBe(404);
  });
});
