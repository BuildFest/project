"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  clearTaskOverride,
  dismissCollision,
  dismissSignal,
  getState,
  overrideTaskStatus,
  updateTask,
  usingMockApi,
} from "@/lib/api";
import { useActingMember } from "@/lib/actingAs";
import type {
  Collision,
  DerivedStatus,
  DerivedTaskState,
  HealthSignal,
  ProjectState,
  ProjectWorkspace,
  Task,
} from "@/lib/types";
import {
  boxCls,
  boxHeaderCls,
  boxTitleCls,
  buttonCls,
  derivedAsPlan,
  formatDate,
  ghostButtonCls,
  inputCls,
  pillCls,
  planAsDerived,
  smallButtonCls,
  timeAgo,
} from "@/lib/ui";
import {
  IconAlert,
  IconBranches,
  IconCheck,
  IconClock,
  IconInfo,
  IconMilestone,
  IconPeople,
  IconStop,
} from "./Icons";
import EvidenceDrawer from "./EvidenceDrawer";
import RepositoryPanel from "./repo/RepositoryPanel";
import ReplanPanel from "./ReplanPanel";
import StatusBadge from "./StatusBadge";

const POLL_MS = 10_000; // contract §1: dashboard polls /state about every 10 s

const smallBtn = smallButtonCls;

