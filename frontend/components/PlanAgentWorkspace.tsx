"use client";

import { useCallback, useEffect, useState } from "react";
import { useActingMember } from "@/lib/actingAs";
import { bootstrapPlanFromBrief, getState, runPlanningAgent, usingMockApi } from "@/lib/api";
import type { DerivedStatus, ProjectState, ProjectWorkspace, Task } from "@/lib/types";
import { boxCls, buttonCls, formatDate, pillCls, planAsDerived, timeAgo } from "@/lib/ui";
import BriefEditor from "./BriefEditor";
import MilestoneEditor from "./MilestoneEditor";
import PlanTable from "./PlanTable";
import PlanVersionBar from "./PlanVersionBar";
import ReplanPanel from "./ReplanPanel";
import StatusBadge from "./StatusBadge";
import { IconCheck, IconClock, IconPulse } from "./Icons";

const POLL_MS = 15_000;

export default function PlanAgentWorkspace({
  workspace,
  onChange,
}: {
  workspace: ProjectWorkspace;
  onChange: (workspace: ProjectWorkspace) => void;
}) {
  const pid = workspace.project.project_id;
  const { member } = useActingMember(workspace);
  const [state, setState] = useState<ProjectState | null>(null);
  const [busy, setBusy] = useState<"generate" | "sync" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stateLoadError, setStateLoadError] = useState<string | null>(null);

  const refreshState = useCallback(() => {
    void getState(pid).then(
      (next) => {
        setState(next);
        setStateLoadError(null);
      },
      (cause) => setStateLoadError(cause instanceof Error ? cause.message : "Could not reach the planning agent."),
    );
  }, [pid]);

  useEffect(() => {
    refreshState();
    const timer = setInterval(() => document.visibilityState === "visible" && refreshState(), POLL_MS);
    return () => clearInterval(timer);
  }, [refreshState, workspace.project.current_plan_version]);

  const activeTasks = workspace.tasks.filter((task) => !task.archived && task.plan_status !== "cancelled");
  const hasBrief = workspace.brief.content.trim().length > 0;
  const hasPlan = activeTasks.length > 0 || workspace.milestones.some((milestone) => !milestone.archived);
  const activeMilestones = workspace.milestones.filter((milestone) => !milestone.archived);
  const completeTasks = activeTasks.filter((task) => task.plan_status === "complete").length;
  const progress = activeTasks.length ? Math.round((completeTasks / activeTasks.length) * 100) : 0;
  const agent = state?.agent;
  const agentStatus = stateLoadError
    ? { label: "Disconnected", tone: "border-red/30 bg-red/10 text-red", dot: "bg-red" }
    : agent?.status === "failed"
      ? { label: "Needs attention", tone: "border-red/30 bg-red/10 text-red", dot: "bg-red" }
      : agent?.status === "degraded"
        ? { label: "Rules fallback", tone: "border-yellow/25 bg-yellow/10 text-yellow", dot: "bg-yellow" }
      : agent?.status === "running" || busy !== null
        ? { label: "Analyzing", tone: "border-link/30 bg-link/10 text-link", dot: "bg-link" }
        : agent?.status === "healthy"
          ? { label: "Connected", tone: "border-green/25 bg-green/10 text-green", dot: "bg-green" }
          : { label: "Starting", tone: "border-yellow/25 bg-yellow/10 text-yellow", dot: "bg-yellow" };
  const lastRunAt = agent?.last_completed_at ?? state?.computed_at ?? null;
  const statusMessage = stateLoadError
    ? { title: "Planning service is unreachable", detail: "Your plan is safe. Reconnect the API to resume automatic monitoring." }
    : agent?.status === "failed"
      ? { title: "The last analysis did not finish", detail: "Review the error below, then run the analysis again." }
      : agent?.status === "degraded"
        ? { title: "Plan checks completed with rules", detail: "The project stayed monitored while the AI review used a safe fallback." }
        : agent?.status === "running" || busy !== null
          ? { title: busy === "generate" ? "Building your project plan" : "Reconciling plan and project activity", detail: "Pit Crew is reviewing the latest context and evidence now." }
          : !hasBrief
            ? { title: "Add a brief to activate the planner", detail: "Give Pit Crew the outcome, constraints, and definition of done." }
            : !hasPlan
              ? { title: "Your brief is ready to become a plan", detail: "Generate milestones, tasks, ownership, dates, and dependencies in one pass." }
              : agent?.status === "healthy"
                ? { title: "Project monitoring is active", detail: "The plan is being checked against new work and team decisions." }
                : { title: "Preparing the first project analysis", detail: "Pit Crew will report here as soon as the first run completes." };
  const contextSources = [
    { label: "Brief", ready: hasBrief },
    { label: "Plan", ready: hasPlan },
    { label: "Timeline", ready: hasPlan },
    { label: "GitHub activity", ready: hasPlan },
    { label: "Decisions", ready: hasPlan },
    { label: "Corrections", ready: hasPlan },
  ];

  async function generate() {
    setBusy("generate");
    setError(null);
    setNotice(null);
    try {
      const result = await bootstrapPlanFromBrief(pid, member?.member_id ?? null);
      onChange(result.workspace);
      setNotice(`Plan v${result.plan_version ?? 1} created with ${result.milestone_count ?? result.workspace.milestones.length} milestones and ${result.task_count ?? result.workspace.tasks.length} tasks.`);
      refreshState();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The planning agent couldn't build the plan.");
    } finally {
      setBusy(null);
    }
  }

  async function sync() {
    setBusy("sync");
    setError(null);
    setNotice(null);
    try {
      const result = await runPlanningAgent(pid, member?.member_id ?? null);
      onChange(result.workspace);
      const fallback = result.analysis?.aiError ?? result.analysis?.linking?.aiError ?? result.analysis?.replanError;
      setNotice(fallback
        ? "Timeline synced with deterministic rules; the AI review reported a fallback. See agent status for details."
        : result.analysis?.replan?.created
          ? "Timeline synced. Pit Crew found a plan update for your review."
          : "Timeline synced. The current plan still fits the available evidence.");
      refreshState();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The planning agent couldn't sync the plan.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.72fr)]">
        <BriefEditor workspace={workspace} onChange={onChange} />

        <section aria-busy={busy !== null}
          className="relative isolate overflow-hidden rounded-xl border border-line-strong bg-surface shadow-[0_18px_50px_rgba(0,0,0,0.18)]">
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-link/80 to-transparent" />
          <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-link/10 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-20 -left-16 h-44 w-44 rounded-full bg-purple/10 blur-3xl" />
          {busy && (
            <AnalyzingOverlay
              label={busy === "generate" ? "Generating your plan…" : "Analyzing project activity…"}
            />
          )}
          <div className="relative flex h-full flex-col">
            <header className="flex flex-wrap items-start justify-between gap-4 px-5 pb-4 pt-5">
              <div className="flex min-w-0 items-start gap-3">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-link/25 bg-link/10 text-link shadow-[inset_0_1px_rgba(255,255,255,0.05)]">
                  <IconPulse className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold text-header">Planning agent</h2>
                    {usingMockApi && <span className={pillCls}>Demo mode</span>}
                  </div>
                  <p className="mt-0.5 max-w-lg text-sm leading-5 text-muted">Builds the plan, watches the work, and turns meaningful changes into reviewable updates.</p>
                </div>
              </div>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${agentStatus.tone}`}>
                <span className="relative flex h-1.5 w-1.5">
                  {(agent?.status === "running" || busy !== null) && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${agentStatus.dot} opacity-60`} />}
                  <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${agentStatus.dot}`} />
                </span>
                {agentStatus.label}
              </span>
            </header>

            <div className="mx-5 overflow-hidden rounded-lg border border-line bg-bg/65 shadow-[inset_0_1px_rgba(255,255,255,0.025)]">
              <div className="flex items-start gap-3 px-4 py-3.5">
                <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${agentStatus.dot}`} />
                <div className="min-w-0">
                  <p className="font-medium text-header">{statusMessage.title}</p>
                  <p className="mt-0.5 text-xs leading-5 text-muted">{statusMessage.detail}</p>
                </div>
              </div>
              {(agent?.status === "running" || busy !== null) && (
                <div className="h-0.5 overflow-hidden bg-line"><div className="h-full w-1/2 animate-pulse rounded-full bg-link" /></div>
              )}
              <div className="grid grid-cols-2 border-t border-line sm:grid-cols-4">
                <AgentMetric label="Plan" value={workspace.project.current_plan_version ? `v${workspace.project.current_plan_version}` : "Draft"} />
                <AgentMetric label="Progress" value={activeTasks.length ? `${progress}%` : "—"} detail={activeTasks.length ? `${completeTasks}/${activeTasks.length} tasks` : "No tasks yet"} />
                <AgentMetric label="Last run" value={lastRunAt ? timeAgo(lastRunAt) : "Waiting"} />
                <AgentMetric label="Review queue" value={String(state?.open_replans ?? 0)} detail={(state?.open_replans ?? 0) === 1 ? "plan update" : "plan updates"} />
              </div>
            </div>

            <div className="px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">Connected context</p>
                <span className="text-[11px] text-faint">{activeMilestones.length} milestone{activeMilestones.length === 1 ? "" : "s"}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {contextSources.map((source) => (
                  <span key={source.label} className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] ${source.ready ? "border-line-strong bg-raised/70 text-muted" : "border-line bg-bg/40 text-faint"}`}>
                    <IconCheck className={source.ready ? "text-green" : "text-faint"} />
                    {source.label}
                  </span>
                ))}
              </div>
            </div>

            <div className="space-y-2 px-5 pb-4">
              {stateLoadError && <p className="rounded-md border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">Status check failed: {stateLoadError}</p>}
              {agent?.status === "failed" && agent.last_error && <p className="rounded-md border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">Last automatic run failed: {agent.last_error}</p>}
              {agent?.status === "degraded" && agent.last_error && <p className="rounded-md border border-yellow/40 bg-yellow/10 px-3 py-2 text-sm text-yellow">AI review fell back to rules: {agent.last_error}</p>}
              {error && <p className="rounded-md border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{error}</p>}
              {notice && <p className="rounded-md border border-green/30 bg-green/10 px-3 py-2 text-sm text-green">{notice}</p>}
            </div>

            <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-line bg-raised/35 px-5 py-3.5">
              <div className="flex flex-wrap items-center gap-2">
                {!hasPlan ? (
                  <button className={`${buttonCls} gap-1.5`} disabled={!hasBrief || busy !== null} onClick={generate}>
                    <IconPulse />
                    {busy === "generate" ? "Building plan…" : "Build plan from brief"}
                  </button>
                ) : (
                  <button className={`${buttonCls} gap-1.5`} disabled={busy !== null} onClick={sync}>
                    <IconPulse />
                    {busy === "sync" ? "Analyzing…" : "Run analysis now"}
                  </button>
                )}
                <span className="inline-flex items-center gap-1.5 text-xs text-muted"><IconClock /> Auto-checks every minute</span>
              </div>
              <details className="group text-xs text-muted">
                <summary className="cursor-pointer list-none font-medium hover:text-header">Run details <span className="ml-1 inline-block transition-transform group-open:rotate-180">⌄</span></summary>
                <div className="absolute bottom-14 right-5 z-10 w-64 rounded-md border border-line-strong bg-raised p-3 shadow-xl">
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
                    <dt className="text-faint">Trigger</dt><dd className="text-right text-header">{agent?.last_trigger ? triggerLabel(agent.last_trigger) : "Waiting"}</dd>
                    <dt className="text-faint">Mode</dt><dd className="text-right text-header">{agent?.last_mode ? (agent.last_result?.aiApplied === true ? "AI + rules" : agent.last_mode === "full" ? "Full pipeline" : "Rules check") : "—"}</dd>
                    <dt className="text-faint">Provider</dt><dd className={`text-right ${agent?.ai_available ? "text-green" : "text-muted"}`}>{agent ? (agent.ai_available ? "Connected" : "Unavailable") : "Checking"}</dd>
                    <dt className="text-faint">Total runs</dt><dd className="text-right text-header">{agent?.runs_count ?? 0}</dd>
                  </dl>
                </div>
              </details>
            </div>
          </div>
        </section>
      </div>

      <ReplanPanel
        workspace={workspace}
        memberId={member?.member_id ?? null}
        refreshKey={`${state?.computed_at ?? ""}:${state?.open_replans ?? 0}`}
        onWorkspaceChange={onChange}
        onNotice={setNotice}
      />

      {hasPlan ? <Roadmap workspace={workspace} state={state} /> : <EmptyRoadmap hasBrief={hasBrief} />}

      <details className={`${boxCls} group`}>
        <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-header">
          Manual plan controls
          <span className="text-xs font-normal text-muted group-open:hidden">Edit individual tasks, milestones, dates, and dependencies</span>
          <span className="hidden text-muted group-open:inline">Hide</span>
        </summary>
        <div className="space-y-6 border-t border-line p-4">
          <MilestoneEditor workspace={workspace} onChange={onChange} />
          <PlanVersionBar workspace={workspace} onChange={onChange} />
          <PlanTable workspace={workspace} onChange={onChange} />
        </div>
      </details>
    </div>
  );
}

// Shown over the agent card while it's actually reasoning (contract: this
// call runs a real LLM completion and can take up to a minute or more), so
// the button label alone isn't enough feedback not to look stuck/broken.
function AnalyzingOverlay({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite"
      className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-lg bg-bg/85 text-center backdrop-blur-sm">
      <span className="h-8 w-8 animate-spin rounded-full border-2 border-link border-t-transparent" aria-hidden />
      <p className="text-sm font-semibold text-header">{label}</p>
      <p className="max-w-xs px-4 text-xs text-muted">
        The planning agent is reasoning over the brief and project activity — this can take up to a minute.
      </p>
    </div>
  );
}

const TRIGGER_LABELS: Record<string, string> = {
  startup: "server startup",
  periodic: "automatic sweep",
  github_event: "GitHub activity",
  branch_files: "branch comparison",
  backfill: "repository backfill",
  project: "project settings",
  brief: "brief update",
  member: "team update",
  plan: "plan update",
  decision: "team decision",
  correction: "human correction",
  manual: "manual sync",
  bootstrap: "plan generation",
};

function triggerLabel(trigger: string) {
  return TRIGGER_LABELS[trigger] ?? trigger.replace(/_/g, " ");
}

function AgentMetric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 border-r border-line px-3 py-2.5 last:border-r-0 even:border-r-0 sm:even:border-r sm:last:border-r-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-0.5 truncate text-base font-semibold text-header">{value}</div>
      {detail && <div className="truncate text-[10px] text-faint">{detail}</div>}
    </div>
  );
}

function Roadmap({ workspace, state }: { workspace: ProjectWorkspace; state: ProjectState | null }) {
  const tasks = workspace.tasks.filter((task) => !task.archived && task.plan_status !== "cancelled");
  const stateByTask = new Map((state?.tasks ?? []).map((item) => [item.task_id, item]));
  const milestones = workspace.milestones.filter((milestone) => !milestone.archived).sort((a, b) => a.sort_order - b.sort_order);
  const groups = [
    ...milestones.map((milestone) => ({ id: milestone.milestone_id, name: milestone.name, target: milestone.target_at })),
    ...(tasks.some((task) => !task.milestone_id) ? [{ id: "unassigned", name: "Next up", target: null }] : []),
  ];
  const dependencyCount = new Map<string, number>();
  for (const dependency of workspace.dependencies) dependencyCount.set(dependency.task_id, (dependencyCount.get(dependency.task_id) ?? 0) + 1);

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-header">Living roadmap</h2>
          <p className="text-sm text-muted">Organized by milestone; repository evidence is layered onto the team-authored plan.</p>
        </div>
        <span className="text-xs text-muted">{tasks.length} active task{tasks.length === 1 ? "" : "s"}</span>
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        {groups.map((group, groupIndex) => {
          const items = tasks.filter((task) => group.id === "unassigned" ? !task.milestone_id : task.milestone_id === group.id);
          const complete = items.filter((task) => task.plan_status === "complete").length;
          const pct = items.length ? Math.round((complete / items.length) * 100) : 0;
          return (
            <article key={group.id} className={`${boxCls} min-w-0 overflow-hidden`}>
              <header className="border-b border-line bg-raised/60 px-4 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[10px] font-semibold uppercase tracking-widest text-link">Phase {groupIndex + 1}</div>
                    <h3 className="truncate font-semibold text-header">{group.name}</h3>
                  </div>
                  <span className="whitespace-nowrap text-xs text-muted">{formatDate(group.target)}</span>
                </div>
                <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-btn"><div className="h-full rounded-full bg-green transition-all" style={{ width: `${pct}%` }} /></div>
                <div className="mt-1 text-[11px] text-muted">{complete}/{items.length} complete</div>
              </header>
              <div className="space-y-2 p-3">
                {items.map((task) => (
                  <RoadmapTask key={task.task_id} task={task} effective={stateByTask.get(task.task_id)?.effective_status} dependencies={dependencyCount.get(task.task_id) ?? 0} />
                ))}
                {items.length === 0 && <p className="px-1 py-5 text-center text-sm text-muted">No tasks in this milestone.</p>}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

// The plan's status leads; the repository's view shows only where it differs.
function RoadmapTask({ task, effective, dependencies }: { task: Task; effective?: DerivedStatus; dependencies: number }) {
  const differs = effective !== undefined && planAsDerived(task.plan_status) !== null && planAsDerived(task.plan_status) !== effective;
  return (
    <div className="rounded-md border border-line bg-bg px-3 py-3 transition-colors hover:border-line-strong hover:bg-raised/50">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[10px] text-link">{task.task_key}</div>
          <div className="mt-0.5 font-medium text-header">{task.title}</div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge status={task.plan_status} />
          {task.plan_status_set_by === "agent" && <span className="text-[10px] text-faint">set by agent</span>}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
        {differs && <span className={effective === "possibly_blocked" ? "text-yellow" : "text-link"}>Repo: {effective.replace(/_/g, " ")}</span>}
        <span>{task.priority} priority</span>
        <span>{task.scope === "must_have" ? "must-have" : "optional"}</span>
        {dependencies > 0 && <span>{dependencies} dependenc{dependencies === 1 ? "y" : "ies"}</span>}
      </div>
    </div>
  );
}

function EmptyRoadmap({ hasBrief }: { hasBrief: boolean }) {
  return (
    <section className="rounded-lg border border-dashed border-line-strong bg-surface/50 px-6 py-12 text-center">
      <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-link/10 text-xl text-link">✦</div>
      <h2 className="mt-3 font-semibold text-header">{hasBrief ? "Ready to build the roadmap" : "The roadmap starts with the brief"}</h2>
      <p className="mx-auto mt-1 max-w-lg text-sm text-muted">
        {hasBrief ? "The planning agent will organize the brief into milestones, tasks, ownership, dates, and dependencies." : "Add the project goals and constraints, then let Pit Crew create the first working plan."}
      </p>
    </section>
  );
}
