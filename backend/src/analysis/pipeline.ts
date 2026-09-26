import type { ModelRouter } from "../ai/router.js";
import { reviewAnalysis } from "./aiReview.js";
import { deriveBranchFiles } from "./branches.js";
import { detectCollisions, type DetectedCollision } from "./collisions.js";
import { deriveHealthSignals } from "./health.js";
import type { ProjectSnapshot } from "./load.js";
import { deriveTaskStates } from "./state.js";
import type { BranchState, DerivedTaskState, DesiredHealthSignal } from "./types.js";

export interface AnalysisResult {
  branches: BranchState[];
  states: DerivedTaskState[];
  signals: DesiredHealthSignal[];
  collisions: DetectedCollision[];
  aiApplied: boolean;
  aiError: string | null;
}

export async function analyzeProject(
  snapshot: ProjectSnapshot,
  router: ModelRouter | null,
  now = new Date(),
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
  return {
    branches,
    states: review.states,
    signals: review.signals,
    collisions,
    aiApplied: review.applied,
    aiError: review.error,
  };
}
