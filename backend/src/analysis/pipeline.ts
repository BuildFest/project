import type { ModelRouter } from "../ai/router.js";
import { reviewAnalysis } from "./aiReview.js";
import { deriveBranchFiles } from "./branches.js";
import { detectCollisions, type DetectedCollision } from "./collisions.js";
import { deriveHealthSignals } from "./health.js";
import type { ProjectSnapshot } from "./load.js";
import { applyStatusMoves, decideStatusMoves, type StatusMove } from "./planSync.js";
import { deriveTaskStates } from "./state.js";
import type { BranchState, DerivedTaskState, DesiredHealthSignal } from "./types.js";

export interface AnalysisResult {
  branches: BranchState[];
  states: DerivedTaskState[];
  signals: DesiredHealthSignal[];
  collisions: DetectedCollision[];
  // Forward plan_status moves the agent makes on its own (planSync.ts).
  statusMoves: StatusMove[];
  // Set when this run was a plan sync (moves decided, even if none were due).
  planSyncedAt: Date | null;
  aiApplied: boolean;
  aiError: string | null;
}

export async function analyzeProject(
  snapshot: ProjectSnapshot,
  router: ModelRouter | null,
  now = new Date(),
  options: { planSync?: boolean } = {},
): Promise<AnalysisResult> {
  const defaults = new Map(snapshot.repositories.map((repo) => [repo.repository_id, repo.default_branch]));
  const derived = deriveBranchFiles(snapshot.events, snapshot.tasks, snapshot.project.task_key_prefix,
    (repositoryId) => defaults.get(repositoryId) ?? "main");
  const derivedByBranch = new Map(derived.map((branch) => [`${branch.repository_id}\0${branch.branch}`, branch]));
  const branches = snapshot.branches.map((branch) => ({
    ...branch,
    ...(derivedByBranch.get(`${branch.repository_id}\0${branch.branch}`) ?? { changed_files: [], task_id: null }),
  }));
  const ruleStates = deriveTaskStates({
    tasks: snapshot.tasks, dependencies: snapshot.dependencies, events: snapshot.events,
    links: snapshot.links, branches, overrides: snapshot.overrides,
  });
  const ruleSignals = deriveHealthSignals({
    project: snapshot.project, milestones: snapshot.milestones, tasks: snapshot.tasks,
    dependencies: snapshot.dependencies, states: ruleStates, events: snapshot.events,
    links: snapshot.links, now,
  });
  const collisions = detectCollisions(branches);
  const review = router
    ? await reviewAnalysis(router, { tasks: snapshot.tasks, states: ruleStates, signals: ruleSignals, events: snapshot.events })
    : { states: ruleStates, signals: ruleSignals, applied: false, error: null };
  // With the final states known, the agent moves the plan forward where the
  // evidence is strong. Signals below see the plan as it will be once saved,
  // so a task the agent just completed doesn't also raise a disagreement.
  // Only on plan-sync runs (runner.ts decides when one is due).
  const statusMoves = options.planSync
    ? decideStatusMoves({ tasks: snapshot.tasks, states: review.states, links: snapshot.links, events: snapshot.events })
    : [];
  const plannedTasks = applyStatusMoves(snapshot.tasks, statusMoves);
  // Task decisions made by the reviewer can change which health conditions
  // are true. Re-derive them from the final states, then retain AI wording for
  // conditions that still exist. Suppressed rule signals stay suppressed.
  const finalRuleSignals = deriveHealthSignals({
    project: snapshot.project, milestones: snapshot.milestones, tasks: plannedTasks,
    dependencies: snapshot.dependencies, states: review.states, events: snapshot.events,
    links: snapshot.links, now,
  });
  const reviewedByFingerprint = new Map(review.signals.map((signal) => [signal.fingerprint, signal]));
  const originalFingerprints = new Set(ruleSignals.map((signal) => signal.fingerprint));
  const signals = finalRuleSignals.flatMap((signal) => {
    const reviewed = reviewedByFingerprint.get(signal.fingerprint);
    if (reviewed) return [reviewed];
    if (review.applied && originalFingerprints.has(signal.fingerprint)) return [];
    return [signal];
  });
  return {
    branches,
    states: review.states,
    signals,
    collisions,
    statusMoves,
    planSyncedAt: options.planSync ? now : null,
    aiApplied: review.applied,
    aiError: review.error,
  };
}
