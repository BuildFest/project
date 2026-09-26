import { describe, expect, it } from "vitest";
import { linkEventsByTaskKey } from "../../src/analysis/links.js";
import { event, task } from "./fixtures.js";

const auth = task({ task_id: "task_auth", task_key: "PC-12" });
const dash = task({ task_id: "task_dash", task_key: "PC-17" });

describe("linkEventsByTaskKey", () => {
  it("links events to tasks named in branches and PR titles", () => {
    const events = [
      event({ event_id: "e1", event_type: "commit", branch: "pc-12-auth-api" }),
      event({
        event_id: "e2",
        event_type: "pull_request_opened",
        pull_request: { number: 31, title: "PC-17 dashboard", head_branch: "pc-17-dashboard" },
      }),
      event({ event_id: "e3", event_type: "commit", branch: "misc-cleanup" }),
    ];
    const links = linkEventsByTaskKey(events, [auth, dash], "PC");
    expect(links.map((l) => [l.event_id, l.task_id, l.is_primary])).toEqual([
      ["e1", "task_auth", true],
      ["e2", "task_dash", true],
    ]);
    expect(links.every((l) => l.method === "task_key" && l.status === "confirmed")).toBe(true);
  });

  it("marks only the first key of an event as primary", () => {
    const events = [event({ event_id: "e1", event_type: "commit", branch: "pc-12-and-pc-17" })];
    const links = linkEventsByTaskKey(events, [auth, dash], "PC");
    expect(links.map((l) => [l.task_id, l.is_primary])).toEqual([
      ["task_auth", true],
      ["task_dash", false],
    ]);
  });

  it("ignores unknown keys and archived tasks", () => {
    const archived = task({ task_id: "task_old", task_key: "PC-3", archived: true });
    const events = [event({ event_id: "e1", event_type: "commit", branch: "pc-3-old-pc-99" })];
    expect(linkEventsByTaskKey(events, [archived], "PC")).toEqual([]);
  });

  it("does not recreate links a teammate already rejected", () => {
    const events = [event({ event_id: "e1", event_type: "commit", branch: "pc-12-auth" })];
    const existing = [
      {
        event_id: "e1",
        task_id: "task_auth",
        method: "task_key" as const,
        confidence: 1,
        status: "rejected" as const,
        is_primary: true,
      },
    ];
    expect(linkEventsByTaskKey(events, [auth], "PC", existing)).toEqual([]);
  });

  it("does not add a second primary when one already exists", () => {
    const events = [event({ event_id: "e1", event_type: "commit", branch: "pc-12-auth" })];
    const existing = [
      {
        event_id: "e1",
        task_id: "task_dash",
        method: "manual" as const,
        confidence: 1,
        status: "confirmed" as const,
        is_primary: true,
      },
    ];
    const links = linkEventsByTaskKey(events, [auth, dash], "PC", existing);
    expect(links).toHaveLength(1);
    expect(links[0].is_primary).toBe(false);
  });
});
