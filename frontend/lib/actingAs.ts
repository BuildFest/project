"use client";

// No auth yet (contract §1): endpoints that record *who* did something take a
// member_id. The user picks which team member they are; we remember it per
// project in this browser.

import { useCallback, useSyncExternalStore } from "react";
import type { ProjectWorkspace } from "./types";

const key = (pid: string) => `pitcrew.actingAs.${pid}`;
const listeners = new Set<() => void>();

function readStored(pid: string): string | null {
  try {
    return localStorage.getItem(key(pid));
  } catch {
    return null;
  }
}

export function useActingMember(workspace: ProjectWorkspace) {
  const pid = workspace.project.project_id;
  const stored = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => readStored(pid),
    () => null
  );
  const valid = workspace.members.find((m) => m.member_id === stored);
  const member = valid ?? workspace.members[0] ?? null;

  const setMemberId = useCallback(
    (id: string) => {
      try {
        localStorage.setItem(key(pid), id);
      } catch {
        /* ignore */
      }
      listeners.forEach((l) => l());
    },
    [pid]
  );

  return { member, setMemberId };
}
