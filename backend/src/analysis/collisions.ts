export type CollisionBranchStatus = "active" | "merged" | "deleted";

export interface CollisionBranch {
  repository_id: string;
  branch: string;
  status: CollisionBranchStatus;
  changed_files: string[];
  task_id: string | null;
}

export interface DetectedCollision {
  repository_id: string;
  branch_a: string;
  branch_b: string;
  task_a_id: string | null;
  task_b_id: string | null;
  overlapping_files: string[];
}

export const DEFAULT_COLLISION_IGNORE = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "*.lock"];

export function collisionIgnorePatterns(value = process.env.COLLISION_IGNORE): string[] {
  if (value === undefined) return [...DEFAULT_COLLISION_IGNORE];
  return value.split(",").map((pattern) => pattern.trim()).filter(Boolean);
}

function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}

function matchesIgnore(path: string, patterns: string[]): boolean {
  const name = basename(path);
  return patterns.some((pattern) => {
    if (pattern.startsWith("*.") && !pattern.slice(2).includes("*")) {
      return name.endsWith(pattern.slice(1));
    }
    return path === pattern || name === pattern;
  });
}

/**
 * Finds exact-file overlap among active branches in the same repository.
 * Pair order here is deterministic JS code-unit order. Persistence must use
 * SQL LEAST/GREATEST so the database's branch_a < branch_b collation check is
 * authoritative.
 */
export function detectCollisions(
  branches: CollisionBranch[],
  ignore = collisionIgnorePatterns(),
): DetectedCollision[] {
  const active = branches.filter((branch) => branch.status === "active");
  const detected: DetectedCollision[] = [];

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const left = active[i];
      const right = active[j];
      if (left.repository_id !== right.repository_id || left.branch === right.branch) continue;

      const rightFiles = new Set(right.changed_files);
      const overlapping = [...new Set(left.changed_files)]
        .filter((file) => rightFiles.has(file) && !matchesIgnore(file, ignore))
        .sort();
      if (overlapping.length === 0) continue;

      const [a, b] = left.branch < right.branch ? [left, right] : [right, left];
      detected.push({
        repository_id: a.repository_id,
        branch_a: a.branch,
        branch_b: b.branch,
        task_a_id: a.task_id,
        task_b_id: b.task_id,
        overlapping_files: overlapping,
      });
    }
  }

  return detected.sort(
    (a, b) =>
      a.repository_id.localeCompare(b.repository_id) ||
      a.branch_a.localeCompare(b.branch_a) ||
      a.branch_b.localeCompare(b.branch_b),
  );
}

export function describeCollision(collision: DetectedCollision): string {
  const files = collision.overlapping_files.join(", ");
  return `Collision risk: ${collision.branch_a} and ${collision.branch_b} both touch ${files}.`;
}
