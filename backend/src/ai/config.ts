// Which model handles which AI job. Routing is decided by this table, not by a
// model: cheap, well-defined jobs go to the fast tier, open-ended reasoning to
// the smart tier. Everything is overridable through environment variables.

export type ProviderName = "groq" | "openai" | "openrouter" | "anthropic";
export type Tier = "fast" | "smart";
export type AiJob =
  | "link_suggestion"
  | "diff_summary"
  | "pre_merge_review"
  | "replan"
  | "digest"
  | "ask";

export interface TierConfig {
  provider: ProviderName;
  model: string;
  apiKey: string | null;
}

export interface AiConfig {
  tiers: Record<Tier, TierConfig>;
  jobs: Record<AiJob, Tier>;
  // Rough ceiling on tokens spent per process per UTC day. 0 disables the cap.
  dailyTokenBudget: number;
}

const API_KEY_ENV: Record<ProviderName, string> = {
  groq: "GROQ_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

const DEFAULT_TIERS: Record<Tier, { provider: ProviderName; model: string }> = {
  fast: { provider: "groq", model: "llama-3.3-70b-versatile" },
  smart: { provider: "anthropic", model: "claude-sonnet-5" },
};

const DEFAULT_JOBS: Record<AiJob, Tier> = {
  link_suggestion: "fast",
  diff_summary: "fast",
  pre_merge_review: "smart",
  replan: "smart",
  digest: "smart",
  ask: "smart",
};

const PROVIDERS = Object.keys(API_KEY_ENV) as ProviderName[];
const TIERS: Tier[] = ["fast", "smart"];

function parseProvider(value: string | undefined, fallback: ProviderName): ProviderName {
  if (!value) return fallback;
  if (!PROVIDERS.includes(value as ProviderName)) {
    throw new Error(`unknown AI provider "${value}" (expected ${PROVIDERS.join(", ")})`);
  }
  return value as ProviderName;
}

function parseTier(value: string | undefined, fallback: Tier): Tier {
  if (!value) return fallback;
  if (!TIERS.includes(value as Tier)) throw new Error(`unknown AI tier "${value}"`);
  return value as Tier;
}

// Env vars: AI_FAST_PROVIDER, AI_FAST_MODEL, AI_SMART_PROVIDER, AI_SMART_MODEL,
// AI_JOB_<JOB>=fast|smart, AI_DAILY_TOKEN_BUDGET, and one API key per provider.
export function loadAiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  const tiers = {} as Record<Tier, TierConfig>;
  for (const tier of TIERS) {
    const prefix = `AI_${tier.toUpperCase()}`;
    const provider = parseProvider(env[`${prefix}_PROVIDER`], DEFAULT_TIERS[tier].provider);
    const model =
      env[`${prefix}_MODEL`] ||
      (provider === DEFAULT_TIERS[tier].provider ? DEFAULT_TIERS[tier].model : undefined);
    if (!model) throw new Error(`${prefix}_MODEL must be set when ${prefix}_PROVIDER is ${provider}`);
    tiers[tier] = { provider, model, apiKey: env[API_KEY_ENV[provider]] || null };
  }

  const jobs = { ...DEFAULT_JOBS };
  for (const job of Object.keys(DEFAULT_JOBS) as AiJob[]) {
    jobs[job] = parseTier(env[`AI_JOB_${job.toUpperCase()}`], DEFAULT_JOBS[job]);
  }

  const budget = Number(env.AI_DAILY_TOKEN_BUDGET ?? 2_000_000);
  if (!Number.isFinite(budget) || budget < 0) throw new Error("AI_DAILY_TOKEN_BUDGET must be >= 0");

  return { tiers, jobs, dailyTokenBudget: budget };
}
