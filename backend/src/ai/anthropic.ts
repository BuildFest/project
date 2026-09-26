import { postJson, type CompletionRequest, type Fetch, type ModelClient } from "./client.js";

interface MessagesResponse {
  content: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

// Anthropic Messages API. It has no JSON response mode, so json requests only
// add an instruction to the system prompt; callers validate the reply anyway.
export function anthropicClient(model: string, apiKey: string, fetchImpl: Fetch = fetch): ModelClient {
  return {
    provider: "anthropic",
    model,
    async complete(request: CompletionRequest) {
      const jsonHint = "Reply with a single JSON object and nothing else.";
      const system = request.json
        ? [request.system, jsonHint].filter(Boolean).join("\n\n")
        : request.system;
      const data = (await postJson(
        fetchImpl,
        "https://api.anthropic.com/v1/messages",
        { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        {
          model,
          max_tokens: request.maxTokens,
          temperature: request.temperature ?? 0,
          ...(system ? { system } : {}),
          messages: request.messages,
        },
      )) as MessagesResponse;
      return {
        text: data.content
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join(""),
        provider: "anthropic",
        model,
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      };
    },
  };
}
