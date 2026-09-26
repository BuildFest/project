import { describe, expect, it } from "vitest";
import { extractEventTaskKeys, extractTaskKeys } from "../../src/analysis/taskKeys.js";
import type { GithubEvent } from "../../src/analysis/types.js";

describe("extractTaskKeys", () => {
  it("finds keys in branch names and titles", () => {
    expect(extractTaskKeys("pc-12-auth-api", "PC")).toEqual(["PC-12"]);
    expect(extractTaskKeys("feat/pc-7-collisions", "PC")).toEqual(["PC-7"]);
    expect(extractTaskKeys("PC-12 Add auth routes", "PC")).toEqual(["PC-12"]);
  });

  it("normalizes leading zeros and dedupes", () => {
    expect(extractTaskKeys("PC-012 and pc-12, then PC-3", "PC")).toEqual(["PC-12", "PC-3"]);
  });

  it("ignores keys embedded in other words or with other prefixes", () => {
    expect(extractTaskKeys("xpc-12 epc-4", "PC")).toEqual([]);
    expect(extractTaskKeys("ABC-12", "PC")).toEqual([]);
    expect(extractTaskKeys("pc-12345x", "PC")).toEqual([]);
  });

  it("handles empty input", () => {
    expect(extractTaskKeys(null, "PC")).toEqual([]);
    expect(extractTaskKeys("", "PC")).toEqual([]);
  });
});

describe("extractEventTaskKeys", () => {
  it("prefers the PR title over branch and commit", () => {
    const event: GithubEvent = {
      event_id: "evt_1",
      event_type: "pull_request_opened",
      actor: "user123",
      occurred_at: new Date(),
      branch: "pc-3-dashboard",
      commit: { sha: "abc", message: "PC-9 wip" },
      pull_request: { number: 31, title: "PC-12 Add auth routes", head_branch: "pc-3-dashboard" },
      changed_files: [],
    };
    expect(extractEventTaskKeys(event, "PC")).toEqual(["PC-12", "PC-3", "PC-9"]);
  });
});
