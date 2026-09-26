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
    expect((await router.run("link_suggestion", request)).provider).toBe("groq");
    expect((await router.run("pre_merge_review", request)).provider).toBe("anthropic");
  });

  it("reports jobs as unavailable when their tier has no key", async () => {
    const router = createModelRouter(loadAiConfig({ GROQ_API_KEY: "g" }), {
      clientFor: (t) => fakeClient(t),
    });
    expect(router.available("link_suggestion")).toBe(true);
    expect(router.available("replan")).toBe(false);
    await expect(router.run("replan", request)).rejects.toBeInstanceOf(AiUnavailableError);
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
    await expect(router.run("link_suggestion", request)).rejects.toThrow("boom");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ job: "link_suggestion", tier: "fast", provider: "groq", error: "boom" });
  });
});