export default function Overview({
  workspace,
  onWorkspaceChange,
}: {
  workspace: ProjectWorkspace;
  onWorkspaceChange: (w: ProjectWorkspace) => void;
}) {
  const pid = workspace.project.project_id;
  const { member } = useActingMember(workspace);
  const [state, setState] = useState<ProjectState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [evidenceFor, setEvidenceFor] = useState<string | null>(null);

  const describe = (e: unknown) =>
    e instanceof ApiError && e.status === 404
      ? "Project intelligence (/state, contract §5.1) isn't available on the backend yet."
      : e instanceof Error
        ? e.message
        : "Couldn't load project state.";

  const refresh = useCallback(
    () =>
      getState(pid).then(
        (s) => {
          setState(s);
          setError(null);
        },
        (e) => setError(describe(e))
      ),
    [pid]
  );

  // Initial load + re-analyze whenever the plan changes (mock recomputes).
  useEffect(() => {
    let cancelled = false;
    getState(pid).then(
      (s) => {
        if (!cancelled) {
          setState(s);
          setError(null);
        }
      },
      (e) => !cancelled && setError(describe(e))
    );
    return () => {
      cancelled = true;
    };
  }, [pid, workspace]);

  useEffect(() => {
    const id = setInterval(() => document.visibilityState === "visible" && refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const closeDrawer = useCallback(() => setEvidenceFor(null), []);

  const needMember = () => {
    setNotice("Add a team member to this project first. Corrections are recorded under a member's name.");
    return undefined;
  };

  async function act(fn: () => Promise<unknown>, done?: string) {
    try {
      setNotice(null);
      await fn();
      if (done) setNotice(done);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setNotice("Pit Crew re-analyzed this task while you were looking. Check the new status and try again.");
      } else {
        setNotice(e instanceof Error ? e.message : "Something went wrong.");
      }
    } finally {
      await refresh();
    }
  }

  if (error && !state) {
    return (
      <div className={`${boxCls} px-4 py-8 text-center`}>
        <p className="text-sm text-red">{error}</p>
        <button className={`${ghostButtonCls} mt-3`} onClick={refresh}>Try again</button>
      </div>
    );
  }

  const tasks = workspace.tasks.filter((t) => !t.archived && t.plan_status !== "cancelled");
  const stateOf = new Map((state?.tasks ?? []).map((d) => [d.task_id, d]));
  const byId = new Map(workspace.tasks.map((t) => [t.task_id, t]));
  const eff = (t: Task) => stateOf.get(t.task_id)?.effective_status;
  const disagree = (t: Task) => {
    const d = stateOf.get(t.task_id);
    return !!d && planAsDerived(t.plan_status) !== d.effective_status;
  };
  const mismatched = tasks.filter(disagree).length;
  const attention = (state?.signals.length ?? 0) + (state?.collisions.length ?? 0);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
      <div className="min-w-0 space-y-6">
        {notice && (
          <div className="flex items-start justify-between gap-3 rounded-md border border-link/40 bg-link/10 px-4 py-2.5 text-sm text-header">
            <span>{notice}</span>
            <button className="text-xs text-muted hover:text-header" onClick={() => setNotice(null)}>Dismiss</button>
          </div>
        )}

        {/* Needs attention */}
        <section className={boxCls}>
          <div className={boxHeaderCls}>
            <h2 className={boxTitleCls}>
              Needs attention
              {state && <span className="ml-2 rounded-full bg-btn px-1.5 text-xs font-medium text-text">{attention}</span>}
            </h2>
            <div className="flex items-center gap-3 text-xs text-muted">
              {usingMockApi && <span className={pillCls} title="Backend /state isn't connected; this is computed in the browser">Sample analysis</span>}
              {state && <span>Updated {timeAgo(state.computed_at)}</span>}
            </div>
          </div>

          {!state ? (
            <p className="px-4 py-6 text-sm text-muted">Analyzing…</p>
          ) : attention === 0 ? (
            <div className="px-4 py-8 text-center">
              <IconCheck className="mx-auto text-green" />
              <p className="mt-2 font-semibold text-header">All clear</p>
              <p className="text-sm text-muted">The plan and the repository agree.</p>
            </div>
          ) : (
            <ul>
              {state.collisions.map((c) => (
                <CollisionRow key={c.collision_id} c={c} byId={byId}
                  onDismiss={() => member ? act(() => dismissCollision(pid, c.collision_id, member.member_id)) : needMember()} />
              ))}
              {[...state.signals]
                .sort((a, b) => sevRank(a.severity) - sevRank(b.severity))
                .map((s) => (
                  <SignalRow key={s.signal_id} s={s} byId={byId}
                    onEvidence={(id) => setEvidenceFor(id)}
                    onDismiss={() => member ? act(() => dismissSignal(pid, s.signal_id, member.member_id)) : needMember()} />
                ))}
            </ul>
          )}
        </section>

        <ReplanPanel workspace={workspace} memberId={member?.member_id ?? null}
          refreshKey={state?.computed_at ?? ""}
          onWorkspaceChange={onWorkspaceChange} onNotice={setNotice} />

        {/* Plan vs reality */}
        <section className={boxCls}>
          <div className={boxHeaderCls}>
            <h2 className={boxTitleCls}>Plan vs. reality</h2>
            <span className="text-xs text-muted">
              {state ? (mismatched ? `${mismatched} task${mismatched === 1 ? "" : "s"} where the plan and repo disagree` : "Plan and repo agree") : ""}
            </span>
          </div>
          {tasks.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted">No tasks in the plan yet. Add some in the Plan tab.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="border-b border-line text-xs text-muted">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Task</th>
                    <th className="px-2 py-2 font-semibold">Owner</th>
                    <th className="px-2 py-2 font-semibold">Plan says</th>
                    <th className="px-2 py-2 font-semibold">Repo says</th>
                    <th className="px-2 py-2 font-semibold">Last activity</th>
                    <th className="px-4 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <TaskRow key={t.task_id} task={t} d={stateOf.get(t.task_id)}
                      owner={workspace.members.find((m) => m.member_id === t.owner_member_id)}
                      mismatch={disagree(t)}
                      onEvidence={() => setEvidenceFor(t.task_id)}
                      onOverride={(status, reason) =>
                        !member ? needMember() : act(
                          () =>
                            overrideTaskStatus(pid, t.task_id, {
                              override_status: status,
                              reason,
                              member_id: member.member_id,
                              version: stateOf.get(t.task_id)?.version ?? 1,
                            }),
                          `Corrected ${t.task_key}. Your correction takes priority over Pit Crew's inference.`
                        )
                      }
                      onClearOverride={() => act(() => clearTaskOverride(pid, t.task_id))}
                      onAcceptObserved={(status) =>
                        act(async () => {
                          onWorkspaceChange(await updateTask(pid, t.task_id, { plan_status: derivedAsPlan(status) }));
                        }, `Updated the plan: ${t.task_key} is now "${status.replace("_", " ")}".`)
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <Sidebar workspace={workspace} eff={eff} tasks={tasks} />

      {evidenceFor && <EvidenceDrawer workspace={workspace} taskId={evidenceFor} onClose={closeDrawer} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right-hand "About" column, like a GitHub repository page.

function Sidebar({
  workspace,
  tasks,
  eff,
}: {
  workspace: ProjectWorkspace;
  tasks: Task[];
  eff: (t: Task) => DerivedStatus | undefined;
}) {
  const { project, brief, members, milestones } = workspace;
  const done = tasks.filter((t) => eff(t) === "complete").length;
  const inProgress = tasks.filter((t) => eff(t) === "in_progress").length;
  const blocked = tasks.filter((t) => eff(t) === "possibly_blocked").length;
  const notStarted = tasks.length - done - inProgress - blocked;
  const pct = (n: number) => (tasks.length ? (n / tasks.length) * 100 : 0);
  // First real sentence of the brief (skip headings, list markers, code fences).
  const excerpt = brief.content
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^(#|```|- \[|[-*]\s*$|>)/.test(l))
    ?.replace(/^[-*]\s+/, "")
    .replace(/[*_`]/g, "");

  return (
    <aside className="space-y-6 text-sm">
      <section>
        <h3 className="mb-2 text-base font-semibold text-header">About</h3>
        <p className="text-text">{excerpt || <span className="text-muted">No brief yet.</span>}</p>
        <ul className="mt-3 space-y-1.5 text-muted">
          <li className="flex items-center gap-2"><IconClock /> Due {formatDate(project.deadline_at)}</li>
          <li className="flex items-center gap-2"><IconBranches /> Task keys <span className="font-mono text-text">{project.task_key_prefix}-1</span>, <span className="font-mono text-text">{project.task_key_prefix}-2</span>…</li>
        </ul>
      </section>

      <RepositoryPanel workspace={workspace} />

      <section className="border-t border-line pt-5">
        <h3 className="mb-2 text-sm font-semibold text-header">Progress</h3>
        <div className="flex h-2 overflow-hidden rounded-full bg-btn">
          <span className="bg-green" style={{ width: `${pct(done)}%` }} />
          <span className="bg-blue" style={{ width: `${pct(inProgress)}%` }} />
          <span className="bg-yellow" style={{ width: `${pct(blocked)}%` }} />
        </div>
        <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          <li><span className="mr-1 inline-block h-2 w-2 rounded-full bg-green" /> <span className="font-semibold text-header">{done}</span> complete</li>
          <li><span className="mr-1 inline-block h-2 w-2 rounded-full bg-blue" /> <span className="font-semibold text-header">{inProgress}</span> in progress</li>
          {blocked > 0 && <li><span className="mr-1 inline-block h-2 w-2 rounded-full bg-yellow" /> <span className="font-semibold text-header">{blocked}</span> possibly blocked</li>}
          <li><span className="mr-1 inline-block h-2 w-2 rounded-full bg-btn" /> <span className="font-semibold text-header">{notStarted}</span> not started</li>
        </ul>
      </section>

      <section className="border-t border-line pt-5">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-header">
          Team <span className="rounded-full bg-btn px-1.5 text-xs font-medium text-text">{members.length}</span>
        </h3>
        <ul className="space-y-1.5">
          {members.map((m) => (
            <li key={m.member_id} className="flex items-center gap-2">
              <span className="grid h-5 w-5 place-items-center rounded-full bg-btn text-[10px] font-semibold text-header">
                {m.display_name.slice(0, 1).toUpperCase()}
              </span>
              <span className="text-header">{m.display_name}</span>
              {m.github_login && m.github_login !== m.display_name && <span className="text-muted">@{m.github_login}</span>}
            </li>
          ))}
          {members.length === 0 && <li className="flex items-center gap-2 text-muted"><IconPeople /> No members yet</li>}
        </ul>
      </section>

      <section className="border-t border-line pt-5">
        <h3 className="mb-2 text-sm font-semibold text-header">Milestones</h3>
        {milestones.filter((m) => !m.archived).length === 0 ? (
          <p className="text-muted">None yet. Add them in the Plan tab.</p>
        ) : (
          <ul className="space-y-2">
            {milestones.filter((m) => !m.archived).map((m) => {
              const mt = tasks.filter((t) => t.milestone_id === m.milestone_id);
              const md = mt.filter((t) => eff(t) === "complete").length;
              return (
                <li key={m.milestone_id}>
                  <div className="flex items-center gap-2 text-header"><IconMilestone className="text-muted" /> {m.name}</div>
                  <div className="ml-6 text-xs text-muted">{md}/{mt.length} complete · due {formatDate(m.target_at)}</div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </aside>
  );
}

// ---------------------------------------------------------------------------

const sevRank = (s: HealthSignal["severity"]) => ({ critical: 0, warning: 1, info: 2 })[s];

const SIGNAL_LABEL: Record<HealthSignal["type"], string> = {
  milestone_slipping: "Milestone slipping",
  dependency_incomplete: "Dependency incomplete",
  must_have_no_activity: "No activity on a must-have",
  plan_state_disagreement: "Plan and repo disagree",
  task_possibly_blocked: "Possibly blocked",
};

function SignalRow({
  s,
  byId,
  onEvidence,
  onDismiss,
}: {
  s: HealthSignal;
  byId: Map<string, Task>;
  onEvidence: (taskId: string) => void;
  onDismiss: () => void;
}) {
  const Icon = s.severity === "critical" ? IconStop : s.severity === "warning" ? IconAlert : IconInfo;
  const color = s.severity === "critical" ? "text-red" : s.severity === "warning" ? "text-yellow" : "text-link";
  const tasks = s.related_task_ids.map((id) => byId.get(id)).filter((t): t is Task => !!t);
  return (
    <li className="flex gap-3 border-b border-line px-4 py-3 last:border-b-0 hover:bg-raised/60">
      <Icon className={`mt-0.5 shrink-0 ${color}`} />
      <div className="min-w-0 flex-1">
        <button className="text-left font-semibold text-header hover:text-link"
          onClick={() => tasks[0] && onEvidence(tasks[0].task_id)}>
          {s.title}
        </button>
        <p className="text-sm text-muted">{s.explanation}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted">
          <span>{SIGNAL_LABEL[s.type] ?? s.type}</span>
          {tasks.map((t) => (
            <span key={t.task_id}>
              ·{" "}
              <button className="font-mono hover:text-link hover:underline" onClick={() => onEvidence(t.task_id)}>{t.task_key}</button>
            </span>
          ))}
          {s.evidence_event_ids.length > 0 && <span>· {s.evidence_event_ids.length} event{s.evidence_event_ids.length === 1 ? "" : "s"}</span>}
        </div>
      </div>
      <button className={`${smallBtn} self-start`} onClick={onDismiss}>Dismiss</button>
    </li>
  );
}

function CollisionRow({
  c,
  byId,
  onDismiss,
}: {
  c: Collision;
  byId: Map<string, Task>;
  onDismiss: () => void;
}) {
  const key = (id: string | null) => (id && byId.get(id)?.task_key) || null;
  const n = c.overlapping_files.length;
  return (
    <li className="flex gap-3 border-b border-line px-4 py-3 last:border-b-0 hover:bg-raised/60">
      <IconBranches className="mt-0.5 shrink-0 text-signal" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-header">
          Two active branches change the same {n === 1 ? "file" : `${n} files`}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted">
          <span className="rounded-md bg-link/10 px-1.5 font-mono text-xs text-link">{c.branch_a}</span>
          and
          <span className="rounded-md bg-link/10 px-1.5 font-mono text-xs text-link">{c.branch_b}</span>
        </div>
        <ul className="mt-2 font-mono text-xs text-text">
          {c.overlapping_files.map((f) => (<li key={f} className="truncate">{f}</li>))}
        </ul>
        <div className="mt-1 text-xs text-muted">
          Collision risk
          {(key(c.task_a_id) || key(c.task_b_id)) && <> · {[key(c.task_a_id), key(c.task_b_id)].filter(Boolean).join(", ")}</>}
          {" "}· not a guaranteed conflict, worth a quick sync
        </div>
      </div>
      <button className={`${smallBtn} self-start`} onClick={onDismiss}>Dismiss</button>
    </li>
  );
}

const OVERRIDE_OPTIONS: DerivedStatus[] = ["not_started", "in_progress", "possibly_blocked", "complete"];

function TaskRow({
  task: t,
  d,
  owner,
  mismatch,
  onEvidence,
  onOverride,
  onClearOverride,
  onAcceptObserved,
}: {
  task: Task;
  d: DerivedTaskState | undefined;
  owner: ProjectWorkspace["members"][number] | undefined;
  mismatch: boolean;
  onEvidence: () => void;
  onOverride: (status: DerivedStatus, reason: string) => void;
  onClearOverride: () => void;
  onAcceptObserved: (status: DerivedStatus) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<DerivedStatus>(d?.effective_status ?? "in_progress");
  const [reason, setReason] = useState("");

  return (
    <>
      <tr className="border-b border-line align-middle last:border-b-0 hover:bg-raised/60">
        <td className="px-4 py-2.5">
          <button onClick={onEvidence} className="text-left font-semibold text-header hover:text-link">{t.title}</button>
          <div className="text-xs text-muted">
            <span className="font-mono">{t.task_key}</span>
            {t.scope === "optional" && " · optional"}
          </div>
        </td>
        <td className="px-2 py-2.5 text-muted">
          {owner ? (owner.github_login ? `@${owner.github_login}` : owner.display_name) : <span className="text-faint">—</span>}
        </td>
        <td className="px-2 py-2.5"><StatusBadge status={t.plan_status} /></td>
        <td className="px-2 py-2.5">
          {d ? (
            <div className="flex items-center gap-2">
              <StatusBadge status={d.effective_status} />
              {mismatch && <span className="text-xs text-yellow" title="Plan and repository disagree">≠ plan</span>}
              {d.override_status && <span className="text-xs text-muted" title={d.override_reason ?? undefined}>(corrected)</span>}
            </div>
          ) : (
            <span className="text-xs text-faint">Not analyzed</span>
          )}
        </td>
        <td className="px-2 py-2.5 text-xs text-muted">{timeAgo(d?.last_activity_at ?? null)}</td>
        <td className="px-4 py-2.5">
          <div className="flex items-center justify-end gap-2">
            {mismatch && d && (
              <button className={smallBtn} title="Set the plan's status to what the repo shows"
                onClick={() => onAcceptObserved(d.effective_status)}>
                Update plan
              </button>
            )}
            {d?.override_status ? (
              <button className="text-xs text-link hover:underline" onClick={onClearOverride}>Undo correction</button>
            ) : (
              d && <button className="text-xs text-link hover:underline" onClick={() => setEditing((v) => !v)}>Correct</button>
            )}
          </div>
        </td>
      </tr>
      {editing && d && (
        <tr className="border-b border-line bg-raised">
          <td colSpan={6} className="px-4 py-3">
            <form
              className="flex flex-wrap items-center gap-2 text-sm"
              onSubmit={(e) => {
                e.preventDefault();
                onOverride(choice, reason);
                setEditing(false);
                setReason("");
              }}
            >
              <span className="text-muted"><span className="font-mono text-header">{t.task_key}</span> is actually</span>
              <select className={inputCls} value={choice} onChange={(e) => setChoice(e.target.value as DerivedStatus)}>
                {OVERRIDE_OPTIONS.map((o) => (<option key={o} value={o}>{o.replace("_", " ")}</option>))}
              </select>
              <input className={`${inputCls} min-w-60 flex-1`} placeholder="Reason (optional)"
                value={reason} onChange={(e) => setReason(e.target.value)} />
              <button className={buttonCls}>Save</button>
              <button type="button" className={ghostButtonCls} onClick={() => setEditing(false)}>Cancel</button>
            </form>
          </td>
        </tr>
      )}
    </>
  );
}
