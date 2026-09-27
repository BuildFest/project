"use client";

import { useState } from "react";
import { useActingMember } from "@/lib/actingAs";
import { savePlanVersion } from "@/lib/api";
import type { ProjectWorkspace } from "@/lib/types";
import { buttonCls, ghostButtonCls, inputCls } from "@/lib/ui";

// "Save plan" (contract §3.7). Pit Crew suggests plan changes relative to a
// saved version, so until the first save there are no replan suggestions.
export default function PlanVersionBar({
  workspace,
  onChange,
}: {
  workspace: ProjectWorkspace;
  onChange: (w: ProjectWorkspace) => void;
}) {
  const pid = workspace.project.project_id;
  const version = workspace.project.current_plan_version;
  const { member } = useActingMember(workspace);
  const [summary, setSummary] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      onChange(await savePlanVersion(pid, { summary, member_id: member?.member_id ?? null }));
      setSummary("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the plan.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="flex flex-wrap items-center gap-3 rounded-md border border-line-strong bg-surface px-4 py-3">
      <div className="min-w-56 flex-1 text-sm">
        {version === null ? (
          <>
            <span className="font-semibold text-header">Plan not saved yet.</span>{" "}
            <span className="text-muted">Save it once it looks right, so Pit Crew can suggest changes against it.</span>
          </>
        ) : (
          <>
            <span className="font-semibold text-header">Plan v{version}</span>{" "}
            <span className="text-muted">is the saved baseline. Save again after changes worth keeping.</span>
          </>
        )}
        {error && <p className="mt-1 text-xs text-red">{error}</p>}
      </div>
      <input
        className={`${inputCls} w-64`}
        placeholder="What changed? (optional)"
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && !saving && save()}
      />
      <button className={version === null ? buttonCls : ghostButtonCls} disabled={saving} onClick={save}>
        {saving ? "Saving…" : version === null ? "Save plan" : `Save as v${version + 1}`}
      </button>
    </section>
  );
}
