import { afterEach, describe, expect, it } from "vitest";
import { collisionIgnorePatterns, describeCollision, detectCollisions, type CollisionBranch } from "../../src/analysis/collisions.js";

const branch = (overrides: Partial<CollisionBranch> & Pick<CollisionBranch, "branch">): CollisionBranch => ({
  repository_id: "repo_1", status: "active", changed_files: [], task_id: null, ...overrides,
});

afterEach(() => delete process.env.COLLISION_IGNORE);

describe("detectCollisions", () => {
  it("returns canonical branch pairs, task ids and exact overlapping files", () => {
    expect(detectCollisions([
      branch({ branch: "z-work", task_id: "task_z", changed_files: ["b.ts", "a.ts", "only-z.ts"] }),
      branch({ branch: "a-work", task_id: "task_a", changed_files: ["a.ts", "b.ts", "only-a.ts"] }),
    ], [])).toEqual([{
      repository_id: "repo_1", branch_a: "a-work", branch_b: "z-work", task_a_id: "task_a", task_b_id: "task_z", overlapping_files: ["a.ts", "b.ts"],
    }]);
  });

  it("ignores lockfiles by default", () => {
    const files = ["package-lock.json", "nested/pnpm-lock.yaml", "yarn.lock", "Gemfile.lock"];
    expect(detectCollisions([branch({ branch: "a", changed_files: files }), branch({ branch: "b", changed_files: files })])).toEqual([]);
  });

  it("supports comma-separated exact path, basename and extension overrides", () => {
    process.env.COLLISION_IGNORE = "generated.json,docs/shared.md,*.snap";
    expect(collisionIgnorePatterns()).toEqual(["generated.json", "docs/shared.md", "*.snap"]);
    expect(detectCollisions([
      branch({ branch: "a", changed_files: ["src/generated.json", "docs/shared.md", "test/a.snap", "package-lock.json"] }),
      branch({ branch: "b", changed_files: ["src/generated.json", "docs/shared.md", "test/a.snap", "package-lock.json"] }),
    ])).toMatchObject([{ overlapping_files: ["package-lock.json"] }]);
  });

  it("excludes inactive branches and never pairs different repositories", () => {
    const shared = ["src/shared.ts"];
    expect(detectCollisions([
      branch({ branch: "active", changed_files: shared }),
      branch({ branch: "merged", status: "merged", changed_files: shared }),
      branch({ branch: "deleted", status: "deleted", changed_files: shared }),
      branch({ branch: "other-repo", repository_id: "repo_2", changed_files: shared }),
    ], [])).toEqual([]);
  });

  it("describes a risk without claiming an inevitable outcome", () => {
    const text = describeCollision({ repository_id: "repo_1", branch_a: "a", branch_b: "b", task_a_id: null, task_b_id: null, overlapping_files: ["src/shared.ts"] });
    expect(text).toBe("Collision risk: a and b both touch src/shared.ts.");
    expect(text.toLowerCase()).not.toContain("conflict");
    expect(text.toLowerCase()).not.toContain("guaranteed");
  });
});
