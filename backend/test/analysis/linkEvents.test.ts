import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CompletionRequest, CompletionResult } from "../../src/ai/client.js";
import type { ModelRouter } from "../../src/ai/router.js";
import { linkProjectEvents } from "../../src/analysis/linkEvents.js";
import { runAnalysis } from "../../src/analysis/runner.js";
import { startTestDb } from "../db.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
let pool: pg.Pool;

beforeAll(async () => {
  db = await startTestDb();
  pool = db.pool;
}, 120_000);

afterAll(async () => {
  await db?.stop();
});

let n = 0;
async function seedProject() {
  const p = `proj_${++n}`;
  await pool.query(
    `insert into projects (project_id, name, task_key_prefix, created_by) values ($1, 'Pit Crew', 'PC', 'test')`,
    [p],
  );
  await pool.query(
    `insert into repositories (repository_id, project_id, owner, name, full_name)
     values ($1, $2, 'BuildFest', 'project', 'BuildFest/project')`,
    [`repo_${n}`, p],
  );
  await pool.query(
    `insert into tasks (task_id, task_key, project_id, title) values
       ($2, 'PC-1', $1, 'Authentication API'), ($3, 'PC-2', $1, 'Dashboard')`,
    [p, `task_auth_${n}`, `task_dash_${n}`],
  );
  return { project: p, repo: `repo_${n}`, auth: `task_auth_${n}`, dash: `task_dash_${n}` };
}

async function addCommit(project: string, repo: string, id: string, branch: string, message: string) {
  await pool.query(
    `insert into github_events
       (event_id, project_id, repository_id, source, external_event_id, event_type, occurred_at, branch, commit, changed_files)
     values ($1, $2, $3, 'backfill', $1, 'commit', now(), $4, $5, '{src/a.ts}')`,
    [id, project, repo, branch, JSON.stringify({ sha: id, message, author: "dev", url: "" })],
  );
}

async function linksFor(project: string) {
  const { rows } = await pool.query(
    `select event_id, task_id, method, status, confidence, is_primary, reason
       from event_task_links where project_id = $1 order by event_id`,
    [project],
  );
  return rows;
}

function routerAnswering(taskId: () => string | null, confidence = 0.9): ModelRouter & { calls: number } {
  const router = {
    calls: 0,
    available: () => true,
    async run(_job: string, request: CompletionRequest): Promise<CompletionResult> {
      router.calls++;
      const groups = JSON.parse(request.messages[0].content).groups as { group: string }[];
      const links = groups.map((g) => ({ group: g.group, task_id: taskId(), confidence, reason: "looks like auth" }));
      return { text: JSON.stringify({ links }), provider: "groq", model: "m", inputTokens: 1, outputTokens: 1 };
    },
  };
  return router;
}

describe("linkProjectEvents", () => {
  let s: Awaited<ReturnType<typeof seedProject>>;
  beforeEach(async () => {
    s = await seedProject();
  });

  it("links by task key without the model", async () => {
    await addCommit(s.project, s.repo, `evt_a${n}`, "pc-2-dashboard", "cards");
    const result = await linkProjectEvents(pool, null, s.project);
    expect(result).toEqual({ keyOrInherited: 1, ai: 0, aiError: null });
    expect(await linksFor(s.project)).toMatchObject([
      { task_id: s.dash, method: "task_key", status: "confirmed", is_primary: true, reason: null },
    ]);
  });

  it("asks the model for unlinked branches and stores its reason", async () => {
    await addCommit(s.project, s.repo, `evt_b${n}`, "jwt-refresh", "Implement JWT refresh");
    const router = routerAnswering(() => s.auth, 0.86);
    const result = await linkProjectEvents(pool, router, s.project);
    expect(result).toEqual({ keyOrInherited: 0, ai: 1, aiError: null });
    const [link] = await linksFor(s.project);
    expect(link).toMatchObject({ task_id: s.auth, method: "llm", status: "suggested", reason: "looks like auth" });
    expect(link.confidence).toBeCloseTo(0.86);
  });

  it("reuses the branch's link for later commits instead of calling the model again", async () => {
    await addCommit(s.project, s.repo, `evt_c${n}`, "jwt-refresh", "first");
    const router = routerAnswering(() => s.auth);
    await linkProjectEvents(pool, router, s.project);
    await addCommit(s.project, s.repo, `evt_d${n}`, "jwt-refresh", "second");
    const result = await linkProjectEvents(pool, router, s.project);
    expect(result.keyOrInherited).toBe(1);
    expect(router.calls).toBe(1);
  });

  it("does not bring back a link a teammate rejected", async () => {
    await addCommit(s.project, s.repo, `evt_e${n}`, "jwt-refresh", "first");
    await linkProjectEvents(pool, routerAnswering(() => s.auth), s.project);
    await pool.query(`update event_task_links set status = 'rejected' where project_id = $1`, [s.project]);
    const result = await linkProjectEvents(pool, routerAnswering(() => s.auth), s.project);
    expect(result.ai).toBe(0);
    expect(await linksFor(s.project)).toMatchObject([{ status: "rejected" }]);
  });

  it("keeps rule links and reports why when the model is unavailable", async () => {
    await addCommit(s.project, s.repo, `evt_f${n}`, "pc-1-auth", "routes");
    await addCommit(s.project, s.repo, `evt_g${n}`, "misc", "stuff");
    const result = await linkProjectEvents(pool, null, s.project);
    expect(result).toEqual({ keyOrInherited: 1, ai: 0, aiError: "no model configured for link_suggestion" });
  });

  it("keeps rule links when the model call fails", async () => {
    await addCommit(s.project, s.repo, `evt_h${n}`, "pc-1-auth", "routes");
    await addCommit(s.project, s.repo, `evt_i${n}`, "misc", "stuff");
    const failing: ModelRouter = {
      available: () => true,
      run: async () => {
        throw new Error("groq down");
      },
    };
    const result = await linkProjectEvents(pool, failing, s.project);
    expect(result).toEqual({ keyOrInherited: 1, ai: 0, aiError: "groq down" });
  });
});

