"use client";

import { useCallback, useEffect, useState } from "react";
import { listRepositories, retryFailedDeliveries, startBackfill } from "@/lib/api";
import type { ProjectWorkspace, Repository } from "@/lib/types";
import { smallButtonCls, timeAgo } from "@/lib/ui";
import { IconBranches } from "../Icons";
import ConnectRepoDialog from "./ConnectRepoDialog";

const linkButtonCls = "text-link hover:underline disabled:opacity-50";

// Is GitHub activity reaching Pit Crew? The backend computes ingestion_health
// (contract §4.2); older data without it falls back to connection_status.
function HealthLine({ repo }: { repo: Repository }) {
  const health =
    repo.ingestion_health ??
    (repo.connection_status === "connected" ? "live" : repo.connection_status === "pending" ? "waiting" : null);
  return (
    <div>
      {health === "live" ? (
        <span className="text-green">● Live</span>
      ) : health === "waiting" ? (
        <span className="text-yellow">● Waiting for GitHub&apos;s first delivery</span>
      ) : health === "degraded" ? (
        <span className="text-yellow">● Degraded</span>
      ) : (
        <span className="text-red">● {repo.connection_status}</span>
      )}
      {repo.last_event_at && <span className="text-muted"> · last event {timeAgo(repo.last_event_at)}</span>}
    </div>
  );
}

// Sidebar section: which repo Pit Crew is watching, whether deliveries are
// arriving, and whether its history has been imported.
export default function RepositoryPanel({ workspace }: { workspace: ProjectWorkspace }) {
  const pid = workspace.project.project_id;
  const [repos, setRepos] = useState<Repository[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); // repository_id with an action in flight
  const [notice, setNotice] = useState<{ id: string; text: string; bad?: boolean } | null>(null);

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

  // Re-check while waiting for GitHub's ping or while history is importing.
  const inProgress = repos?.some(
    (r) => r.connection_status === "pending" || r.ingestion_health === "waiting" || r.backfill_status === "running"
  );
  useEffect(() => {
    if (!inProgress) return;
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [inProgress, refresh]);

  const onClose = useCallback(() => {
    setOpen(false);
    refresh();
  }, [refresh]);

  async function act(repo: Repository, action: () => Promise<string>) {
    setBusy(repo.repository_id);
    setNotice(null);
    try {
      setNotice({ id: repo.repository_id, text: await action() });
    } catch (e) {
      setNotice({ id: repo.repository_id, text: e instanceof Error ? e.message : "Something went wrong.", bad: true });
    } finally {
      setBusy(null);
      refresh();
    }
  }

  const importHistory = (repo: Repository) =>
    act(repo, async () => {
      await startBackfill(pid, repo.repository_id);
      return "Importing history from GitHub…";
    });

  const retry = (repo: Repository) =>
    act(repo, async () => {
      const r = await retryFailedDeliveries(pid, repo.repository_id);
      if (r.retried === 0) return "Nothing to retry.";
      return r.still_failed === 0
        ? `Retried ${r.retried}: all processed.`
        : `Retried ${r.retried}: ${r.succeeded} processed, ${r.still_failed} still failing.`;
    });

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
        <ul className="space-y-3">
          {repos.map((r) => {
            const isBusy = busy === r.repository_id;
            const failed = r.failed_deliveries ?? 0;
            return (
              <li key={r.repository_id}>
                <a href={`https://github.com/${r.full_name}`} target="_blank" rel="noreferrer"
                  className="flex items-center gap-2 font-semibold text-header hover:text-link">
                  <IconBranches className="text-muted" /> {r.full_name}
                </a>
                <div className="ml-6 space-y-0.5 text-xs">
                  <HealthLine repo={r} />

                  {failed > 0 && (
                    <div>
                      <span className="text-red">{failed} failed {failed === 1 ? "delivery" : "deliveries"}</span>
                      {" · "}
                      <button className={linkButtonCls} disabled={isBusy} onClick={() => retry(r)}>
                        {isBusy ? "Retrying…" : "Retry"}
                      </button>
                    </div>
                  )}

                  {r.backfill_status === "running" ? (
                    <div className="text-muted">Importing history…</div>
                  ) : r.backfill_status === "partial" || r.backfill_status === "failed" ? (
                    <div>
                      <span className={r.backfill_status === "failed" ? "text-red" : "text-yellow"}>
                        {r.backfill_status === "failed" ? "History import failed" : "History partly imported"}
                      </span>
                      {" · "}
                      <button className={linkButtonCls} disabled={isBusy} onClick={() => importHistory(r)}>Run again</button>
                      {r.backfill_error && (
                        <p className="line-clamp-2 text-muted" title={r.backfill_error}>{r.backfill_error}</p>
                      )}
                    </div>
                  ) : r.last_backfill_at ? (
                    <div className="text-muted">
                      History imported {timeAgo(r.last_backfill_at)}
                      {" · "}
                      <button className={linkButtonCls} disabled={isBusy} onClick={() => importHistory(r)}>Re-import</button>
                    </div>
                  ) : (
                    <div>
                      <span className="text-muted">Earlier history not imported · </span>
                      <button className={linkButtonCls} disabled={isBusy} onClick={() => importHistory(r)}>Import history</button>
                    </div>
                  )}

                  {notice?.id === r.repository_id && (
                    <p className={notice.bad ? "text-red" : "text-muted"}>{notice.text}</p>
                  )}
                </div>
              </li>
            );
          })}
          <li>
            <button className="text-xs text-link hover:underline" onClick={() => setOpen(true)}>Connect another</button>
          </li>
        </ul>
      )}
      {open && <ConnectRepoDialog projectId={pid} onClose={onClose} onConnected={refresh} />}
    </section>
  );
}
