// Stand-in for Person 2's analyzers, used only in mock mode.
// It follows the same rules the MVP doc describes (task-key matching, derived
// status, dependency / milestone / disagreement signals, file-set collisions)
// so the dashboard can be built and demoed before /state exists. The real
// backend replaces all of this via GET /projects/:id/state.

import { mockEventsFor, mockWorkspace } from "./mockApi";
import { planAsDerived } from "./ui";
import type {
  Collision,
  DerivedStatus,
  DerivedTaskState,
  EventTaskLink,
  GithubEvent,
  HealthSignal,
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
      pending_links: [],
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

export async function dismiss(projectId: string, id: string): Promise<void> {
  const all = read<Record<string, string[]>>(DISMISSED_KEY, {});
  all[projectId] = [...new Set([...(all[projectId] ?? []), id])];
  write(DISMISSED_KEY, all);
}
