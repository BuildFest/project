import type { ModelRouter } from "../ai/router.js";
import { withTransaction, type Db } from "../db.js";
import { linkProjectEvents } from "./linkEvents.js";
import { loadProjectSnapshot, type ProjectSnapshot } from "./load.js";
import { persistAnalysis, type PersistResult } from "./persist.js";
import { analyzeProject, type AnalysisResult } from "./pipeline.js";
import { maybeGenerateReplan, type ReplanGenerationResult } from "./replans.js";
import { withAiProject } from "../ai/audit.js";
import { notifyPendingPullRequests } from "./preMerge.js";

export interface AnalysisRunOptions {
  skipLinking?: boolean;
  skipAi?: boolean;
  // Sync the plan now even if the last sync was recent (the "Run" button).
  forcePlanSync?: boolean;
}

// The planning agent moves task statuses in batches, not on every event, so
// the plan changes at a steady cadence. The background sweep picks up due
// projects. Read at call time so tests and deploys can change it.
const DEFAULT_PLAN_SYNC_HOURS = 3;
export function planSyncIntervalMs(env: Record<string, string | undefined> = process.env): number {
  const hours = Number(env.PLAN_SYNC_INTERVAL_HOURS ?? DEFAULT_PLAN_SYNC_HOURS);
  return (Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_PLAN_SYNC_HOURS) * 3_600_000;
}

function planSyncDue(snapshot: ProjectSnapshot, now: Date, options: AnalysisRunOptions): boolean {
  if (options.forcePlanSync) return true;
  if (!snapshot.planSyncedAt) return true;
  return now.getTime() - snapshot.planSyncedAt.getTime() >= planSyncIntervalMs();
}

export interface AnalysisRunResult extends PersistResult {
  aiApplied: boolean;
  aiError: string | null;
  replan: ReplanGenerationResult | null;
  replanError: string | null;
  notes: number;
}

export async function runAnalysis(db: Db, router: ModelRouter | null, projectId: string, now = new Date(), options: AnalysisRunOptions = {}): Promise<AnalysisRunResult> {
  // A session-level lock serializes the complete read/interpret/write cycle,
  // including direct CLI calls and runs from different server processes.
  const lock = await db.connect();
  let snapshot: ProjectSnapshot;
  let result: AnalysisResult;
  let persisted: PersistResult;
  let replan: ReplanGenerationResult | null = null;
  let replanError: string | null = null;
  try {
    await lock.query("select pg_advisory_lock(hashtext('analysis:' || $1))", [projectId]);
    if (!options.skipLinking) await withAiProject(projectId, () => linkProjectEvents(db, router, projectId));
    snapshot = await loadProjectSnapshot(db, projectId);
    const planSync = planSyncDue(snapshot, now, options);
    result = await withAiProject(projectId, () => analyzeProject(snapshot, options.skipAi ? null : router, now, { planSync }));
    persisted = await withTransaction(db, (tx) => persistAnalysis(tx, projectId, snapshot, result));
    try {
      replan = await maybeGenerateReplan(db, options.skipAi ? null : router, projectId);
    } catch (error) {
      replanError = (error as Error).message;
    }
  } finally {
    await lock.query("select pg_advisory_unlock(hashtext('analysis:' || $1))", [projectId]).catch(() => {});
    lock.release();
  }
  let notes = 0;
  try { notes = await notifyPendingPullRequests(db, options.skipAi ? null : router, projectId, snapshot, result); }
  catch (error) { console.error("pre-merge notification failed", { projectId, error }); }
  return { ...persisted, aiApplied: result.aiApplied, aiError: result.aiError, replan, replanError, notes };
}

export interface ScheduleAnalysisOptions { periodic?: boolean }

export interface AnalysisSchedulerDeps {
  debounceMs?: number;
  maxConcurrent?: number;
  // A floor on how often a project gets an AI-inclusive run (link suggestions,
  // state review, replan generation), regardless of how often events trigger
  // one. Every webhook event used to schedule a full AI pass after only a 2s
  // debounce, so a burst of ordinary pushes during active development could
  // hit the model dozens of times in a few minutes. A run that lands inside
  // the cooldown still happens — it's just downgraded to the same rules-only
  // pass a periodic sweep does, so the dashboard stays current without
  // re-invoking the model. 0 disables the cap. Env: ANALYSIS_AI_MIN_INTERVAL_MS.
  aiMinIntervalMs?: number;
  now?: () => number;
  run?: typeof runAnalysis;
}

export function createAnalysisScheduler(db: Db, router: ModelRouter | null, deps: AnalysisSchedulerDeps = {}) {
  const {
    debounceMs = 2_000,
    maxConcurrent = 4,
    aiMinIntervalMs = Number(process.env.ANALYSIS_AI_MIN_INTERVAL_MS ?? 300_000),
    now = () => Date.now(),
    run = runAnalysis,
  } = deps;
  const timers = new Map<string, NodeJS.Timeout>();
  const pending = new Map<string, ScheduleAnalysisOptions>();
  const queued = new Map<string, ScheduleAnalysisOptions>();
  const running = new Set<string>();
  const lastAiRunAt = new Map<string, number>();
  let active = 0;
  const pump = () => {
    while (active < maxConcurrent && queued.size > 0) {
      const entry = [...queued.entries()].find(([projectId]) => !running.has(projectId));
      if (!entry) return;
      const [projectId, options] = entry;
      queued.delete(projectId);
      running.add(projectId);
      active++;
      const lastAi = lastAiRunAt.get(projectId);
      const cooling = aiMinIntervalMs > 0 && lastAi !== undefined && now() - lastAi < aiMinIntervalMs;
      const skipAi = options.periodic === true || cooling;
      if (!skipAi) lastAiRunAt.set(projectId, now());
      void run(db, router, projectId, new Date(now()), {
        skipLinking: skipAi,
        skipAi,
      }).catch((error) => console.error("project analysis failed", { projectId, error }))
        .finally(() => {
          active--;
          running.delete(projectId);
          pump();
        });
    }
  };
  return (projectId: string, options: ScheduleAnalysisOptions = {}) => {
    const prior = timers.get(projectId);
    if (prior) clearTimeout(prior);
    const priorQueued = pending.get(projectId) ?? queued.get(projectId);
    // An event-triggered run is stronger than a periodic health-only run.
    const next = { periodic: (priorQueued?.periodic ?? true) && options.periodic === true };
    pending.set(projectId, next);
    const timer = setTimeout(() => {
      timers.delete(projectId);
      const ready = pending.get(projectId) ?? next;
      pending.delete(projectId);
      queued.set(projectId, ready);
      pump();
    }, debounceMs);
    timer.unref();
    timers.set(projectId, timer);
  };
}

export function startAnalysisSweep(db: Db, schedule: (projectId: string, options?: ScheduleAnalysisOptions) => void, intervalMs = 60_000) {
  const timer = setInterval(async () => {
    try {
      const { rows } = await db.query<{ project_id: string }>("select project_id from projects where status='active'");
      rows.forEach((row) => schedule(row.project_id, { periodic: true }));
    } catch (error) { console.error("analysis sweep failed", error); }
  }, intervalMs);
  timer.unref();
  return timer;
}
