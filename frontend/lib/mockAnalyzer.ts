// Stand-in for Person 2's analyzers, used only in mock mode.
// It follows the same rules the MVP doc describes (task-key matching, derived
// status, dependency / milestone / disagreement signals, file-set collisions)
// so the dashboard can be built and demoed before /state exists. The real
// backend replaces all of this via GET /projects/:id/state.

import { applyPlanChanges, mockEventsFor, mockWorkspace } from "./mockApi";
import { planAsDerived } from "./ui";
import type {
  Collision,
  DerivedStatus,
  DerivedTaskState,
  EventTaskLink,
  GithubEvent,
  HealthSignal,
  PlanChange,
  ReplanSuggestion,
  ProjectState,
  ProjectWorkspace,
  Task,
  TaskEvidence,
} from "./types";

const OVERRIDES_KEY = "pitcrew.mock.overrides.v1";
const DISMISSED_KEY = "pitcrew.mock.dismissed.v1";

type OverrideRec = { status: DerivedStatus; reason: string | null; by: string; at: string; version: number };

function read<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "") as T;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

const overridesFor = (pid: string) => read<Record<string, Record<string, OverrideRec>>>(OVERRIDES_KEY, {})[pid] ?? {};
const dismissedFor = (pid: string) => new Set(read<Record<string, string[]>>(DISMISSED_KEY, {})[pid] ?? []);
const LINK_REVIEWS_KEY = "pitcrew.mock.linkReviews.v1";
type LinkReview = "confirmed" | "rejected";
const reviewsFor = (pid: string) => read<Record<string, Record<string, LinkReview>>>(LINK_REVIEWS_KEY, {})[pid] ?? {};


interface Analysis {
  state: ProjectState;
  links: Array<EventTaskLink & { event: GithubEvent }>;
}

