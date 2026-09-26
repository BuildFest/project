import type { ModelRouter } from "../ai/router.js";
import { withTransaction, type Db } from "../db.js";
import { linkProjectEvents } from "./linkEvents.js";
import { loadProjectSnapshot } from "./load.js";
import { persistAnalysis, type PersistResult } from "./persist.js";
import { analyzeProject } from "./pipeline.js";

export interface AnalysisRunResult extends PersistResult { aiApplied: boolean; aiError: string | null }

export async function runAnalysis(db: Db, router: ModelRouter | null, projectId: string, now = new Date()): Promise<AnalysisRunResult> {
  // A session-level lock serializes the complete read/interpret/write cycle,
  // including direct CLI calls and runs from different server processes.
  const lock = await db.connect();
  try {
    await lock.query("select pg_advisory_lock(hashtext('analysis:' || $1))", [projectId]);
    await linkProjectEvents(db, router, projectId);
    const snapshot = await loadProjectSnapshot(db, projectId);
    const result = await analyzeProject(snapshot, router, now);
    const persisted = await withTransaction(db, (tx) => persistAnalysis(tx, projectId, snapshot, result));
    return { ...persisted, aiApplied: result.aiApplied, aiError: result.aiError };
  } finally {
    await lock.query("select pg_advisory_unlock(hashtext('analysis:' || $1))", [projectId]).catch(() => {});
    lock.release();
  }
}

export function createAnalysisScheduler(db: Db, router: ModelRouter | null, debounceMs = 2_000) {
  const timers = new Map<string, NodeJS.Timeout>();
  const running = new Set<string>();
  const dirty = new Set<string>();
  const execute = async (projectId: string) => {
    if (running.has(projectId)) { dirty.add(projectId); return; }
    running.add(projectId);
    do {
      dirty.delete(projectId);
      try { await runAnalysis(db, router, projectId); }
      catch (error) { console.error("project analysis failed", { projectId, error }); }
    } while (dirty.has(projectId));
    running.delete(projectId);
  };
  return (projectId: string) => {
    const prior = timers.get(projectId);
    if (prior) clearTimeout(prior);
    const timer = setTimeout(() => { timers.delete(projectId); void execute(projectId); }, debounceMs);
    timer.unref();
    timers.set(projectId, timer);
  };
}

export function startAnalysisSweep(db: Db, schedule: (projectId: string) => void, intervalMs = 60_000) {
  const timer = setInterval(async () => {
    try {
      const { rows } = await db.query<{ project_id: string }>("select project_id from projects where status='active'");
      rows.forEach((row) => schedule(row.project_id));
    } catch (error) { console.error("analysis sweep failed", error); }
  }, intervalMs);
  timer.unref();
  return timer;
}
