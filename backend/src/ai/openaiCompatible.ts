import { postJson, type CompletionRequest, type Fetch, type ModelClient } from "./client.js";
import type { ProviderName } from "./config.js";

const BASE_URLS: Record<Exclude<ProviderName, "anthropic">, string> = {
  groq: "https://api.groq.com/openai/v1",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

interface ChatCompletionResponse {
  choices: { message: { content: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// One client for every provider that speaks the OpenAI chat completions API.
export function openAiCompatibleClient(
  provider: Exclude<ProviderName, "anthropic">,
  model: string,
  apiKey: string,
  fetchImpl: Fetch = fetch,
): ModelClient {
  const url = `${BASE_URLS[provider]}/chat/completions`;
  return {
    provider,
    model,
    async complete(request: CompletionRequest) {
      const messages = [
        ...(request.system ? [{ role: "system", content: request.system }] : []),
        ...request.messages,
      ];
      const data = (await postJson(
        fetchImpl,
        url,
        { authorization: `Bearer ${apiKey}` },
        {
          model,
          messages,
          max_tokens: request.maxTokens,
          temperature: request.temperature ?? 0,
          ...(request.json ? { response_format: { type: "json_object" } } : {}),
        },
      )) as ChatCompletionResponse;
      return {
        text: data.choices[0]?.message.content ?? "",
        provider,
        model,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      };
    },
  };
}
