import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/api/app.js";
import { startTestDb } from "./db.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
let pool: pg.Pool;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  db = await startTestDb();
  pool = db.pool;
  app = createApp(pool);
}, 120_000);
afterAll(async () => db?.stop());

async function call(method: string, path: string, body?: unknown) {
  const res = await app.request(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}

let n = 0;
async function seed() {
  const x = ++n;
  const project = `proj_corr_${x}`;
  const member = `mem_corr_${x}`;
  const repo = `repo_corr_${x}`;
  const task = `task_corr_${x}`;
  const event = `event_corr_${x}`;
  await pool.query("insert into projects (project_id,name,task_key_prefix,created_by) values ($1,'P',$2,$3)", [project, `C${x}`, member]);
  await pool.query("insert into project_members (member_id,project_id,display_name) values ($1,$2,'Reviewer')", [member, project]);
  await pool.query("insert into repositories (repository_id,project_id,owner,name,full_name) values ($1,$2,'o','r',$3)", [repo, project, `o/r${x}`]);
  await pool.query("insert into tasks (task_id,task_key,project_id,title) values ($1,$2,$3,'Task')", [task, `C${x}-1`, project]);
  await pool.query("insert into derived_task_states (task_id,project_id,computed_status) values ($1,$2,'in_progress')", [task, project]);
  await pool.query(
    "insert into github_events (event_id,project_id,repository_id,source,external_event_id,event_type,occurred_at) values ($1,$2,$3,'backfill',$1,'commit',now())",
    [event, project, repo],
  );
  return { project, member, repo, task, event };
}

describe("corrections API", () => {
  it("sets and clears an optimistic task override", async () => {
    const s = await seed();
    const set = await call("PUT", `/projects/${s.project}/tasks/${s.task}/override`, {
      override_status: "complete", reason: "Verified in demo", member_id: s.member, version: 1,
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ computed_status: "in_progress", override_status: "complete", effective_status: "complete", version: 2 });

    const stale = await call("PUT", `/projects/${s.project}/tasks/${s.task}/override`, {
      override_status: "not_started", member_id: s.member, version: 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.current.version).toBe(2);

    const cleared = await call("DELETE", `/projects/${s.project}/tasks/${s.task}/override`);
    expect(cleared.body).toMatchObject({ override_status: null, effective_status: "in_progress", version: 3 });
  });

  it("creates a manual link and reviews an AI suggestion", async () => {
    const s = await seed();
    const manual = await call("POST", `/projects/${s.project}/links`, { event_id: s.event, task_id: s.task, member_id: s.member });
    expect(manual.status).toBe(201);
    expect(manual.body).toMatchObject({ method: "manual", status: "confirmed", confidence: 1, confirmed_by: s.member });

    const event2 = `${s.event}_2`;
    await pool.query(
      "insert into github_events (event_id,project_id,repository_id,source,external_event_id,event_type,occurred_at) values ($1,$2,$3,'backfill',$1,'commit',now())",
      [event2, s.project, s.repo],
    );
    const link = `link_suggest_${n}`;
    await pool.query(
      "insert into event_task_links (link_id,project_id,event_id,task_id,method,confidence,status) values ($1,$2,$3,$4,'llm',.9,'suggested')",
      [link, s.project, event2, s.task],
    );
    const reviewed = await call("PATCH", `/projects/${s.project}/links/${link}`, { status: "confirmed", member_id: s.member });
    expect(reviewed.body).toMatchObject({ status: "confirmed", confirmed_by: s.member });
  });

  it("dismisses active signals and collisions with audit data", async () => {
    const s = await seed();
    const signal = `signal_corr_${n}`;
    const collision = `collision_corr_${n}`;
    await pool.query(
      `insert into health_signals (signal_id,project_id,type,severity,title,explanation,fingerprint)
       values ($1,$2,'must_have_no_activity','warning','Idle','No activity',$1)`, [signal, s.project],
    );
    await pool.query(
      `insert into collisions (collision_id,project_id,repository_id,branch_a,branch_b,overlapping_files)
       values ($1,$2,$3,'a','b','{src/x.ts}')`, [collision, s.project, s.repo],
    );
    const sig = await call("PATCH", `/projects/${s.project}/signals/${signal}`, { status: "dismissed", member_id: s.member });
    const col = await call("PATCH", `/projects/${s.project}/collisions/${collision}`, { status: "dismissed", member_id: s.member });
    expect(sig.body).toMatchObject({ status: "dismissed", dismissed_by: s.member });
    expect(col.body).toMatchObject({ status: "dismissed", dismissed_by: s.member });
  });

  it("validates correction bodies and project scoping", async () => {
    const s = await seed();
    expect((await call("PUT", `/projects/${s.project}/tasks/${s.task}/override`, { override_status: "blocked" })).status).toBe(400);
    expect((await call("POST", "/projects/proj_other/links", { event_id: s.event, task_id: s.task, member_id: s.member })).status).toBe(400);
  });
});