function analyze(w: ProjectWorkspace): Analysis {
  const pid = w.project.project_id;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const events = mockEventsFor(w);
  const tasks = w.tasks.filter((t) => !t.archived && t.plan_status !== "cancelled");
  const byKey = new Map(tasks.map((t) => [t.task_key.toUpperCase(), t]));
  const byId = new Map(w.tasks.map((t) => [t.task_id, t]));
  const re = new RegExp(`\\b(${w.project.task_key_prefix}-\\d+)\\b`, "i");

  // 1. Deterministic task-key links.
  const links: Analysis["links"] = [];
  for (const e of events) {
    for (const text of [e.branch, e.pull_request?.title, e.commit?.message]) {
      const m = text?.match(re);
      const t = m && byKey.get(m[1].toUpperCase());
      if (t) {
        links.push({
          link_id: `link_${e.event_id}`,
          project_id: pid,
          event_id: e.event_id,
          task_id: t.task_id,
          method: "task_key",
          confidence: 1,
          status: "confirmed",
          is_primary: true,
          event: e,
        });
        break;
      }
    }
  }
  // 1b. Stand-in for B's LLM linker: commits no task key explains get a
  // suggested link to the author's own open task (or the first task).
  // Reviews persist; >= 0.8 counts toward status before review (§5.1).
  const reviews = reviewsFor(pid);
  const keyed = new Set(links.map((l) => l.event_id));
  const pending: Analysis["links"] = [];
  for (const e of events) {
    if (keyed.has(e.event_id) || e.event_type !== "commit") continue;
    const author = w.members.find((m) => m.github_login && m.github_login.toLowerCase() === e.actor?.toLowerCase());
    const own = author && tasks.find((t) => t.owner_member_id === author.member_id && t.plan_status !== "complete");
    const t = own ?? tasks[0];
    const review = reviews[`link_llm_${e.event_id}`];
    if (!t || review === "rejected") continue;
    const link: Analysis["links"][number] = {
      link_id: `link_llm_${e.event_id}`,
      project_id: pid,
      event_id: e.event_id,
      task_id: t.task_id,
      method: "llm",
      confidence: own ? 0.82 : 0.55,
      status: review ?? "suggested",
      is_primary: false,
      reason: own
        ? `${author!.display_name} owns ${t.task_key} and made this commit while it was open.`
        : `No task key in the message; ${t.task_key} is the closest open task.`,
      event: e,
    };
    if (review === "confirmed" || link.confidence >= 0.8) links.push(link);
    if (!review) pending.push(link);
  }
  const eventsFor = (taskId: string) => links.filter((l) => l.task_id === taskId).map((l) => l.event);

  // 2. Computed status per task (before dependency rules).
  const base = new Map<string, { status: DerivedStatus; conf: number; why: string; last: string | null; ev: string[] }>();
  for (const t of tasks) {
    const evs = eventsFor(t.task_id);
    const last = evs.reduce<string | null>((a, e) => (!a || e.occurred_at > a ? e.occurred_at : a), null);
    const merged = evs.find((e) => e.event_type === "pull_request_merged");
    if (merged) {
      base.set(t.task_id, { status: "complete", conf: 0.95, why: `PR #${merged.pull_request?.number} was merged into ${merged.pull_request?.base_branch}.`, last, ev: evs.map((e) => e.event_id) });
    } else if (evs.length) {
      const prs = evs.filter((e) => e.event_type === "pull_request_opened").length;
      base.set(t.task_id, {
        status: "in_progress",
        conf: 0.8,
        why: `${evs.length} linked event${evs.length === 1 ? "" : "s"}${prs ? `, including an open PR` : ""}, but nothing merged yet.`,
        last,
        ev: evs.map((e) => e.event_id),
      });
    } else {
      base.set(t.task_id, { status: "not_started", conf: 0.6, why: "No branch, commit or PR mentions this task yet.", last: null, ev: [] });
    }
  }

  const overrides = overridesFor(pid);
  const effectiveOf = (id: string): DerivedStatus | undefined =>
    overrides[id]?.status ?? base.get(id)?.status;

  // 3. Dependency rule: active work on top of unfinished dependencies.
  const derived: DerivedTaskState[] = tasks.map((t) => {
    const b = base.get(t.task_id)!;
    const blocking = w.dependencies
      .filter((d) => d.task_id === t.task_id)
      .map((d) => d.depends_on_task_id)
      .filter((id) => byId.get(id) && effectiveOf(id) !== "complete");
    let status = b.status;
    let why = b.why;
    if (status === "in_progress" && blocking.length) {
      status = "possibly_blocked";
      why = `Work has started, but it depends on ${blocking.map((id) => byId.get(id)!.task_key).join(", ")}, which ${blocking.length === 1 ? "isn't" : "aren't"} complete.`;
    }
    const o = overrides[t.task_id];
    return {
      project_id: pid,
      task_id: t.task_id,
      computed_status: status,
      override_status: o?.status ?? null,
      effective_status: o?.status ?? status,
      confidence: b.conf,
      evidence_event_ids: b.ev,
      last_activity_at: b.last,
      blocking_task_ids: blocking,
      explanation: why,
      computation_method: "rules",
      computed_at: nowIso,
      override_by: o?.by ?? null,
      override_at: o?.at ?? null,
      override_reason: o?.reason ?? null,
      version: o?.version ?? 1,
    };
  });
  const stateOf = new Map(derived.map((d) => [d.task_id, d]));

  // 4. Health signals.
  const signals: HealthSignal[] = [];
  const add = (s: Omit<HealthSignal, "signal_id" | "project_id" | "status" | "detected_at" | "resolved_at">, fp: string) => {
    signals.push({ ...s, signal_id: `sig_${fp}`, project_id: pid, status: "active", detected_at: nowIso, resolved_at: null });
  };
  const label: Record<DerivedStatus, string> = {
    not_started: "not started",
    in_progress: "in progress",
    complete: "complete",
    possibly_blocked: "possibly blocked",
  };

  for (const t of tasks) {
    const d = stateOf.get(t.task_id)!;
    const planned = planAsDerived(t.plan_status);
    if (planned && planned !== d.effective_status) {
      add({
        type: "plan_state_disagreement",
        severity: "warning",
        title: `${t.task_key}: plan says ${label[planned]}, repo says ${label[d.effective_status]}`,
        explanation: d.explanation ?? "",
        related_task_ids: [t.task_id],
        related_milestone_ids: [],
        evidence_event_ids: d.evidence_event_ids,
      }, `disagree_${t.task_id}_${d.effective_status}`);
    }
    if (d.blocking_task_ids.length && d.effective_status !== "complete" && d.effective_status !== "not_started") {
      const keys = d.blocking_task_ids.map((id) => byId.get(id)!.task_key).join(", ");
      add({
        type: "dependency_incomplete",
        severity: "warning",
        title: `${t.task_key} is moving ahead of ${keys}`,
        explanation: `${t.task_key} has activity, but its dependency ${keys} isn't complete yet. Its work may need to wait or be reordered.`,
        related_task_ids: [t.task_id, ...d.blocking_task_ids],
        related_milestone_ids: [],
        evidence_event_ids: d.evidence_event_ids,
      }, `dep_${t.task_id}_${d.blocking_task_ids.join("_")}`);
    }
  }

  for (const m of w.milestones.filter((m) => !m.archived && m.target_at)) {
    const mt = tasks.filter((t) => t.milestone_id === m.milestone_id);
    const open = mt.filter((t) => stateOf.get(t.task_id)!.effective_status !== "complete");
    if (!open.length) continue;
    const left = new Date(m.target_at!).getTime() - now;
    const hours = left / 3_600_000;
    if (left < 0 || hours < 6) {
      const when = left < 0 ? `was due ${fmtDur(-left)} ago` : `is due in ${fmtDur(left)}`;
      add({
        type: "milestone_slipping",
        severity: left < 0 ? "critical" : "warning",
        title: `Milestone "${m.name}" ${when}`,
        explanation: `${open.length} of ${mt.length} task${mt.length === 1 ? "" : "s"} still open: ${open.map((t) => t.task_key).join(", ")}.`,
        related_task_ids: open.map((t) => t.task_id),
        related_milestone_ids: [m.milestone_id],
        evidence_event_ids: [],
      }, `ms_${m.milestone_id}_${left < 0 ? "late" : "soon"}`);
    }
  }

  const deadline = w.project.deadline_at ? new Date(w.project.deadline_at).getTime() : null;
  for (const t of tasks) {
    const d = stateOf.get(t.task_id)!;
    if (t.scope !== "must_have" || d.effective_status !== "not_started") continue;
    const due = t.target_at ? new Date(t.target_at).getTime() : deadline;
    if (due !== null && due - now < 8 * 3_600_000) {
      add({
        type: "must_have_no_activity",
        severity: due < now ? "critical" : "warning",
        title: `Must-have ${t.task_key} has no activity yet`,
        explanation: `"${t.title}" is required and ${due < now ? "is past its target" : `is due in ${fmtDur(due - now)}`}, but no branch, commit or PR mentions ${t.task_key}.`,
        related_task_ids: [t.task_id],
        related_milestone_ids: [],
        evidence_event_ids: [],
      }, `idle_${t.task_id}`);
    }
  }

  // 5. Collisions: active branches whose changed-file sets intersect.
  const files = new Map<string, Set<string>>();
  const inactive = new Set<string>();
  for (const e of events) {
    if (!e.branch || e.branch === "main" || e.branch === "master") continue;
    if (e.event_type === "pull_request_merged" || e.event_type === "branch_deleted") inactive.add(e.branch);
    if (!files.has(e.branch)) files.set(e.branch, new Set());
    e.changed_files.forEach((f) => files.get(e.branch!)!.add(f));
  }
  const active = [...files.keys()].filter((b) => !inactive.has(b)).sort();
  const taskOfBranch = (b: string) => {
    const m = b.match(re);
    return (m && byKey.get(m[1].toUpperCase())?.task_id) || null;
  };
  const collisions: Collision[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      const overlap = [...files.get(a)!].filter((f) => files.get(b)!.has(f)).sort();
      if (!overlap.length) continue;
      const fp = `col_${a}_${b}_${overlap.join(",")}`;
      collisions.push({
        collision_id: fp,
        project_id: pid,
        repository_id: "repo_MOCK",
        branch_a: a,
        branch_b: b,
        task_a_id: taskOfBranch(a),
        task_b_id: taskOfBranch(b),
        overlapping_files: overlap,
        status: "active",
        detected_at: nowIso,
        resolved_at: null,
      });
    }
  }

  const dismissed = dismissedFor(pid);
  return {
    state: {
      computed_at: nowIso,
      tasks: derived,
      signals: signals.filter((s) => !dismissed.has(s.signal_id)),
      collisions: collisions.filter((c) => !dismissed.has(c.collision_id)),
      pending_links: pending,
      open_replans: 0,
    },
    links,
  };
}

