"use client";

import { useState } from "react";
import { updateBrief } from "@/lib/api";
import { ProjectWorkspace } from "@/lib/types";
import { buttonCls, ghostButtonCls, formatDate } from "@/lib/ui";

// Markdown brief for now. Swap the textarea for a rich-text editor (Tiptap)
// later without changing the API: brief.content stays the source of truth.
export default function BriefEditor({
  workspace,
  onChange,
}: {
  workspace: ProjectWorkspace;
  onChange: (w: ProjectWorkspace) => void;
}) {
  const { project, brief } = workspace;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(brief.content);

  async function save() {
    onChange(await updateBrief(project.project_id, draft));
    setEditing(false);
  }

  return (
    <section className="rounded-sm border border-line bg-surface p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold uppercase tracking-wider">Brief</h2>
        <span className="text-xs text-muted">updated {formatDate(brief.updated_at)}</span>
      </div>

      {editing ? (
        <div className="space-y-2">
          <textarea
            className="h-56 w-full rounded-sm border border-line bg-surface p-2 font-mono text-sm"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <div className="flex gap-2">
            <button className={buttonCls} onClick={save}>Save</button>
            <button
              className={ghostButtonCls}
              onClick={() => {
                setDraft(brief.content);
                setEditing(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div>
          {brief.content ? (
            <pre className="whitespace-pre-wrap font-sans text-sm text-text">
              {brief.content}
            </pre>
          ) : (
            <p className="text-sm text-muted">No brief yet. Describe the idea, requirements and definition of done.</p>
          )}
          <button className={`${ghostButtonCls} mt-3`} onClick={() => setEditing(true)}>
            Edit brief
          </button>
        </div>
      )}
    </section>
  );
}
