"use client";

import { useCallback, useEffect, useState } from "react";
import { useActingMember } from "@/lib/actingAs";
import { bootstrapPlanFromBrief, getState, runPlanningAgent, usingMockApi } from "@/lib/api";
import type { DerivedStatus, ProjectState, ProjectWorkspace, Task } from "@/lib/types";
import { boxCls, buttonCls, formatDate, pillCls, timeAgo } from "@/lib/ui";
import BriefEditor from "./BriefEditor";
import MilestoneEditor from "./MilestoneEditor";
import PlanTable from "./PlanTable";
import PlanVersionBar from "./PlanVersionBar";
import ReplanPanel from "./ReplanPanel";
import StatusBadge from "./StatusBadge";

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

  const refreshState = useCallback(() => {
    void getState(pid).then(setState, () => undefined);
  }, [pid]);

  useEffect(() => {
    refreshState();
    const timer = setInterval(() => document.visibilityState === "visible" && refreshState(), POLL_MS);
    return () => clearInterval(timer);
  }, [refreshState, workspace.project.current_plan_version]);

  const activeTasks = workspace.tasks.filter((task) => !task.archived && task.plan_status !== "cancelled");
  const hasBrief = workspace.brief.content.trim().length > 0;
  const hasPlan = activeTasks.length > 0 || workspace.milestones.some((milestone) => !milestone.archived);

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
      setNotice(result.analysis?.replan?.created
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

        <section className="relative overflow-hidden rounded-lg border border-link/35 bg-gradient-to-br from-link/15 via-surface to-purple-500/10 p-5">
          <div className="absolute -right-12 -top-12 h-40 w-40 rounded-full bg-link/10 blur-3xl" />
          <div className="relative">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green opacity-50" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-green" />
                  </span>
                  <h2 className="font-semibold text-header">Planning agent</h2>
                  {usingMockApi && <span className={pillCls}>Demo mode</span>}
                </div>
                <p className="mt-1 text-sm text-muted">Turns the brief into a plan, watches project events, and proposes evidence-backed updates.</p>
              </div>
              <span className="rounded-full border border-green/25 bg-green/10 px-2 py-1 text-xs font-medium text-green">Monitoring</span>
            </div>

            <div className="mt-5 grid grid-cols-3 gap-2">
              <AgentMetric label="Plan" value={workspace.project.current_plan_version ? `v${workspace.project.current_plan_version}` : "Draft"} />
              <AgentMetric label="Tasks" value={String(activeTasks.length)} />
              <AgentMetric label="Last analysis" value={state?.computed_at ? timeAgo(state.computed_at) : "Waiting"} />
            </div>

            <div className="mt-5 rounded-md border border-line bg-bg/50 p-3 text-sm">
              {!hasBrief ? (
                <p className="text-muted">Write the brief first. Pit Crew needs goals, requirements, constraints, and a definition of done.</p>
              ) : !hasPlan ? (
                <p className="text-text">Your brief is ready. Generate an organized first plan with milestones, ownership, scope, dates, and dependencies.</p>
              ) : (
                <p className="text-text">
                  Watching timeline events and repository activity. Material drift appears below as a reviewable plan update.
                  {state?.open_replans ? <strong className="ml-1 text-yellow">{state.open_replans} update waiting.</strong> : null}
                </p>
              )}
            </div>

            {error && <p className="mt-3 rounded-md border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{error}</p>}
            {notice && <p className="mt-3 rounded-md border border-green/30 bg-green/10 px-3 py-2 text-sm text-green">{notice}</p>}

            <div className="mt-4 flex flex-wrap gap-2">
              {!hasPlan ? (
                <button className={buttonCls} disabled={!hasBrief || busy !== null} onClick={generate}>
                  {busy === "generate" ? "Building plan…" : "Build plan from brief"}
                </button>
              ) : (
                <button className={buttonCls} disabled={busy !== null} onClick={sync}>
                  {busy === "sync" ? "Analyzing…" : "Sync timeline now"}
                </button>
              )}
              <span className="self-center text-xs text-muted">Automatic analysis also runs after new events and on the background sweep.</span>
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

function AgentMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-bg/50 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-faint">{label}</div>
      <div className="mt-0.5 truncate text-sm font-semibold text-header">{value}</div>
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
          const complete = items.filter((task) => (stateByTask.get(task.task_id)?.effective_status ?? task.plan_status) === "complete").length;
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

function RoadmapTask({ task, effective, dependencies }: { task: Task; effective?: DerivedStatus; dependencies: number }) {
  return (
    <div className="rounded-md border border-line bg-bg px-3 py-3 transition-colors hover:border-line-strong hover:bg-raised/50">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[10px] text-link">{task.task_key}</div>
          <div className="mt-0.5 font-medium text-header">{task.title}</div>
        </div>
        <StatusBadge status={effective ?? task.plan_status} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted">
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
