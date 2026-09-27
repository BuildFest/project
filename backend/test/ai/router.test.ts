import { describe, expect, it, vi } from "vitest";
import type { CompletionResult, ModelClient } from "../../src/ai/client.js";
import { loadAiConfig, type TierConfig } from "../../src/ai/config.js";
import { AiUnavailableError, createModelRouter, type AiRunRecord } from "../../src/ai/router.js";

function fakeClient(tier: TierConfig, tokens = 10): ModelClient & { calls: number } {
  const client = {
    provider: tier.provider,
    model: tier.model,
    calls: 0,
    async complete(): Promise<CompletionResult> {
      client.calls++;
      return {
        text: `${tier.provider} reply`,
        provider: tier.provider,
        model: tier.model,
        inputTokens: tokens,
        outputTokens: tokens,
      };
    },
  };
  return client;
}

const request = { messages: [{ role: "user" as const, content: "hi" }], maxTokens: 50 };

describe("createModelRouter", () => {
  it("sends each job to its configured tier", async () => {
    const config = loadAiConfig({ GROQ_API_KEY: "g", ANTHROPIC_API_KEY: "a" });
    const router = createModelRouter(config, { clientFor: (t) => fakeClient(t) });
    expect((await router.run("diff_summary", request)).provider).toBe("groq");
    expect((await router.run("pre_merge_review", request)).provider).toBe("anthropic");
    expect((await router.run("link_suggestion", request)).provider).toBe("anthropic");
  });

  it("falls back to fast when a smart-tier key is missing", async () => {
    const router = createModelRouter(loadAiConfig({ GROQ_API_KEY: "g" }), {
      clientFor: (t) => fakeClient(t),
    });
    expect(router.available("link_suggestion")).toBe(true);
    expect(router.available("replan")).toBe(true);
    await expect(router.run("replan", request)).resolves.toMatchObject({ provider: "groq" });
  });

  it("reports a smart job unavailable when neither tier has a key", async () => {
    const router = createModelRouter(loadAiConfig({}), { clientFor: (t) => fakeClient(t) });
    expect(router.available("replan")).toBe(false);
    await expect(router.run("replan", request)).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it("falls back to fast when the smart provider fails", async () => {
    const runs: AiRunRecord[] = [];
    const router = createModelRouter(loadAiConfig({ GROQ_API_KEY: "g", ANTHROPIC_API_KEY: "a" }), {
      onRun: (run) => runs.push(run),
      clientFor: (tier) =>
        tier.provider === "anthropic"
          ? { provider: tier.provider, model: tier.model, complete: vi.fn().mockRejectedValue(new Error("smart down")) }
          : fakeClient(tier),
    });
    await expect(router.run("replan", request)).resolves.toMatchObject({ provider: "groq" });
    expect(runs).toMatchObject([
      { tier: "smart", provider: "anthropic", error: "smart down" },
      { tier: "fast", provider: "groq", error: null },
    ]);
  });

  it("reuses cached results for the same key", async () => {
    let client!: ReturnType<typeof fakeClient>;
    const router = createModelRouter(loadAiConfig({ GROQ_API_KEY: "g" }), {
      clientFor: (t) => (client = fakeClient(t)),
    });
    await router.run("link_suggestion", request, { cacheKey: "evt_1" });
    await router.run("link_suggestion", request, { cacheKey: "evt_1" });
    await router.run("link_suggestion", request, { cacheKey: "evt_2" });
    expect(client.calls).toBe(2);
  });

  it("stops calling models once the daily budget is spent and resets the next day", async () => {
    let day = new Date("2026-09-26T10:00:00Z");
    const router = createModelRouter(
      loadAiConfig({ GROQ_API_KEY: "g", AI_DAILY_TOKEN_BUDGET: "30" }),
      { clientFor: (t) => fakeClient(t, 10), now: () => day },
    );
    await router.run("diff_summary", request);
    await router.run("diff_summary", request);
    await expect(router.run("diff_summary", request)).rejects.toThrow(/budget/);

    day = new Date("2026-09-27T00:01:00Z");
    await expect(router.run("diff_summary", request)).resolves.toBeDefined();
  });

  it("records every run, including failures", async () => {
    const runs: AiRunRecord[] = [];
    const router = createModelRouter(loadAiConfig({ GROQ_API_KEY: "g" }), {
      onRun: (r) => runs.push(r),
      clientFor: (t) => ({
        provider: t.provider,
        model: t.model,
        complete: vi.fn().mockRejectedValue(new Error("boom")),
      }),
    });
    await expect(router.run("diff_summary", request)).rejects.toThrow("boom");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ job: "diff_summary", tier: "fast", provider: "groq", error: "boom" });
  });

  it("moves a job to the fast tier once its smart-tier hourly limit is reached", async () => {
    let clock = new Date("2026-09-27T10:00:00Z");
    const runs: AiRunRecord[] = [];
    const router = createModelRouter(
      loadAiConfig({ GROQ_API_KEY: "g", ANTHROPIC_API_KEY: "a", AI_JOB_LINK_SUGGESTION_PER_HOUR: "2" }),
      { clientFor: (t) => fakeClient(t), now: () => clock, onRun: (r) => runs.push(r) },
    );
    const providers = async (n: number) => {
      const out: string[] = [];
      for (let i = 0; i < n; i++) out.push((await router.run("link_suggestion", request)).provider);
      return out;
    };
    expect(await providers(3)).toEqual(["anthropic", "anthropic", "groq"]);
    expect(runs[2]).toMatchObject({ tier: "smart", error: "hourly limit reached for link_suggestion" });
    // Other jobs on the smart tier are unaffected.
    expect((await router.run("replan", request)).provider).toBe("anthropic");

    clock = new Date("2026-09-27T11:00:01Z");
    expect(await providers(1)).toEqual(["anthropic"]);
  });

  it("counts failed smart-tier calls toward the limit", async () => {
    const router = createModelRouter(
      loadAiConfig({ GROQ_API_KEY: "g", ANTHROPIC_API_KEY: "a", AI_JOB_LINK_SUGGESTION_PER_HOUR: "1" }),
      {
        clientFor: (t) => t.provider === "anthropic"
          ? { provider: t.provider, model: t.model, complete: vi.fn().mockRejectedValue(new Error("foundry down")) }
          : fakeClient(t),
      },
    );
    await expect(router.run("link_suggestion", request)).resolves.toMatchObject({ provider: "groq" });
    await expect(router.run("link_suggestion", request)).resolves.toMatchObject({ provider: "groq" });
  });

  it("reports the limit when a capped job has no other tier", async () => {
    const router = createModelRouter(
      loadAiConfig({ GROQ_API_KEY: "g", AI_JOB_DIFF_SUMMARY_PER_HOUR: "1" }),
      { clientFor: (t) => fakeClient(t) },
    );
    await router.run("diff_summary", request);
    await expect(router.run("diff_summary", request)).rejects.toThrow(/hourly limit/);
  });
});