function fmtDur(ms: number) {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

// ---- mock endpoints ---------------------------------------------------------

export async function getState(projectId: string): Promise<ProjectState> {
  return analyze(mockWorkspace(projectId)).state;
}

export async function getTaskEvidence(projectId: string, taskId: string): Promise<TaskEvidence> {
  const w = mockWorkspace(projectId);
  const { state, links } = analyze(w);
  const task = w.tasks.find((t) => t.task_id === taskId);
  if (!task) throw new Error("Task not found");
  const st = state.tasks.find((d) => d.task_id === taskId) ?? null;
  const byId = new Map(w.tasks.map((t) => [t.task_id, t]));
  return {
    task,
    state: st,
    blocking_tasks: w.dependencies
      .filter((d) => d.task_id === taskId)
      .map((d) => byId.get(d.depends_on_task_id))
      .filter((t): t is Task => !!t)
      .map((t) => ({ task: t, state: state.tasks.find((d) => d.task_id === t.task_id) ?? null })),
    links: links
      .filter((l) => l.task_id === taskId)
      .sort((a, b) => b.event.occurred_at.localeCompare(a.event.occurred_at)),
    signals: state.signals.filter((s) => s.related_task_ids.includes(taskId)),
  };
}

export async function setOverride(
  projectId: string,
  taskId: string,
  input: { override_status: DerivedStatus; reason?: string; member_id: string }
): Promise<void> {
  const all = read<Record<string, Record<string, OverrideRec>>>(OVERRIDES_KEY, {});
  const prev = all[projectId]?.[taskId];
  all[projectId] = {
    ...(all[projectId] ?? {}),
    [taskId]: {
      status: input.override_status,
      reason: input.reason?.trim() || null,
      by: input.member_id,
      at: new Date().toISOString(),
      version: (prev?.version ?? 1) + 1,
    },
  };
  write(OVERRIDES_KEY, all);
}

export async function clearOverride(projectId: string, taskId: string): Promise<void> {
  const all = read<Record<string, Record<string, OverrideRec>>>(OVERRIDES_KEY, {});
  if (all[projectId]) delete all[projectId][taskId];
  write(OVERRIDES_KEY, all);
}

export async function reviewLink(projectId: string, linkId: string, status: LinkReview): Promise<void> {
  const all = read<Record<string, Record<string, LinkReview>>>(LINK_REVIEWS_KEY, {});
  all[projectId] = { ...(all[projectId] ?? {}), [linkId]: status };
  write(LINK_REVIEWS_KEY, all);
}

export async function dismiss(projectId: string, id: string): Promise<void> {
  const all = read<Record<string, string[]>>(DISMISSED_KEY, {});
  all[projectId] = [...new Set([...(all[projectId] ?? []), id])];
  write(DISMISSED_KEY, all);
}

// ---- replan suggestions (mock of §5.7) ---------------------------------------
// Rules-based: turns active signals into a small set of concrete plan edits.

const REVIEWED_KEY = "pitcrew.mock.replans.reviewed.v1";

function suggest(w: ProjectWorkspace): ReplanSuggestion[] {
  const { state } = analyze(w);
  const byId = new Map(w.tasks.map((t) => [t.task_id, t]));
  const out: ReplanSuggestion[] = [];
  const version = w.project.current_plan_version ?? 1;
  const nowIso = new Date().toISOString();

  const make = (id: string, rationale: string, changes: PlanChange[], signalIds: string[], ev: string[]) => {
    if (!changes.length) return;
    out.push({
      suggestion_id: `rp_${id}`,
      project_id: w.project.project_id,
      based_on_plan_version: version,
      status: "proposed",
      rationale,
      proposed_changes: changes,
      evidence_event_ids: ev,
      related_signal_ids: signalIds,
      generated_by: "rules",
      created_at: nowIso,
      reviewed_by: null,
      reviewed_at: null,
    });
  };

  // 1. Work is running ahead of an unfinished dependency: prioritize the blocker.
  for (const s of state.signals.filter((x) => x.type === "dependency_incomplete")) {
    const [taskId, ...blockers] = s.related_task_ids;
    const task = byId.get(taskId);
    const changes: PlanChange[] = [];
    for (const b of blockers) {
      const bt = byId.get(b);
      if (!bt) continue;
      const upd: PlanChange & { op: "update_task" } = { op: "update_task", task_id: b, changes: {} };
      if (bt.priority !== "critical") upd.changes.priority = "critical";
      if (task?.target_at && (!bt.target_at || bt.target_at > task.target_at)) {
        upd.changes.target_at = new Date(new Date(task.target_at).getTime() - 60 * 60 * 1000).toISOString();
      }
      if (Object.keys(upd.changes).length) changes.push(upd);
    }
    const keys = blockers.map((b) => byId.get(b)?.task_key).filter(Boolean).join(", ");
    make(`dep_${taskId}`, `${task?.task_key} is already moving but depends on ${keys}. Prioritize ${keys} so it lands first.`,
      changes, [s.signal_id], s.evidence_event_ids);
  }

  // 2. A milestone is slipping: drop optional work from it, then push the date.
  for (const s of state.signals.filter((x) => x.type === "milestone_slipping")) {
    const mid = s.related_milestone_ids[0];
    const m = w.milestones.find((x) => x.milestone_id === mid);
    if (!m) continue;
    const open = s.related_task_ids.map((id) => byId.get(id)).filter((t): t is Task => !!t);
    const optional = open.filter((t) => t.scope === "optional");
    const changes: PlanChange[] = optional.map((t) => ({ op: "update_task", task_id: t.task_id, changes: { milestone_id: null } }));
    let rationale = `Milestone "${m.name}" is at risk with ${open.length} open task${open.length === 1 ? "" : "s"}.`;
    if (optional.length) {
      rationale += ` Move optional work (${optional.map((t) => t.task_key).join(", ")}) out of it to protect the must-haves.`;
    } else if (m.target_at) {
      changes.push({
        op: "update_milestone",
        milestone_id: m.milestone_id,
        changes: { target_at: new Date(new Date(m.target_at).getTime() + 2 * 60 * 60 * 1000).toISOString() },
      });
      rationale += " Everything left is must-have, so move the target back 2 hours instead of cutting scope.";
    }
    make(`ms_${mid}`, rationale, changes, [s.signal_id], []);
  }

  // 3. A must-have with no activity near the deadline and no owner.
  for (const s of state.signals.filter((x) => x.type === "must_have_no_activity")) {
    const t = byId.get(s.related_task_ids[0]);
    if (!t || t.owner_member_id || !w.members.length) continue;
    const load = new Map(w.members.map((mm) => [mm.member_id, 0]));
    for (const x of w.tasks) if (!x.archived && x.owner_member_id && x.plan_status !== "complete") load.set(x.owner_member_id, (load.get(x.owner_member_id) ?? 0) + 1);
    const least = [...load.entries()].sort((a, b) => a[1] - b[1])[0][0];
    const who = w.members.find((mm) => mm.member_id === least)!;
    make(`own_${t.task_id}`, `${t.task_key} is required, close to its deadline, and nobody owns it. ${who.display_name} currently has the fewest open tasks.`,
      [{ op: "update_task", task_id: t.task_id, changes: { owner_member_id: least, priority: "high" } }], [s.signal_id], []);
  }

  const reviewed = new Set(read<Record<string, string[]>>(REVIEWED_KEY, {})[w.project.project_id] ?? []);
  return out.filter((r) => !reviewed.has(r.suggestion_id));
}

function markReviewed(pid: string, id: string) {
  const all = read<Record<string, string[]>>(REVIEWED_KEY, {});
  all[pid] = [...new Set([...(all[pid] ?? []), id])];
  write(REVIEWED_KEY, all);
}

export async function listReplans(projectId: string): Promise<ReplanSuggestion[]> {
  return suggest(mockWorkspace(projectId));
}

export async function acceptReplan(projectId: string, suggestionId: string) {
  const s = suggest(mockWorkspace(projectId)).find((x) => x.suggestion_id === suggestionId);
  if (!s) throw new Error("That suggestion is no longer current.");
  const w = await applyPlanChanges(projectId, s.proposed_changes);
  markReviewed(projectId, suggestionId);
  return { plan_version: w.project.current_plan_version ?? 1 };
}

export async function rejectReplan(projectId: string, suggestionId: string) {
  markReviewed(projectId, suggestionId);
}
