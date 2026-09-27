import type { ModelRouter } from "../ai/router.js";
import { withTransaction, type Db } from "../db.js";
import { linkProjectEvents, type LinkRunResult } from "./linkEvents.js";
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
  trigger?: AnalysisTrigger;
}

export type AnalysisTrigger =
  | "startup"
  | "periodic"
  | "github_event"
  | "branch_files"
  | "backfill"
  | "project"
  | "brief"
  | "member"
  | "plan"
  | "decision"
  | "correction"
  | "manual"
  | "bootstrap";

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
  linking: LinkRunResult | null;
}

async function executeAnalysis(db: Db, router: ModelRouter | null, projectId: string, now: Date, options: AnalysisRunOptions): Promise<AnalysisRunResult> {
  // A session-level lock serializes the complete read/interpret/write cycle,
  // including direct CLI calls and runs from different server processes.
  const lock = await db.connect();
  let snapshot: ProjectSnapshot;
  let result: AnalysisResult;
  let persisted: PersistResult;
  let linking: LinkRunResult | null = null;
  let replan: ReplanGenerationResult | null = null;
  let replanError: string | null = null;
  try {
    await lock.query("select pg_advisory_lock(hashtext('analysis:' || $1))", [projectId]);
    if (!options.skipLinking) linking = await withAiProject(projectId, () => linkProjectEvents(db, router, projectId));
    snapshot = await loadProjectSnapshot(db, projectId);
    const planSync = planSyncDue(snapshot, now, options);
    result = await withAiProject(projectId, () => analyzeProject(snapshot, options.skipAi ? null : router, now, { planSync }));
    persisted = await withTransaction(db, (tx) => persistAnalysis(tx, projectId, snapshot, result));
    try {
      replan = await maybeGenerateReplan(db, options.skipAi ? null : router, projectId);
      if (replan.aiError) replanError = replan.aiError;
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
  return { ...persisted, aiApplied: result.aiApplied, aiError: result.aiError, replan, replanError, notes, linking };
}

async function recordAgentStatus(db: Db, sql: string, params: unknown[]) {
  try {
    await db.query(sql, params);
  } catch (error) {
    // Monitoring must never become a new failure mode for the agent itself.
    console.error("could not record planning agent status", { error });
  }
}

export async function runAnalysis(
  db: Db,
  router: ModelRouter | null,
  projectId: string,
  now = new Date(),
  options: AnalysisRunOptions = {},
): Promise<AnalysisRunResult> {
  const trigger = options.trigger ?? "manual";
  const mode = options.skipAi ? "rules" : "full";
  const aiAvailable = router !== null && ["link_suggestion", "state_review", "replan"].every((job) =>
    router.available(job as "link_suggestion" | "state_review" | "replan"),
  );
  await recordAgentStatus(
    db,
    `insert into planning_agent_status
       (project_id, status, last_trigger, last_mode, ai_available, last_started_at, runs_count)
     values ($1, 'running', $2, $3, $4, $5, 1)
     on conflict (project_id) do update set
       status='running', last_trigger=excluded.last_trigger, last_mode=excluded.last_mode,
       ai_available=excluded.ai_available, last_started_at=excluded.last_started_at, last_error=null,
       runs_count=planning_agent_status.runs_count + 1`,
    [projectId, trigger, mode, aiAvailable, now],
  );

  try {
    const result = await executeAnalysis(db, router, projectId, now, options);
    const degradedError = [
      aiAvailable ? null : "No AI provider is configured for planning jobs",
      result.linking?.aiError,
      result.aiError,
      result.replanError,
    ].filter((value): value is string => Boolean(value)).join(" · ") || null;
    await recordAgentStatus(
      db,
      `update planning_agent_status set
         status=$2, last_completed_at=now(), last_succeeded_at=now(),
         last_error=$3, last_result=$4::jsonb
       where project_id=$1`,
      [projectId, degradedError ? "degraded" : "healthy", degradedError, JSON.stringify(result)],
    );
    return result;
  } catch (error) {
    await recordAgentStatus(
      db,
      `update planning_agent_status set
         status='failed', last_completed_at=now(), last_failed_at=now(), last_error=$2
       where project_id=$1`,
      [projectId, error instanceof Error ? error.message : String(error)],
    );
    throw error;
  }
}

export interface ScheduleAnalysisOptions { periodic?: boolean; trigger?: AnalysisTrigger }

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
  const deferredAi = new Map<string, NodeJS.Timeout>();
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
      if (!skipAi) {
        lastAiRunAt.set(projectId, now());
        const deferred = deferredAi.get(projectId);
        if (deferred) clearTimeout(deferred);
        deferredAi.delete(projectId);
      } else if (cooling && options.periodic !== true && lastAi !== undefined && !deferredAi.has(projectId)) {
        // Keep the cheap rules pass now, but do not lose the model review that
        // this app change requested. Run it once the per-project cooldown ends.
        const deferred = setTimeout(() => {
          deferredAi.delete(projectId);
          schedule(projectId, { trigger: options.trigger ?? "github_event" });
        }, Math.max(1, aiMinIntervalMs - (now() - lastAi)));
        deferred.unref();
        deferredAi.set(projectId, deferred);
      }
      void run(db, router, projectId, new Date(now()), {
        skipLinking: skipAi,
        skipAi,
        trigger: options.trigger ?? (options.periodic ? "periodic" : "github_event"),
      }).catch((error) => console.error("project analysis failed", { projectId, error }))
        .finally(() => {
          active--;
          running.delete(projectId);
          pump();
        });
    }
  };
  const schedule = (projectId: string, options: ScheduleAnalysisOptions = {}) => {
    const prior = timers.get(projectId);
    if (prior) clearTimeout(prior);
    const priorQueued = pending.get(projectId) ?? queued.get(projectId);
    // An event-triggered run is stronger than a periodic health-only run.
    const periodic = (priorQueued?.periodic ?? true) && options.periodic === true;
    const next = {
      periodic,
      trigger: periodic
        ? options.trigger ?? priorQueued?.trigger ?? "periodic"
        : options.periodic === true
          ? priorQueued?.trigger ?? "github_event"
          : options.trigger ?? priorQueued?.trigger ?? "github_event",
    };
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
  return schedule;
}

export function startAnalysisSweep(db: Db, schedule: (projectId: string, options?: ScheduleAnalysisOptions) => void, intervalMs = 60_000) {
  let first = true;
  const sweep = async () => {
    try {
      const { rows } = await db.query<{ project_id: string }>("select project_id from projects where status='active'");
      rows.forEach((row) => schedule(row.project_id, { periodic: !first, trigger: first ? "startup" : "periodic" }));
    } catch (error) { console.error("analysis sweep failed", error); }
    first = false;
  };
  void sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref();
  return timer;
}
