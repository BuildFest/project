"use client";

import { useState } from "react";
import { updateBrief } from "@/lib/api";
import { ProjectWorkspace } from "@/lib/types";
import { boxBodyCls, boxCls, boxHeaderCls, boxTitleCls, buttonCls, formatDate, ghostButtonCls, inputCls, smallButtonCls } from "@/lib/ui";

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
    <section className={boxCls}>
      <div className={boxHeaderCls}>
        <h2 className={boxTitleCls}>Brief</h2>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">Updated {formatDate(brief.updated_at)}</span>
          {!editing && (
            <button className={smallButtonCls} onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
        </div>
      </div>

      <div className={boxBodyCls}>
        {editing ? (
          <div className="space-y-2">
            <textarea
              className={`${inputCls} h-56 w-full font-mono`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button
                className={ghostButtonCls}
                onClick={() => {
                  setDraft(brief.content);
                  setEditing(false);
                }}
              >
                Cancel
              </button>
              <button className={buttonCls} onClick={save}>Save brief</button>
            </div>
          </div>
        ) : brief.content ? (
          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-text">{brief.content}</pre>
        ) : (
          <p className="text-sm text-muted">
            No brief yet. Describe the idea, requirements and definition of done.
          </p>
        )}
      </div>
    </section>
  );
}
