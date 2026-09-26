import type pg from "pg";
import { newId } from "../ids.js";
import type { AnalysisResult } from "./pipeline.js";
import type { ProjectSnapshot } from "./load.js";
import type { DetectedCollision } from "./collisions.js";

export interface PersistResult { branches: number; states: number; signals: number; collisions: number }

async function timeline(tx: pg.PoolClient, projectId: string, kind: string, title: string, entityType: string, entityId: string, tasks: string[] = []) {
  await tx.query(`insert into timeline_items
    (item_id, project_id, occurred_at, kind, title, entity_type, entity_id, related_task_ids)
    values ($1, $2, now(), $3, $4, $5, $6, $7)`, [newId("tl"), projectId, kind, title, entityType, entityId, tasks]);
}

async function databaseCollisionPair(tx: pg.PoolClient, collision: DetectedCollision): Promise<DetectedCollision> {
  const { rows: [pair] } = await tx.query<{ branch_a: string; branch_b: string }>(
    "select least($1::text, $2::text) branch_a, greatest($1::text, $2::text) branch_b",
    [collision.branch_a, collision.branch_b],
  );
  if (pair.branch_a === collision.branch_a) return collision;
  return { ...collision, branch_a: pair.branch_a, branch_b: pair.branch_b, task_a_id: collision.task_b_id, task_b_id: collision.task_a_id };
}

export async function persistAnalysis(tx: pg.PoolClient, projectId: string, snapshot: ProjectSnapshot, result: AnalysisResult): Promise<PersistResult> {
  const counts: PersistResult = { branches: 0, states: 0, signals: 0, collisions: 0 };
  for (const branch of result.branches) {
    const changed = await tx.query(`update branch_states set changed_files = $3, task_id = $4
      where repository_id = $1 and branch = $2
        and (changed_files, task_id) is distinct from ($3::text[], $4::text)`,
      [branch.repository_id, branch.branch, branch.changed_files, branch.task_id]);
    counts.branches += changed.rowCount ?? 0;
  }
  for (const state of result.states) {
    const changed = await tx.query(`insert into derived_task_states
      (task_id, project_id, computed_status, confidence, evidence_event_ids, last_activity_at,
       blocking_task_ids, explanation, computation_method, computed_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
      on conflict (task_id) do update set
        computed_status=excluded.computed_status, confidence=excluded.confidence,
        evidence_event_ids=excluded.evidence_event_ids, last_activity_at=excluded.last_activity_at,
        blocking_task_ids=excluded.blocking_task_ids, explanation=excluded.explanation,
        computation_method=excluded.computation_method, computed_at=excluded.computed_at
      where (derived_task_states.computed_status, derived_task_states.confidence,
             derived_task_states.evidence_event_ids, derived_task_states.last_activity_at,
             derived_task_states.blocking_task_ids, derived_task_states.explanation,
             derived_task_states.computation_method)
        is distinct from (excluded.computed_status, excluded.confidence, excluded.evidence_event_ids,
                          excluded.last_activity_at, excluded.blocking_task_ids, excluded.explanation,
                          excluded.computation_method)`,
      [state.task_id, projectId, state.computed_status, state.confidence, state.evidence_event_ids,
       state.last_activity_at, state.blocking_task_ids, state.explanation, state.computation_method]);
    counts.states += changed.rowCount ?? 0;
  }

  const desiredSignals = new Map(result.signals.map((signal) => [signal.fingerprint, signal]));
  for (const stored of snapshot.openSignals) {
    const desired = desiredSignals.get(stored.fingerprint);
    if (!desired) {
      await tx.query("update health_signals set status='resolved', resolved_at=now() where signal_id=$1", [stored.signal_id]);
      counts.signals++;
      if (stored.status === "active") await timeline(tx, projectId, "signal_resolved", `${stored.title} resolved`, "health_signal", stored.signal_id, stored.related_task_ids);
    } else if (stored.status === "active") {
      const updated = await tx.query(`update health_signals set severity=$2,title=$3,explanation=$4,
        related_task_ids=$5,related_milestone_ids=$6,evidence_event_ids=$7
        where signal_id=$1 and (severity,title,explanation,related_task_ids,related_milestone_ids,evidence_event_ids)
          is distinct from ($2::text,$3::text,$4::text,$5::text[],$6::text[],$7::text[])`,
        [stored.signal_id, desired.severity, desired.title, desired.explanation, desired.related_task_ids, desired.related_milestone_ids, desired.evidence_event_ids]);
      counts.signals += updated.rowCount ?? 0;
    }
    desiredSignals.delete(stored.fingerprint);
  }
  for (const signal of desiredSignals.values()) {
    const id = newId("sig");
    const inserted = await tx.query(`insert into health_signals
      (signal_id,project_id,type,severity,title,explanation,related_task_ids,related_milestone_ids,evidence_event_ids,fingerprint)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      on conflict (project_id,fingerprint) where status <> 'resolved' do nothing`,
      [id, projectId, signal.type, signal.severity, signal.title, signal.explanation, signal.related_task_ids, signal.related_milestone_ids, signal.evidence_event_ids, signal.fingerprint]);
    counts.signals += inserted.rowCount ?? 0;
    if (inserted.rowCount) await timeline(tx, projectId, "signal_detected", signal.title, "health_signal", id, signal.related_task_ids);
  }

  const normalized = await Promise.all(result.collisions.map((item) => databaseCollisionPair(tx, item)));
  const desiredCollisions = new Map(normalized.map((item) => [`${item.repository_id}\0${item.branch_a}\0${item.branch_b}`, item]));
  for (const stored of snapshot.openCollisions) {
    const key = `${stored.repository_id}\0${stored.branch_a}\0${stored.branch_b}`;
    const desired = desiredCollisions.get(key);
    if (!desired) {
      await tx.query("update collisions set status='resolved', resolved_at=now() where collision_id=$1", [stored.collision_id]);
      counts.collisions++;
      if (stored.status === "active") await timeline(tx, projectId, "collision_resolved", `Collision risk resolved: ${stored.branch_a} and ${stored.branch_b}`, "collision", stored.collision_id, [stored.task_a_id, stored.task_b_id].filter((id): id is string => id !== null));
    } else if (stored.status === "active") {
      const updated = await tx.query(`update collisions set task_a_id=$2,task_b_id=$3,overlapping_files=$4
        where collision_id=$1 and (task_a_id,task_b_id,overlapping_files)
          is distinct from ($2::text,$3::text,$4::text[])`,
        [stored.collision_id, desired.task_a_id, desired.task_b_id, desired.overlapping_files]);
      counts.collisions += updated.rowCount ?? 0;
    }
    desiredCollisions.delete(key);
  }
  for (const collision of desiredCollisions.values()) {
    const id = newId("col");
    const inserted = await tx.query(`insert into collisions
      (collision_id,project_id,repository_id,branch_a,branch_b,task_a_id,task_b_id,overlapping_files)
      values ($1,$2,$3,$4,$5,$6,$7,$8)
      on conflict (repository_id,branch_a,branch_b) where status <> 'resolved' do nothing`,
      [id, projectId, collision.repository_id, collision.branch_a, collision.branch_b, collision.task_a_id, collision.task_b_id, collision.overlapping_files]);
    counts.collisions += inserted.rowCount ?? 0;
    if (inserted.rowCount) await timeline(tx, projectId, "collision_detected", `Collision risk: ${collision.branch_a} and ${collision.branch_b}`, "collision", id, [collision.task_a_id, collision.task_b_id].filter((item): item is string => item !== null));
  }
  return counts;
}
