import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runAnalysis } from "../../src/analysis/runner.js";
import { createApp } from "../../src/api/app.js";
import { startTestDb } from "../db.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  db = await startTestDb();
  pool = db.pool;
  app = createApp(pool);
}, 120_000);

afterAll(async () => {
  await db?.stop();
});

const T = new Date("2026-09-26T12:00:00Z");
const at = (hours: number) => new Date(T.getTime() + hours * 3_600_000);

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let n = 0;

// PC-1 has a commit on its branch (in progress), PC-2 a merged PR (complete),
// PC-3 has work too but its status was set by a person. All three start
// not_started and are linked by task key, which is strong evidence.
async function seed() {
  const id = ++n;
  const s = { project: `proj_${id}`, repo: `repo_${id}`, member: `mem_${id}`, t1: `t1_${id}`, t2: `t2_${id}`, t3: `t3_${id}` };
  await pool.query(
    `insert into projects (project_id, name, task_key_prefix, created_by, next_task_number) values ($1, 'Pit Crew', 'PC', 'test', 4)`,
    [s.project],
  );
  await pool.query("insert into project_members (member_id, project_id, display_name) values ($1, $2, 'Divij')", [s.member, s.project]);
  await pool.query(
    `insert into repositories (repository_id, project_id, owner, name, full_name) values ($1, $2, 'BuildFest', 'project', 'BuildFest/project')`,
    [s.repo, s.project],
  );
  await pool.query(
    `insert into tasks (task_id, task_key, project_id, title, plan_status_set_by) values
       ($2, 'PC-1', $1, 'Auth', null), ($3, 'PC-2', $1, 'Dashboard', null), ($4, 'PC-3', $1, 'Exports', 'team')`,
    [s.project, s.t1, s.t2, s.t3],
  );
  await addEvent(s, `e_c1_${id}`, "commit", at(-3), { branch: "pc-1-auth", commit: { sha: "a1", message: "auth routes" } });
  await addEvent(s, `e_c2_${id}`, "commit", at(-3), { branch: "pc-2-dash", commit: { sha: "b1", message: "dashboard" } });
  await addEvent(s, `e_m2_${id}`, "pull_request_merged", at(-2), {
    branch: "pc-2-dash",
    pull_request: { number: 12, title: "Dashboard", state: "merged", head_branch: "pc-2-dash", base_branch: "main", merged: true },
  });
  await addEvent(s, `e_c3_${id}`, "commit", at(-3), { branch: "pc-3-exports", commit: { sha: "c1", message: "exports" } });
  return s;
}

async function addEvent(
  s: { project: string; repo: string },
  eventId: string,
  type: string,
  occurred: Date,
  fields: { branch?: string; commit?: object; pull_request?: object },
) {
  await pool.query(
    `insert into github_events
       (event_id, project_id, repository_id, source, external_event_id, event_type, occurred_at, branch, commit, pull_request, changed_files)
     values ($1, $2, $3, 'backfill', $1, $4, $5, $6, $7, $8, '{src/a.ts}')`,
    [eventId, s.project, s.repo, type, occurred, fields.branch ?? null,
     fields.commit ? JSON.stringify(fields.commit) : null, fields.pull_request ? JSON.stringify(fields.pull_request) : null],
  );
}

async function statuses(project: string) {
  const { rows } = await pool.query(
    "select task_key, plan_status, plan_status_set_by from tasks where project_id = $1 order by task_key",
    [project],
  );
  return rows;
}

