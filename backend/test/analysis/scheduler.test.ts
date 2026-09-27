import { describe, expect, it, vi } from "vitest";
import { createAnalysisScheduler, startAnalysisSweep } from "../../src/analysis/runner.js";

// Real timers with a tiny debounce: simpler and more robust here than fake
// timers, since pump() chains promise microtasks (.finally -> pump()) after
// the debounce fires, which fake timers don't advance through on their own.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => sleep(30); // past the 10ms debounce, plus a microtask beat

// run's fourth argument is the AnalysisRunOptions ({ skipLinking, skipAi });
// the third is the `now` Date.
const optionsOf = (call: unknown[]) => call[4];

describe("createAnalysisScheduler", () => {
  it("runs a single event-triggered call with AI enabled", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const schedule = createAnalysisScheduler({} as never, null, { debounceMs: 10, run });

    schedule("proj_1");
    await settle();

    expect(run).toHaveBeenCalledTimes(1);
    expect(optionsOf(run.mock.calls[0])).toMatchObject({ skipLinking: false, skipAi: false });
  });

  it("caps how often AI runs per project: a second trigger inside the cooldown is downgraded to rules-only", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    let clock = 0;
    const schedule = createAnalysisScheduler({} as never, null, {
      debounceMs: 10,
      aiMinIntervalMs: 5 * 60_000,
      run,
      now: () => clock,
    });

    schedule("proj_1");
    await settle();

    clock += 30_000; // 30s later — well inside the 5-minute cooldown
    schedule("proj_1"); // e.g. another push landing shortly after the first
    await settle();

    expect(run).toHaveBeenCalledTimes(2);
    expect(optionsOf(run.mock.calls[0])).toMatchObject({ skipLinking: false, skipAi: false });
    expect(optionsOf(run.mock.calls[1])).toMatchObject({ skipLinking: true, skipAi: true });
  });

  it("re-enables AI once the cooldown has fully elapsed", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    let clock = 0;
    const schedule = createAnalysisScheduler({} as never, null, {
      debounceMs: 10,
      aiMinIntervalMs: 5 * 60_000,
      run,
      now: () => clock,
    });

    schedule("proj_1");
    await settle();

    clock += 5 * 60_000 + 1; // just past the cooldown
    schedule("proj_1");
    await settle();

    expect(run).toHaveBeenCalledTimes(2);
    expect(optionsOf(run.mock.calls[1])).toMatchObject({ skipLinking: false, skipAi: false });
  });

  it("runs a deferred full review when an app change lands during cooldown", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const schedule = createAnalysisScheduler({} as never, null, {
      debounceMs: 5,
      aiMinIntervalMs: 60,
      run,
    });

    schedule("proj_1", { trigger: "github_event" });
    await sleep(20);
    schedule("proj_1", { trigger: "decision" });
    await sleep(25);

    expect(run).toHaveBeenCalledTimes(2);
    expect(optionsOf(run.mock.calls[1])).toMatchObject({ skipAi: true, trigger: "decision" });

    await sleep(60);
    expect(run).toHaveBeenCalledTimes(3);
    expect(optionsOf(run.mock.calls[2])).toMatchObject({ skipAi: false, trigger: "decision" });
  });

  it("still cools down a periodic (sweep) run just like an event-triggered one", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    let clock = 0;
    const schedule = createAnalysisScheduler({} as never, null, {
      debounceMs: 10,
      aiMinIntervalMs: 5 * 60_000,
      run,
      now: () => clock,
    });

    schedule("proj_1"); // full AI run, starts the cooldown
    await settle();

    clock += 1_000;
    schedule("proj_1", { periodic: true }); // sweep tick shortly after
    await settle();

    expect(run).toHaveBeenCalledTimes(2);
    expect(optionsOf(run.mock.calls[1])).toMatchObject({ skipLinking: true, skipAi: true });
  });

  it("tracks the cooldown per project, not globally", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const schedule = createAnalysisScheduler({} as never, null, { debounceMs: 10, aiMinIntervalMs: 5 * 60_000, run });

    schedule("proj_1");
    schedule("proj_2");
    await settle();

    expect(run).toHaveBeenCalledTimes(2);
    expect(optionsOf(run.mock.calls[0])).toMatchObject({ skipAi: false });
    expect(optionsOf(run.mock.calls[1])).toMatchObject({ skipAi: false });
  });

  it("aiMinIntervalMs: 0 disables the cap", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const schedule = createAnalysisScheduler({} as never, null, { debounceMs: 10, aiMinIntervalMs: 0, run });

    schedule("proj_1");
    await settle();
    schedule("proj_1");
    await settle();

    expect(run).toHaveBeenCalledTimes(2);
    expect(optionsOf(run.mock.calls[0])).toMatchObject({ skipAi: false });
    expect(optionsOf(run.mock.calls[1])).toMatchObject({ skipAi: false });
  });
});

describe("startAnalysisSweep", () => {
  it("schedules active projects immediately at startup", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ project_id: "proj_1" }] }) } as never;
    const schedule = vi.fn();
    const timer = startAnalysisSweep(db, schedule, 60_000);
    try {
      await sleep(5);
      expect(schedule).toHaveBeenCalledWith("proj_1", { periodic: false, trigger: "startup" });
    } finally {
      clearInterval(timer);
    }
  });
});
