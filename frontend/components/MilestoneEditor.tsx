"use client";

import { useState } from "react";
import { addMilestone, archiveMilestone } from "@/lib/api";
import { ProjectWorkspace } from "@/lib/types";
import {
  boxCls,
  boxHeaderCls,
  boxTitleCls,
  formatDate,
  fromLocalInput,
  ghostButtonCls,
  inputCls,
} from "@/lib/ui";

export default function MilestoneEditor({
  workspace,
  onChange,
}: {
  workspace: ProjectWorkspace;
  onChange: (w: ProjectWorkspace) => void;
}) {
  const { project } = workspace;
  const milestones = workspace.milestones
    .filter((m) => !m.archived)
    .sort((a, b) => (a.target_at ?? "").localeCompare(b.target_at ?? ""));
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    onChange(
      await addMilestone(project.project_id, {
        name: name.trim(),
        target_at: fromLocalInput(target),
      })
    );
    setName("");
    setTarget("");
  }

  return (
    <section className={boxCls}>
      <div className={boxHeaderCls}>
        <h2 className={boxTitleCls}>Milestones</h2>
        <span className="text-xs text-muted">{milestones.length}</span>
      </div>

      {milestones.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted">
          No milestones yet, e.g. &quot;Core demo&quot; or &quot;Feature freeze&quot;.
        </p>
      ) : (
        <ul>
          {milestones.map((m) => (
            <li key={m.milestone_id}
              className="group flex items-center justify-between border-b border-line px-4 py-2.5 text-sm">
              <span className="font-medium text-header">{m.name}</span>
              <span className="flex items-center gap-3">
                <span className="font-mono text-xs text-muted">{formatDate(m.target_at)}</span>
                <button
                  className="text-xs text-faint opacity-0 hover:text-red group-hover:opacity-100"
                  title="Remove milestone"
                  onClick={async () => onChange(await archiveMilestone(project.project_id, m.milestone_id))}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleAdd} className="flex flex-wrap gap-2 p-4">
        <input className={`${inputCls} min-w-40 flex-1`} placeholder="Milestone name" value={name}
          onChange={(e) => setName(e.target.value)} />
        <input className={inputCls} type="datetime-local" value={target}
          onChange={(e) => setTarget(e.target.value)} />
        <button className={ghostButtonCls} disabled={!name.trim()}>Add</button>
      </form>
    </section>
  );
}
