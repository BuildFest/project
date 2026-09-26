"use client";

import { useCallback, useEffect, useState } from "react";
import { listRepositories } from "@/lib/api";
import type { ProjectWorkspace, Repository } from "@/lib/types";
import { smallButtonCls, timeAgo } from "@/lib/ui";
import { IconBranches } from "../Icons";
import ConnectRepoDialog from "./ConnectRepoDialog";

// Sidebar section: which repo Pit Crew is watching, and its webhook status.
export default function RepositoryPanel({ workspace }: { workspace: ProjectWorkspace }) {
  const pid = workspace.project.project_id;
  const [repos, setRepos] = useState<Repository[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(
    () =>
      listRepositories(pid).then(
        (r) => {
          setRepos(r);
          setError(false);
        },
        () => setError(true)
      ),
    [pid]
  );

  useEffect(() => {
    let cancelled = false;
    listRepositories(pid).then(
      (r) => !cancelled && setRepos(r),
      () => !cancelled && setError(true)
    );
    return () => {
      cancelled = true;
    };
  }, [pid]);

  // While any repo is still waiting for GitHub's ping, re-check periodically.
  const pending = repos?.some((r) => r.connection_status === "pending");
  useEffect(() => {
    if (!pending) return;
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [pending, refresh]);

  const onClose = useCallback(() => {
    setOpen(false);
    refresh();
  }, [refresh]);

  return (
    <section className="border-t border-line pt-5">
      <h3 className="mb-2 text-sm font-semibold text-header">Repository</h3>
      {error ? (
        <p className="text-xs text-muted">Couldn&apos;t load repositories.</p>
      ) : repos === null ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : repos.length === 0 ? (
        <div>
          <p className="mb-2 text-muted">Not connected. Connect GitHub so Pit Crew can see what&apos;s actually happening.</p>
          <button className={smallButtonCls} onClick={() => setOpen(true)}>Connect repository</button>
        </div>
      ) : (
        <ul className="space-y-2">
          {repos.map((r) => (
            <li key={r.repository_id}>
              <a href={`https://github.com/${r.full_name}`} target="_blank" rel="noreferrer"
                className="flex items-center gap-2 font-semibold text-header hover:text-link">
                <IconBranches className="text-muted" /> {r.full_name}
              </a>
              <div className="ml-6 text-xs">
                {r.connection_status === "connected" ? (
                  <span className="text-green">● Connected</span>
                ) : r.connection_status === "pending" ? (
                  <span className="text-yellow">● Waiting for webhook</span>
                ) : (
                  <span className="text-red">● {r.connection_status}</span>
                )}
                {r.last_event_at && <span className="text-muted"> · last event {timeAgo(r.last_event_at)}</span>}
              </div>
            </li>
          ))}
          <li>
            <button className="text-xs text-link hover:underline" onClick={() => setOpen(true)}>Connect another</button>
          </li>
        </ul>
      )}
      {open && <ConnectRepoDialog projectId={pid} onClose={onClose} onConnected={refresh} />}
    </section>
  );
}
