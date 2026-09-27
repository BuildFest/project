import { describe, expect, it } from "vitest";
import { loadAiConfig } from "../../src/ai/config.js";

describe("loadAiConfig", () => {
  it("defaults to groq for fast jobs and anthropic for smart jobs", () => {
    const config = loadAiConfig({ GROQ_API_KEY: "g", ANTHROPIC_API_KEY: "a" });
    expect(config.tiers.fast).toEqual({ provider: "groq", model: "llama-3.3-70b-versatile", apiKey: "g" });
    expect(config.tiers.smart.provider).toBe("anthropic");
    expect(config.tiers.smart.apiKey).toBe("a");
    expect(config.jobs.diff_summary).toBe("fast");
    expect(config.jobs.link_suggestion).toBe("smart");
    expect(config.jobs.replan).toBe("smart");
  });

  it("caps smart-tier linking per hour by default and lets env change or remove caps", () => {
    expect(loadAiConfig({}).jobHourlyLimits).toEqual({ link_suggestion: 30 });
    expect(loadAiConfig({ AI_JOB_LINK_SUGGESTION_PER_HOUR: "5", AI_JOB_REPLAN_PER_HOUR: "2" }).jobHourlyLimits)
      .toEqual({ link_suggestion: 5, replan: 2 });
    expect(loadAiConfig({ AI_JOB_LINK_SUGGESTION_PER_HOUR: "0" }).jobHourlyLimits).toEqual({});
    expect(() => loadAiConfig({ AI_JOB_LINK_SUGGESTION_PER_HOUR: "-1" })).toThrow(/PER_HOUR/);
    expect(() => loadAiConfig({ AI_JOB_LINK_SUGGESTION_PER_HOUR: "1.5" })).toThrow(/PER_HOUR/);
  });

  it("leaves the key null when it is not configured", () => {
    expect(loadAiConfig({}).tiers.fast.apiKey).toBeNull();
  });

  it("lets env switch providers, models and job tiers", () => {
    const config = loadAiConfig({
      AI_SMART_PROVIDER: "openai",
      AI_SMART_MODEL: "gpt-x",
      OPENAI_API_KEY: "o",
      AI_JOB_DIFF_SUMMARY: "smart",
      AI_DAILY_TOKEN_BUDGET: "500",
    });
    expect(config.tiers.smart).toEqual({ provider: "openai", model: "gpt-x", apiKey: "o" });
    expect(config.jobs.diff_summary).toBe("smart");
    expect(config.dailyTokenBudget).toBe(500);
  });

  it("requires a model when the provider is not the tier default", () => {
    expect(() => loadAiConfig({ AI_FAST_PROVIDER: "openai" })).toThrow(/AI_FAST_MODEL/);
  });

  it("configures a Microsoft Foundry agent", () => {
    const config = loadAiConfig({
      AI_SMART_PROVIDER: "foundry",
      AI_SMART_MODEL: "PitCrewer",
      AZURE_FOUNDRY_AGENT_ENDPOINT: "https://example.services.ai.azure.com/api/projects/project/agents/PitCrewer/endpoint/protocols/openai",
      AZURE_TENANT_ID: "tenant",
      AZURE_CLIENT_ID: "client",
      AZURE_CLIENT_SECRET: "secret",
    });
    expect(config.tiers.smart).toEqual({
      provider: "foundry",
      model: "PitCrewer",
      apiKey: "secret",
      endpoint: "https://example.services.ai.azure.com/api/projects/project/agents/PitCrewer/endpoint/protocols/openai",
      tenantId: "tenant",
      clientId: "client",
    });
  });

  it("requires an endpoint and Entra application IDs for Foundry", () => {
    expect(() => loadAiConfig({
      AI_SMART_PROVIDER: "foundry",
      AI_SMART_MODEL: "PitCrewer",
      AZURE_CLIENT_SECRET: "secret",
    })).toThrow(/AZURE_FOUNDRY_AGENT_ENDPOINT/);
  });

  it("rejects unknown providers and tiers", () => {
    expect(() => loadAiConfig({ AI_FAST_PROVIDER: "mystery" })).toThrow(/unknown AI provider/);
    expect(() => loadAiConfig({ AI_JOB_ASK: "medium" })).toThrow(/unknown AI tier/);
  });
});
