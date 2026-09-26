import type { Queryable } from "../db.js";
import { githubHeaders } from "../github.js";

// Fills branch_states.changed_files from GitHub's three-dot compare
// (default...head): the files that differ between the branch head and its
// merge base with the default branch, i.e. what merging it would change.
// Summing push payloads overcounts (merging main in, reverts), so collision
// detection reads this instead (spec §3.8, AD-5).
//
// Runs after the ingest transaction commits: never a network call inside it.

export interface BranchRef {
  repositoryId: string;
  branch: string;
}

export type RefreshResult = "updated" | "skipped" | "stale";

type Fetch = typeof fetch;

export async function refreshChangedFiles(db: Queryable, ref: BranchRef, fetchImpl: Fetch = fetch): Promise<RefreshResult> {
  const { rows } = await db.query<{ full_name: string; default_branch: string; head_sha: string | null; status: string }>(
    `select r.full_name, r.default_branch, b.head_sha, b.status
       from branch_states b join repositories r on r.repository_id = b.repository_id
      where b.repository_id = $1 and b.branch = $2`,
    [ref.repositoryId, ref.branch],
  );
  const row = rows[0];
  // The default branch is the comparison base; merged/deleted branches can't collide.
  if (!row || !row.head_sha || row.status !== "active" || ref.branch === row.default_branch) return "skipped";

  const url = `https://api.github.com/repos/${row.full_name}/compare/${row.default_branch}...${row.head_sha}`;
  const res = await fetchImpl(url, { headers: githubHeaders() });
  if (res.status === 404) return "skipped"; // branch or commit gone since the push
  if (!res.ok) throw new Error(`GitHub compare returned ${res.status} for ${row.full_name} ${ref.branch}`);

  const body = (await res.json()) as CompareResponse;
  return (await storeChangedFiles(db, ref, row.head_sha, changedFilesOf(body))) ? "updated" : "stale";
}

export interface CompareResponse {
  files?: Array<{ filename: string; previous_filename?: string }>;
}

/** GitHub lists at most 300 files per compare; a larger diff is silently truncated. */
export function changedFilesOf(body: CompareResponse): string[] {
  const files = new Set<string>();
  for (const f of body.files ?? []) {
    files.add(f.filename);
    if (f.previous_filename) files.add(f.previous_filename); // a rename touches both paths
  }
  return [...files].sort();
}

/** Writes only if the head is still the one compared; a newer push has its own refresh queued. */
export async function storeChangedFiles(db: Queryable, ref: BranchRef, headSha: string, files: string[]): Promise<boolean> {
  const { rowCount } = await db.query(
    `update branch_states set changed_files = $3
      where repository_id = $1 and branch = $2 and head_sha = $4`,
    [ref.repositoryId, ref.branch, files, headSha],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Debounced per branch: a burst of pushes costs one compare call, and the
 * call reads the head at run time rather than at schedule time.
 */
export function createCompareScheduler(db: Queryable, delayMs = 3000, fetchImpl: Fetch = fetch) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return (refs: BranchRef[]) => {
    for (const ref of refs) {
      const key = `${ref.repositoryId}\u0000${ref.branch}`;
      clearTimeout(timers.get(key));
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          refreshChangedFiles(db, ref, fetchImpl).catch((error) =>
            console.error("changed-files refresh failed", { ...ref, error }),
          );
        }, delayMs),
      );
    }
  };
}
