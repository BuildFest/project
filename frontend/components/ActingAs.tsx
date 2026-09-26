"use client";

import { useActingMember } from "@/lib/actingAs";
import type { ProjectWorkspace } from "@/lib/types";

// Until auth exists, the user says which teammate they are. Used as
// member_id on corrections and dismissals (contract §1 "Auth").
export default function ActingAs({ workspace }: { workspace: ProjectWorkspace }) {
  const { member, setMemberId } = useActingMember(workspace);
  if (!workspace.members.length) return null;
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      <span>Acting as</span>
      <select
        className="rounded-md border border-line-strong bg-btn px-2 py-[3px] text-xs font-medium text-header hover:bg-btn-hover focus:outline-none"
        value={member?.member_id ?? ""}
        onChange={(e) => setMemberId(e.target.value)}
      >
        {workspace.members.map((m) => (
          <option key={m.member_id} value={m.member_id}>
            {m.github_login ? `@${m.github_login}` : m.display_name}
          </option>
        ))}
      </select>
    </label>
  );
}