describe("planning agent plan sync", () => {
  it("moves strongly evidenced tasks forward and records why", async () => {
    const s = await seed();
    const result = await runAnalysis(pool, null, s.project, T);
    expect(result.statusMoves).toBe(2);
    expect(await statuses(s.project)).toEqual([
      { task_key: "PC-1", plan_status: "in_progress", plan_status_set_by: "agent" },
      { task_key: "PC-2", plan_status: "complete", plan_status_set_by: "agent" },
      { task_key: "PC-3", plan_status: "not_started", plan_status_set_by: "team" },
    ]);

    const { rows: moves } = await pool.query(
      "select task_id, from_status, to_status, reason, evidence_event_ids from plan_status_moves where project_id = $1 order by task_id",
      [s.project],
    );
    expect(moves).toMatchObject([
      { task_id: s.t1, from_status: "not_started", to_status: "in_progress" },
      { task_id: s.t2, from_status: "not_started", to_status: "complete", reason: "PR #12 was merged", evidence_event_ids: [`e_m2_${n}`] },
    ]);
    // One timeline entry for the whole sync, naming the batch its moves share.
    const { rows: timeline } = await pool.query(
      "select title, summary, entity_type, entity_id, related_task_ids from timeline_items where project_id = $1 and kind = 'plan_change'",
      [s.project],
    );
    const { rows: batches } = await pool.query("select distinct batch_id from plan_status_moves where project_id = $1", [s.project]);
    expect(batches).toHaveLength(1);
    expect(timeline).toEqual([{
      title: "Planning agent updated 2 tasks",
      summary: "In progress: PC-1 · Complete: PC-2",
      entity_type: "plan_status_batches",
      entity_id: batches[0].batch_id,
      related_task_ids: [s.t1, s.t2],
    }]);

    // Signals see the moved plan: only the person-owned PC-3 still disagrees.
    const { rows: signals } = await pool.query(
      "select related_task_ids from health_signals where project_id = $1 and type = 'plan_state_disagreement'",
      [s.project],
    );
    expect(signals).toEqual([{ related_task_ids: [s.t3] }]);
    expect((await pool.query("select synced_at from plan_sync_state where project_id = $1", [s.project])).rows[0].synced_at)
      .toEqual(T);
  });

  it("waits for the sync interval unless forced", async () => {
    const s = await seed();
    await runAnalysis(pool, null, s.project, T);
    await addEvent(s, `e_m1_${n}`, "pull_request_merged", at(0.5), {
      branch: "pc-1-auth",
      pull_request: { number: 11, title: "Auth", state: "merged", head_branch: "pc-1-auth", base_branch: "main", merged: true },
    });

    expect((await runAnalysis(pool, null, s.project, at(1))).statusMoves).toBe(0);
    expect((await statuses(s.project))[0].plan_status).toBe("in_progress");

    expect((await runAnalysis(pool, null, s.project, at(3))).statusMoves).toBe(1);
    expect((await statuses(s.project))[0]).toMatchObject({ plan_status: "complete", plan_status_set_by: "agent" });

    const forced = await seed();
    await runAnalysis(pool, null, forced.project, T);
    await pool.query("update tasks set plan_status = 'not_started', plan_status_set_by = null where task_id = $1", [forced.t1]);
    expect((await runAnalysis(pool, null, forced.project, at(1), { forcePlanSync: true })).statusMoves).toBe(1);
  });

  it("undoes a move and hands the status back to the team", async () => {
    const s = await seed();
    await runAnalysis(pool, null, s.project, T);
    const list = await call("GET", `/projects/${s.project}/status-moves`);
    expect(list.status).toBe(200);
    const move = list.body.find((m: { task_id: string }) => m.task_id === s.t2);
    expect(move).toMatchObject({ from_status: "not_started", to_status: "complete", undone_at: null });

    const undo = await call("POST", `/projects/${s.project}/status-moves/${move.move_id}/undo`, { member_id: s.member });
    expect(undo.status).toBe(200);
    expect(undo.body).toMatchObject({ move_id: move.move_id, undone_by: s.member });
    expect((await statuses(s.project))[1]).toEqual({ task_key: "PC-2", plan_status: "not_started", plan_status_set_by: s.member });
    expect((await pool.query(
      "select title, actor from timeline_items where project_id = $1 and entity_type = 'plan_status_move_undo'",
      [s.project],
    )).rows).toEqual([{ title: "Undid agent move: PC-2 back to Not started", actor: s.member }]);

    expect((await call("POST", `/projects/${s.project}/status-moves/${move.move_id}/undo`, { member_id: s.member })).status).toBe(409);
    // The team owns PC-2's status now, so the next sync leaves it alone.
    expect((await runAnalysis(pool, null, s.project, at(4))).statusMoves).toBe(0);
  });

  it("refuses to undo once someone has changed the status, and validates input", async () => {
    const s = await seed();
    await runAnalysis(pool, null, s.project, T);
    const { rows: [move] } = await pool.query("select move_id from plan_status_moves where task_id = $1", [s.t1]);

    expect((await call("POST", `/projects/${s.project}/status-moves/${move.move_id}/undo`, { member_id: "mem_nobody" })).status).toBe(400);
    expect((await call("POST", `/projects/${s.project}/status-moves/mv_missing/undo`, { member_id: s.member })).status).toBe(404);
    expect((await call("GET", "/projects/proj_missing/status-moves")).status).toBe(404);

    expect((await call("PATCH", `/projects/${s.project}/tasks/${s.t1}`, { plan_status: "blocked" })).status).toBe(200);
    const refused = await call("POST", `/projects/${s.project}/status-moves/${move.move_id}/undo`, { member_id: s.member });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/PC-1's status changed/);
  });

  it("marks statuses people write as theirs", async () => {
    const s = await seed();
    await call("PATCH", `/projects/${s.project}/tasks/${s.t1}`, { title: "Auth API" });
    expect((await statuses(s.project))[0].plan_status_set_by).toBeNull();
    await call("PATCH", `/projects/${s.project}/tasks/${s.t1}`, { plan_status: "not_started" });
    expect((await statuses(s.project))[0].plan_status_set_by).toBe("team");

    const started = await call("POST", `/projects/${s.project}/tasks`, { title: "Started", plan_status: "in_progress" });
    const fresh = await call("POST", `/projects/${s.project}/tasks`, { title: "Fresh", plan_status: "not_started" });
    expect(started.body.plan_status_set_by).toBe("team");
    expect(fresh.body.plan_status_set_by).toBeNull();
  });

  it("folds per-move timeline entries from before batching into one per sync", async () => {
    const s = await seed();
    const created = "2026-09-27T09:00:00Z";
    await pool.query("alter table plan_status_moves alter column batch_id drop not null");
    try {
      for (const [move, task, to] of [["mv_a", s.t1, "in_progress"], ["mv_b", s.t2, "complete"]]) {
        await pool.query(
          `insert into plan_status_moves (move_id, project_id, task_id, from_status, to_status, reason, created_at)
           values ($1, $2, $3, 'not_started', $4, 'r', $5)`,
          [`${move}_${n}`, s.project, task, to, created],
        );
        await pool.query(
          `insert into timeline_items (item_id, project_id, occurred_at, kind, title, entity_type, entity_id)
           values ($1, $2, $3, 'plan_change', 'old', 'plan_status_moves', $4)`,
          [`tl_${move}_${n}`, s.project, created, `${move}_${n}`],
        );
      }
      await pool.query(readFileSync(new URL("../../../db/migrations/20260927150000_status_move_batches.sql", import.meta.url), "utf8"));
    } finally {
      await pool.query("alter table plan_status_moves alter column batch_id set not null");
    }
    const { rows } = await pool.query(
      "select title, summary, entity_type, entity_id from timeline_items where project_id = $1 and kind = 'plan_change'",
      [s.project],
    );
    expect(rows).toEqual([{
      title: "Planning agent updated 2 tasks",
      summary: "In progress: PC-1 · Complete: PC-2",
      entity_type: "plan_status_batches",
      entity_id: `mb_mv_a_${n}`,
    }]);
  });
});
