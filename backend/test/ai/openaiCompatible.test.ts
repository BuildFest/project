import { describe, expect, it, vi } from "vitest";
import { ModelError } from "../../src/ai/client.js";
import { openAiCompatibleClient } from "../../src/ai/openaiCompatible.js";

function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status });
}

const ok = {
  choices: [{ message: { content: '{"task_id":"task_1"}' } }],
  usage: { prompt_tokens: 120, completion_tokens: 8 },
};

describe("openAiCompatibleClient", () => {
  it("sends a chat completion request and reads usage", async () => {
    const fetchMock = vi.fn(async () => reply(200, ok));
    const client = openAiCompatibleClient("groq", "llama", "key", fetchMock);
    const result = await client.complete({
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 100,
      json: true,
    });

    expect(result).toEqual({
      text: '{"task_id":"task_1"}',
      provider: "groq",
      model: "llama",
      inputTokens: 120,
      outputTokens: 8,
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer key");
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "llama",
      max_tokens: 100,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
    });
  });

  it("retries once on a rate limit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply(429, { error: "slow down" }))
      .mockResolvedValueOnce(reply(200, ok));
    const client = openAiCompatibleClient("openai", "gpt", "key", fetchMock);
    await expect(client.complete({ messages: [], maxTokens: 10 })).resolves.toMatchObject({
      provider: "openai",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry client errors", async () => {
    const fetchMock = vi.fn(async () => reply(401, { error: "bad key" }));
    const client = openAiCompatibleClient("openrouter", "m", "key", fetchMock);
    const error = await client.complete({ messages: [], maxTokens: 10 }).catch((e) => e);
    expect(error).toBeInstanceOf(ModelError);
    expect(error.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
