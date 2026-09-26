"use client";

import { useState } from "react";
import { addMilestone, archiveMilestone } from "@/lib/api";
import { ProjectWorkspace } from "@/lib/types";
import { buttonCls, formatDate, fromLocalInput, inputCls } from "@/lib/ui";

export default function MilestoneEditor({
  workspace,
  onChange,
}: {
  workspace: ProjectWorkspace;
  onChange: (w: ProjectWorkspace) => void;
}) {
  const { project } = workspace;
  const milestones = workspace.milestones.filter((m) => !m.archived);
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
    <section className="rounded-sm border border-line bg-surface p-4">
      <h2 className="mb-3 font-display text-lg font-semibold uppercase tracking-wider">Milestones</h2>

      <div className="mb-3 flex flex-wrap gap-2">
        {milestones.length === 0 && (
          <p className="text-sm text-muted">No milestones yet (e.g. &quot;Core demo&quot;, &quot;Feature freeze&quot;).</p>
        )}
        {milestones.map((m) => (
          <span
            key={m.milestone_id}
            className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 text-sm"
          >
            <span className="font-medium">{m.name}</span>
            <span className="text-muted">{formatDate(m.target_at)}</span>
            <button
              className="text-muted hover:text-red"
              title="Remove milestone"
              onClick={async () => onChange(await archiveMilestone(project.project_id, m.milestone_id))}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      <form onSubmit={handleAdd} className="flex flex-wrap gap-2">
        <input className={`${inputCls} flex-1`} placeholder="Milestone name" value={name}
          onChange={(e) => setName(e.target.value)} />
        <input className={inputCls} type="datetime-local" value={target}
          onChange={(e) => setTarget(e.target.value)} />
        <button className={buttonCls} disabled={!name.trim()}>Add milestone</button>
      </form>
    </section>
  );
}
