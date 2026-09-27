"use client";

import { useState } from "react";
import type { ProjectWorkspace } from "@/lib/types";
import ActivityTimeline from "./ActivityTimeline";
import BranchesPanel from "./BranchesPanel";
import ProjectTimeline from "./ProjectTimeline";

type View = "timeline" | "branches" | "events";

const VIEWS: { value: View; label: string }[] = [
  { value: "timeline", label: "Timeline" },
  { value: "branches", label: "Branches" },
  { value: "events", label: "Commits & PRs" },
];

export default function ActivityTab({ workspace }: { workspace: ProjectWorkspace }) {
  const [view, setView] = useState<View>("timeline");
  return (
    <div className="space-y-4">
      <div className="flex w-fit overflow-hidden rounded-md border border-line-strong">
        {VIEWS.map((v) => (
          <button key={v.value} onClick={() => setView(v.value)}
            className={`border-r border-line-strong px-3 py-1.5 text-sm last:border-r-0 ${
              view === v.value ? "bg-raised font-semibold text-header" : "text-muted hover:bg-raised"
            }`}>
            {v.label}
          </button>
        ))}
      </div>
      {view === "timeline" ? (
        <ProjectTimeline workspace={workspace} />
      ) : view === "branches" ? (
        <BranchesPanel workspace={workspace} />
      ) : (
        <ActivityTimeline workspace={workspace} />
      )}
    </div>
  );
}