async function seedRunnerProject() {
  const s = await seedProject();
  await pool.query("update tasks set archived=true where task_id=$1", [s.dash]);
  await pool.query("update tasks set plan_status='not_started', created_at='2026-09-26T10:00:00Z' where task_id=$1", [s.auth]);
  for (const [id, branch, hour] of [[`run_a${n}`, "pc-1-work", 11], [`run_b${n}`, "unkeyed-work", 12]] as const) {
    await pool.query(`insert into github_events
      (event_id,project_id,repository_id,source,external_event_id,event_type,occurred_at,branch,commit,changed_files)
      values ($1,$2,$3,'backfill',$1,'push',$4,$5,$6,'{src/shared.ts}')`,
      [id, s.project, s.repo, `2026-09-26T${hour}:00:00Z`, branch, { sha: id, message: "work" }]);
    await pool.query(`insert into branch_states (repository_id,branch,project_id,status,head_sha,last_activity_at)
                      values ($1,$2,$3,'active',$4,$5)`,
      [s.repo, branch, s.project, id, `2026-09-26T${hour}:00:00Z`]);
  }
  return s;
}

describe("runAnalysis", () => {
  it("serializes concurrent runs for the same project", async () => {
    const s = await seedRunnerProject();
    const runs = await Promise.all([
      runAnalysis(pool, null, s.project, new Date("2026-09-26T13:00:00Z")),
      runAnalysis(pool, null, s.project, new Date("2026-09-26T13:00:00Z")),
    ]);
    expect(runs.reduce((sum, run) => sum + run.states, 0)).toBe(1);
    expect(runs.reduce((sum, run) => sum + run.collisions, 0)).toBe(1);
    expect((await pool.query("select count(*)::int n from derived_task_states where project_id=$1", [s.project])).rows[0].n).toBe(1);
  });

  it("persists the complete pipeline and skips unchanged rows", async () => {
    const s = await seedRunnerProject();
    expect(await runAnalysis(pool, null, s.project, new Date("2026-09-26T13:00:00Z"))).toMatchObject({
      branches: 2, states: 1, signals: 1, collisions: 1, aiApplied: false,
    });
    const { rows: branches } = await pool.query("select branch,task_id,changed_files,updated_at from branch_states where project_id=$1 order by branch", [s.project]);
    expect(branches).toMatchObject([
      { branch: "pc-1-work", task_id: s.auth, changed_files: ["src/shared.ts"] },
      { branch: "unkeyed-work", task_id: null, changed_files: ["src/shared.ts"] },
    ]);
    expect((await pool.query("select computed_status,version from derived_task_states where task_id=$1", [s.auth])).rows[0]).toMatchObject({ computed_status: "in_progress", version: 1 });
    expect((await pool.query("select count(*)::int n from collisions where project_id=$1 and status='active'", [s.project])).rows[0].n).toBe(1);

    expect(await runAnalysis(pool, null, s.project, new Date("2026-09-26T13:01:00Z"))).toMatchObject({ branches: 0, states: 0, signals: 0, collisions: 0 });
    expect((await pool.query("select version from derived_task_states where task_id=$1", [s.auth])).rows[0].version).toBe(1);
    expect((await pool.query("select branch,updated_at from branch_states where project_id=$1 order by branch", [s.project])).rows)
      .toEqual(branches.map(({ branch, updated_at }) => ({ branch, updated_at })));
    expect((await pool.query("select count(*)::int n from timeline_items where project_id=$1", [s.project])).rows[0].n).toBe(2);
  });

  it("preserves dismissed conditions until they clear", async () => {
    const s = await seedRunnerProject();
    await runAnalysis(pool, null, s.project, new Date("2026-09-26T13:00:00Z"));
    await pool.query("update health_signals set status='dismissed' where project_id=$1", [s.project]);
    await pool.query("update collisions set status='dismissed' where project_id=$1", [s.project]);
    await runAnalysis(pool, null, s.project, new Date("2026-09-26T13:01:00Z"));
    expect((await pool.query("select distinct status from health_signals where project_id=$1", [s.project])).rows).toEqual([{ status: "dismissed" }]);
    expect((await pool.query("select distinct status from collisions where project_id=$1", [s.project])).rows).toEqual([{ status: "dismissed" }]);

    await pool.query("update tasks set plan_status='in_progress' where task_id=$1", [s.auth]);
    await pool.query("update branch_states set status='merged' where project_id=$1 and branch='unkeyed-work'", [s.project]);
    await runAnalysis(pool, null, s.project, new Date("2026-09-26T13:02:00Z"));
    expect((await pool.query("select distinct status from health_signals where project_id=$1", [s.project])).rows).toEqual([{ status: "resolved" }]);
    expect((await pool.query("select distinct status from collisions where project_id=$1", [s.project])).rows).toEqual([{ status: "resolved" }]);
  });
});
