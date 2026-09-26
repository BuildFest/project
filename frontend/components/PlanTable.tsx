"use client";

import { useState } from "react";
import {
  addDependency,
  addTask,
  removeDependency,
  TaskPatch,
  updateTask,
  wouldCreateCycle,
} from "@/lib/api";
import { PlanStatus, Priority, ProjectWorkspace, Scope, Task } from "@/lib/types";
import {
  boxCls,
  boxHeaderCls,
  boxTitleCls,
  buttonCls,
  fromLocalInput,
  inputCls,
  statusStyles,
  suggestedBranch,
  toLocalInput,
} from "@/lib/ui";

const STATUSES: { value: PlanStatus; label: string }[] = [
  { value: "not_started", label: "Not started" },
  { value: "in_progress", label: "In progress" },
  { value: "blocked", label: "Blocked" },
  { value: "complete", label: "Complete" },
  { value: "cancelled", label: "Cancelled" },
];
const PRIORITIES: Priority[] = ["critical", "high", "medium", "low"];

const cellInput = `${inputCls} w-full`;

export default function PlanTable({
  workspace,
  onChange,
}: {
  workspace: ProjectWorkspace;
  onChange: (w: ProjectWorkspace) => void;
}) {
  const { project, members, milestones, tasks, dependencies } = workspace;
  const pid = project.project_id;
  const [newTitle, setNewTitle] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visible = tasks
    .filter((t) => showArchived || !t.archived)
    .sort((a, b) => a.sort_order - b.sort_order);
  const byId = new Map(tasks.map((t) => [t.task_id, t]));
  const activeMilestones = milestones.filter((m) => !m.archived);

  async function run(action: () => Promise<ProjectWorkspace>) {
    try {
      setError(null);
      onChange(await action());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    }
  }

  const patch = (taskId: string, p: TaskPatch) => run(() => updateTask(pid, taskId, p));

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim()) return;
    await run(() => addTask(pid, newTitle.trim()));
    setNewTitle("");
  }

  return (
    <section className={boxCls}>
      <div className={boxHeaderCls}>
        <h2 className={boxTitleCls}>
          Plan <span className="ml-1 rounded-full bg-line px-2 py-0.5 text-xs font-medium text-muted">{visible.length}</span>
        </h2>
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>

      {error && (
        <p className="border-b border-red/40 bg-red/10 px-4 py-2 text-sm text-red">
          {error}
        </p>
      )}

      <div className="overflow-x-auto px-4">
        <table className="w-full min-w-[1100px] text-left text-sm">
          <thead className="text-xs font-semibold text-muted">
            <tr className="border-b border-line">
              <th className="py-2 pr-2">Key</th>
              <th className="py-2 pr-2">Task</th>
              <th className="py-2 pr-2">Owner</th>
              <th className="py-2 pr-2">Status</th>
              <th className="py-2 pr-2">Priority</th>
              <th className="py-2 pr-2">Scope</th>
              <th className="py-2 pr-2">Milestone</th>
              <th className="py-2 pr-2">Target</th>
              <th className="py-2 pr-2">Depends on</th>
              <th className="py-2"></th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={10} className="py-6 text-center text-muted">
                  No tasks yet. Type a task title in the box below and click Add task. Each task becomes an editable row here.
                </td>
              </tr>
            )}
            {visible.map((t) => (
              <tr key={t.task_id}
                className={`border-b border-line/60 align-top ${t.archived ? "opacity-50" : ""}`}>
                <td className="py-2 pr-2 font-mono text-xs whitespace-nowrap">
                  {t.task_key}
                  <BranchHint task={t} />
                </td>
                <td className="py-2 pr-2">
                  <input
                    key={t.title}
                    className={cellInput}
                    autoComplete="off"
                    data-1p-ignore
                    name={`task-title-${t.task_id}`}
                    defaultValue={t.title}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v && v !== t.title) patch(t.task_id, { title: v });
                    }}
                    onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  />
                </td>
                <td className="py-2 pr-2">
                  <select className={cellInput} value={t.owner_member_id ?? ""}
                    onChange={(e) => patch(t.task_id, { owner_member_id: e.target.value || null })}>
                    <option value="">Unassigned</option>
                    {members.map((m) => (
                      <option key={m.member_id} value={m.member_id}>{m.display_name}</option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-2">
                  <select className={`${cellInput} ${statusStyles[t.plan_status]}`} value={t.plan_status}
                    onChange={(e) => patch(t.task_id, { plan_status: e.target.value as PlanStatus })}>
                    {STATUSES.map((s) => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-2">
                  <select className={cellInput} value={t.priority}
                    onChange={(e) => patch(t.task_id, { priority: e.target.value as Priority })}>
                    {PRIORITIES.map((p) => (
                      <option key={p} value={p}>{p}</option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-2">
                  <select className={cellInput} value={t.scope}
                    onChange={(e) => patch(t.task_id, { scope: e.target.value as Scope })}>
                    <option value="must_have">Must-have</option>
                    <option value="optional">Optional</option>
                  </select>
                </td>
                <td className="py-2 pr-2">
                  <select className={cellInput} value={t.milestone_id ?? ""}
                    onChange={(e) => patch(t.task_id, { milestone_id: e.target.value || null })}>
                    <option value="">None</option>
                    {activeMilestones.map((m) => (
                      <option key={m.milestone_id} value={m.milestone_id}>{m.name}</option>
                    ))}
                  </select>
                </td>
                <td className="py-2 pr-2">
                  <input type="datetime-local" className={cellInput} value={toLocalInput(t.target_at)}
                    onChange={(e) => patch(t.task_id, { target_at: fromLocalInput(e.target.value) })} />
                </td>
                <td className="py-2 pr-2">
                  <div className="flex flex-wrap items-center gap-1">
                    {dependencies
                      .filter((d) => d.task_id === t.task_id)
                      .map((d) => {
                        const dep = byId.get(d.depends_on_task_id);
                        if (!dep) return null;
                        const done = dep.plan_status === "complete";
                        return (
                          <span key={d.depends_on_task_id}
                            title={done ? `${dep.title} (complete)` : `${dep.title} (not complete yet)`}
                            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-xs ${
                              done
                                ? "bg-green/15 text-green"
                                : "bg-yellow/15 text-yellow"
                            }`}>
                            {dep.task_key}
                            <button className="hover:text-red"
                              onClick={() => run(() => removeDependency(pid, t.task_id, dep.task_id))}>
                              ×
                            </button>
                          </span>
                        );
                      })}
                    <select
                      className={`${inputCls} w-20 text-xs`}
                      value=""
                      onChange={(e) => e.target.value && run(() => addDependency(pid, t.task_id, e.target.value))}
                    >
                      <option value="">+ add</option>
                      {tasks
                        .filter(
                          (o) =>
                            !o.archived &&
                            !dependencies.some((d) => d.task_id === t.task_id && d.depends_on_task_id === o.task_id) &&
                            !wouldCreateCycle(dependencies, t.task_id, o.task_id)
                        )
                        .map((o) => (
                          <option key={o.task_id} value={o.task_id}>
                            {o.task_key} {o.title}
                          </option>
                        ))}
                    </select>
                  </div>
                </td>
                <td className="py-2 text-right">
                  <button className="text-xs text-muted hover:text-red"
                    onClick={() => patch(t.task_id, { archived: !t.archived })}>
                    {t.archived ? "Restore" : "Archive"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form onSubmit={handleAdd} className="flex gap-2 border-t border-line bg-raised/50 p-4">
        <input className={`${inputCls} flex-1`} placeholder="New task title, e.g. Auth API routes"
          value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
        <button className={buttonCls} disabled={!newTitle.trim()}>Add task</button>
      </form>
    </section>
  );
}

// Suggested branch name so GitHub activity links to this task automatically.
function BranchHint({ task }: { task: Task }) {
  const [copied, setCopied] = useState(false);
  const branch = suggestedBranch(task.task_key, task.title);
  return (
    <button
      className="mt-1 block max-w-[9rem] truncate text-[10px] text-muted hover:text-text"
      title={`Copy branch name: ${branch}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(branch);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard blocked */
        }
      }}
    >
      {copied ? "copied!" : `⎘ ${branch}`}
    </button>
  );
}
