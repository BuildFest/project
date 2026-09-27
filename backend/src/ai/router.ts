import { anthropicClient } from "./anthropic.js";
import { foundryAgentClient } from "./foundryAgent.js";
import type { CompletionRequest, CompletionResult, Fetch, ModelClient } from "./client.js";
import type { AiConfig, AiJob, Tier, TierConfig } from "./config.js";
import { openAiCompatibleClient } from "./openaiCompatible.js";

export interface AiRunRecord {
  job: AiJob;
  tier: Tier;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  cached: boolean;
  error: string | null;
}

export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiUnavailableError";
  }
}

export interface RunOptions {
  // Identical requests with the same key reuse the earlier result.
  cacheKey?: string;
}

export interface ModelRouter {
  // False when the job's tier has no API key. Callers skip AI and fall back to
  // rules; the product must keep working without any model configured.
  available(job: AiJob): boolean;
  run(job: AiJob, request: CompletionRequest, options?: RunOptions): Promise<CompletionResult>;
}

interface RouterDeps {
  fetch?: Fetch;
  now?: () => Date;
  onRun?: (record: AiRunRecord) => void;
  clientFor?: (tier: TierConfig) => ModelClient;
  cacheSize?: number;
}

function defaultClient(tier: TierConfig, fetchImpl: Fetch): ModelClient {
  if (!tier.apiKey) throw new AiUnavailableError(`no API key for ${tier.provider}`);
  if (tier.provider === "foundry") {
    if (!tier.endpoint || !tier.tenantId || !tier.clientId) {
      throw new AiUnavailableError("incomplete Microsoft Foundry configuration");
    }
    return foundryAgentClient(
      tier.model,
      tier.endpoint,
      tier.tenantId,
      tier.clientId,
      tier.apiKey,
      fetchImpl,
      tier.apiVersion,
    );
  }
  return tier.provider === "anthropic"
    ? anthropicClient(tier.model, tier.apiKey, fetchImpl)
    : openAiCompatibleClient(tier.provider, tier.model, tier.apiKey, fetchImpl);
}

export function createModelRouter(config: AiConfig, deps: RouterDeps = {}): ModelRouter {
  const now = deps.now ?? (() => new Date());
  const clientFor = deps.clientFor ?? ((tier: TierConfig) => defaultClient(tier, deps.fetch ?? fetch));
  const cacheSize = deps.cacheSize ?? 500;
  const clients = new Map<Tier, ModelClient>();
  const cache = new Map<string, { result: CompletionResult; tier: Tier }>();
  let budgetDay = "";
  let tokensToday = 0;
  // Start times of recent calls each job sent to its own tier, for jobHourlyLimits.
  const primaryCalls = new Map<AiJob, number[]>();

  function client(tier: Tier): ModelClient {
    let c = clients.get(tier);
    if (!c) {
      c = clientFor(config.tiers[tier]);
      clients.set(tier, c);
    }
    return c;
  }

  function spend(tokens: number) {
    const day = now().toISOString().slice(0, 10);
    if (day !== budgetDay) {
      budgetDay = day;
      tokensToday = 0;
    }
    tokensToday += tokens;
  }

  function overBudget(): boolean {
    spend(0);
    return config.dailyTokenBudget > 0 && tokensToday >= config.dailyTokenBudget;
  }

  function tiersFor(job: AiJob): Tier[] {
    return config.jobs[job] === "smart" ? ["smart", "fast"] : ["fast"];
  }

  function overHourlyLimit(job: AiJob): boolean {
    const limit = config.jobHourlyLimits[job];
    if (!limit) return false;
    const cutoff = now().getTime() - 3_600_000;
    const recent = (primaryCalls.get(job) ?? []).filter((at) => at > cutoff);
    primaryCalls.set(job, recent);
    return recent.length >= limit;
  }

  return {
    available(job) {
      return tiersFor(job).some((tier) => config.tiers[tier].apiKey !== null);
    },

    async run(job, request, options = {}) {
      const primary = config.jobs[job];
      const primaryConfig = config.tiers[primary];
      const cacheKey = options.cacheKey && `${job}:${primaryConfig.provider}:${primaryConfig.model}:${options.cacheKey}`;
      const record = (tier: Tier, fields: Partial<AiRunRecord>) => {
        const { provider, model } = config.tiers[tier];
        deps.onRun?.({
          job, tier, provider, model,
          inputTokens: 0, outputTokens: 0, durationMs: 0, cached: false, error: null,
          ...fields,
        });
      };

      if (cacheKey && cache.has(cacheKey)) {
        const cached = cache.get(cacheKey)!;
        record(cached.tier, { cached: true });
        return cached.result;
      }
      if (!this.available(job)) {
        throw new AiUnavailableError(`no API key for ${primaryConfig.provider} or fast fallback (${job})`);
      }
      if (overBudget()) throw new AiUnavailableError("daily AI token budget exhausted");

      let tiers = tiersFor(job);
      if (overHourlyLimit(job)) {
        record(primary, { error: `hourly limit reached for ${job}` });
        tiers = tiers.filter((tier) => tier !== primary);
        if (tiers.length === 0) throw new AiUnavailableError(`hourly limit reached for ${job}`);
      }

      let lastError: unknown;
      for (const tier of tiers) {
        const tierConfig = config.tiers[tier];
        if (!tierConfig.apiKey) {
          record(tier, { error: `no API key for ${tierConfig.provider}` });
          continue;
        }
        const started = now().getTime();
        if (tier === primary) primaryCalls.set(job, [...(primaryCalls.get(job) ?? []), started]);
        try {
          const result = await client(tier).complete(request);
          spend(result.inputTokens + result.outputTokens);
          record(tier, {
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            durationMs: now().getTime() - started,
          });
          if (cacheKey) {
            if (cache.size >= cacheSize) cache.delete(cache.keys().next().value!);
            cache.set(cacheKey, { result, tier });
          }
          return result;
        } catch (err) {
          lastError = err;
          record(tier, { durationMs: now().getTime() - started, error: (err as Error).message });
        }
      }
      throw lastError ?? new AiUnavailableError(`no model available for ${job}`);
    },
  };
}
